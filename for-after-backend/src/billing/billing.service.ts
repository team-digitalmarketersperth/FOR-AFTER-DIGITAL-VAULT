import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Stripe from 'stripe';
import { paginate, writeAuditLog, type AuditActor } from '../audit/audit-log.service.js';
import { AuditActorType, AuditEventType, Prisma, UserRole } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { accessState, accessStateWhere, subscriptionRank, trialEnd, type BillingPolicy } from './billing-access.js';
import type { BillingAdminQueryDto } from './billing.dto.js';
import { StripeGateway } from './stripe-gateway.js';

export const PLANS = ['monthly', 'annual'] as const;
export type Plan = (typeof PLANS)[number];

export const NOT_AVAILABLE = 'Plans and free trials aren’t available yet.';
const isUniqueViolation = (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
const stripeId = (v: unknown) => (typeof v === 'string' ? v : v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string' ? (v as { id: string }).id : null);
type BillingAccount = Prisma.BillingAccountGetPayload<object>;

const billingSelect = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  createdAt: true,
  trial: { select: { startedAt: true, endsAt: true } },
  billingAccount: {
    select: {
      plan: true,
      subscriptionStatus: true,
      cancelAtPeriodEnd: true,
      currentPeriodEnd: true,
      stripeSubscriptionId: true,
      syncedAt: true,
    },
  },
} satisfies Prisma.UserSelect;
type BillingRow = Prisma.UserGetPayload<{ select: typeof billingSelect }>;

const DAY = 24 * 60 * 60 * 1000;
// Sync attempts for one event when another sync commits first; then Stripe's own retry takes over.
const SYNC_ATTEMPTS = 3;
class SyncConflict extends Error {}

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);
  readonly policy: BillingPolicy;
  private readonly prices: Partial<Record<Plan, string>>;
  private readonly appUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeGateway,
    config: ConfigService,
  ) {
    const enabled = config.get<string>('BILLING_ENABLED') === 'true';
    const from = config.get<string>('BILLING_ENFORCE_FROM')?.trim();
    const enforceFrom = from ? new Date(from) : null;
    if (enabled && (!enforceFrom || Number.isNaN(enforceFrom.getTime()))) {
      throw new Error('BILLING_ENFORCE_FROM must be an ISO date when BILLING_ENABLED=true.');
    }
    // Open owner decision (docs/billing.md §7): real charges wait until it is taken. Test mode is unaffected.
    if (enabled && stripe.livemode && config.get<string>('BILLING_AFTER_DEATH_POLICY_APPROVED') !== 'true') {
      throw new Error('Live billing needs the subscription-after-death decision first: see docs/billing.md §7 (BILLING_AFTER_DEATH_POLICY_APPROVED).');
    }
    this.policy = { enabled, enforceFrom };
    this.prices = {
      monthly: config.get<string>('STRIPE_PRICE_MONTHLY')?.trim() || undefined,
      annual: config.get<string>('STRIPE_PRICE_ANNUAL')?.trim() || undefined,
    };
    // Fixed return URLs on the app's own origin; never from the request.
    this.appUrl = (config.get<string>('FRONTEND_URL') ?? '').split(',')[0]!.trim().replace(/\/$/, '');
  }

  private state(row: BillingRow, now: Date) {
    return accessState({ userCreatedAt: row.createdAt, trial: row.trial, account: row.billingAccount }, this.policy, now);
  }

  private async row(userId: string) {
    return this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: billingSelect });
  }

  /** The gate's question; a database error propagates (fail closed, never privileged). */
  async hasAccess(userId: string, now = new Date()) {
    if (!this.policy.enabled) return true;
    return this.state(await this.row(userId), now).hasAccess;
  }

  /** The Customer's own plan page. No Stripe ids, no payment details. */
  async status(userId: string, now = new Date()) {
    const row = await this.row(userId);
    const a = this.state(row, now);
    const acct = row.billingAccount;
    return {
      enabled: this.policy.enabled,
      ...a,
      trial: row.trial && { startedAt: row.trial.startedAt.toISOString(), endsAt: row.trial.endsAt.toISOString() },
      subscription: acct?.subscriptionStatus
        ? {
            plan: acct.plan,
            cancelAtPeriodEnd: acct.cancelAtPeriodEnd,
            currentPeriodEnd: acct.currentPeriodEnd?.toISOString() ?? null,
          }
        : null,
      // Plans that can be bought now: billing on, Stripe configured, a price set.
      plans: this.policy.enabled && this.stripe.configured ? PLANS.filter((p) => this.prices[p]) : [],
      canManageSubscription: !!acct?.stripeSubscriptionId && this.stripe.configured,
    };
  }

  /** "Start free trial": one per account; a retry or a second click returns the same trial. */
  async startTrial(userId: string, actor: AuditActor, now = new Date()) {
    if (!this.policy.enabled) throw new NotFoundException(NOT_AVAILABLE);
    const row = await this.row(userId);
    if (row.trial) return this.status(userId, now);
    if (!this.state(row, now).trialEligible) throw new ConflictException('A free trial isn’t available for this account.');
    try {
      await this.prisma.$transaction(async (tx) => {
        const trial = await tx.customerTrial.create({
          data: { userId, startedAt: now, endsAt: trialEnd(now) },
          select: { id: true },
        });
        await writeAuditLog(tx, {
          eventType: AuditEventType.TRIAL_STARTED,
          actor,
          subjectType: 'User',
          subjectId: userId,
          metadata: { trialId: trial.id },
        });
      });
    } catch (err) {
      // A concurrent click created it first: return that one.
      if (!isUniqueViolation(err)) throw err;
    }
    return this.status(userId, now);
  }

  /** Server-allowlisted plan → configured price; Stripe Checkout hosts the payment. */
  async checkout(userId: string, plan: Plan, now = new Date()) {
    const price = this.prices[plan];
    if (!this.policy.enabled || !this.stripe.configured) throw new ServiceUnavailableException(NOT_AVAILABLE);
    if (!price) throw new BadRequestException('This plan isn’t available.');
    const a = this.state(await this.row(userId), now);
    if (['paid_active', 'cancellation_scheduled', 'payment_issue'].includes(a.state)) {
      throw new ConflictException('You already have a subscription. Manage it from your plan page.');
    }
    const account = await this.ensureCustomer(userId);
    const session = await this.stripe.createCheckout({
      customer: account.stripeCustomerId,
      price,
      userId,
      successUrl: `${this.appUrl}/settings/plan?checkout=success`,
      cancelUrl: `${this.appUrl}/settings/plan?checkout=cancelled`,
      // Same account, plan and hour → the same Checkout session (double clicks, retries).
      idempotencyKey: `checkout-${userId}-${plan}-${Math.floor(now.getTime() / 3_600_000)}`,
    });
    if (!session.url) throw new ServiceUnavailableException(NOT_AVAILABLE);
    this.logger.log(`billing_checkout_created user ${userId} plan ${plan}`);
    return { url: session.url };
  }

  async portal(userId: string) {
    if (!this.policy.enabled || !this.stripe.configured) throw new ServiceUnavailableException(NOT_AVAILABLE);
    const account = await this.prisma.billingAccount.findUnique({ where: { userId } });
    if (!account?.stripeSubscriptionId) throw new NotFoundException('There is no subscription to manage.');
    const session = await this.stripe.createPortal(account.stripeCustomerId, `${this.appUrl}/settings/plan`);
    return { url: session.url };
  }

  // The trusted mapping: our own Stripe customer per account, created here, never from a browser.
  private async ensureCustomer(userId: string) {
    const existing = await this.prisma.billingAccount.findUnique({ where: { userId } });
    if (existing) {
      if (existing.livemode !== this.stripe.livemode) throw new ConflictException('Billing is configured for another environment.');
      return existing;
    }
    const customer = await this.stripe.createCustomer(userId);
    try {
      return await this.prisma.billingAccount.create({
        data: { userId, stripeCustomerId: customer.id, livemode: customer.livemode },
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      return this.prisma.billingAccount.findUniqueOrThrow({ where: { userId } });
    }
  }

  /**
   * A verified webhook. The customer's subscriptions are re-read from Stripe and
   * the best one (subscriptionRank) becomes the account's, so duplicate, late or
   * out-of-order events, and events for a replaced subscription, all converge on
   * Stripe's current state. Then the event id, the new state and its audit row
   * commit together. Anything that fails before that commit is answered non-2xx
   * so Stripe retries.
   */
  async webhook(rawBody: Buffer | undefined, signature: string | undefined) {
    if (!this.stripe.configured) throw new ServiceUnavailableException('Billing webhooks are not configured.');
    let event: Stripe.Event;
    try {
      if (!rawBody || !signature) throw new Error('missing');
      event = this.stripe.constructEvent(rawBody, signature);
    } catch {
      throw new BadRequestException('Invalid signature.');
    }
    if (event.livemode !== this.stripe.livemode) {
      this.logger.warn(`billing_webhook_wrong_mode event ${event.id}`);
      throw new BadRequestException('Event is for another environment.');
    }
    if (await this.prisma.stripeEvent.findUnique({ where: { id: event.id } })) return { received: true, duplicate: true };

    const obj = event.data.object as unknown as Record<string, unknown>;
    const customerId = stripeId(obj.customer);
    const subscriptionId =
      event.type.startsWith('customer.subscription.')
        ? stripeId(obj.id)
        : event.type === 'checkout.session.completed'
          ? stripeId(obj.subscription)
          : event.type.startsWith('invoice.')
            ? stripeId(obj.subscription) ?? stripeId((obj.parent as { subscription_details?: { subscription?: unknown } } | null)?.subscription_details?.subscription)
            : null;
    if (!subscriptionId || !customerId) {
      await this.markProcessed(event);
      return { received: true, ignored: true };
    }
    for (let attempt = 0; attempt < SYNC_ATTEMPTS; attempt++) {
      try {
        // Read before the fetch: syncedAt is the version this sync's Stripe read must still be newer than.
        const account = await this.prisma.billingAccount.findUnique({ where: { stripeCustomerId: customerId } });
        if (!account) {
          // A customer this app never created: nothing to change.
          await this.markProcessed(event);
          return { received: true, ignored: true };
        }
        return await this.sync(event, account, subscriptionId);
      } catch (err) {
        if (isUniqueViolation(err)) return { received: true, duplicate: true }; // a concurrent delivery won
        if (!(err instanceof SyncConflict)) throw err;
      }
    }
    this.logger.warn(`billing_webhook_sync_contended event ${event.id}`);
    throw new ServiceUnavailableException('Billing sync is busy; retry.');
  }

  private async sync(event: Stripe.Event, account: BillingAccount, subscriptionId: string) {
    const listed = await this.stripe.listSubscriptions(account.stripeCustomerId);
    const named = listed.find((s) => s.id === subscriptionId) ?? (await this.stripe.retrieveSubscription(subscriptionId));
    if (stripeId(named.customer) !== account.stripeCustomerId || named.livemode !== account.livemode) {
      this.logger.warn(`billing_webhook_mismatch event ${event.id}`);
      throw new BadRequestException('Subscription does not belong to this customer.');
    }
    const now = new Date();
    const candidates = (listed.includes(named) ? listed : [...listed, named]).filter((s) => s.livemode === account.livemode).map((s) => this.snapshot(s));
    const best = candidates.reduce((a, b) => {
      const rank = subscriptionRank(b, now) - subscriptionRank(a, now);
      const newer = (b.currentPeriodEnd?.getTime() ?? 0) - (a.currentPeriodEnd?.getTime() ?? 0) || b.created - a.created;
      return rank > 0 || (rank === 0 && newer > 0) ? b : a;
    });
    const current = best.id === subscriptionId;
    const unchanged =
      best.id === account.stripeSubscriptionId &&
      best.plan === account.plan &&
      best.status === account.subscriptionStatus &&
      best.cancelAtPeriodEnd === account.cancelAtPeriodEnd &&
      best.currentPeriodEnd?.getTime() === account.currentPeriodEnd?.getTime();
    if (!current && unchanged) {
      // An event about a subscription the account has moved on from: nothing applied, so no sync audit row.
      await this.markProcessed(event);
      this.logger.log(`billing_webhook_superseded event ${event.id} user ${account.userId}`);
      return { received: true, superseded: true };
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.stripeEvent.create({ data: { id: event.id, type: event.type, livemode: event.livemode } });
      // Applies only if no other sync committed since this one's read: a commit in between may hold newer Stripe
      // data than this fetch, whichever finished first, so the loser reads again. Strictly increasing, so a version.
      const { count } = await tx.billingAccount.updateMany({
        where: { id: account.id, syncedAt: account.syncedAt },
        data: {
          stripeSubscriptionId: best.id,
          plan: best.plan,
          subscriptionStatus: best.status,
          cancelAtPeriodEnd: best.cancelAtPeriodEnd,
          currentPeriodEnd: best.currentPeriodEnd,
          syncedAt: new Date(Math.max(now.getTime(), (account.syncedAt?.getTime() ?? 0) + 1)),
        },
      });
      if (!count) throw new SyncConflict(); // rolls back the event id too, so this event is still processed
      await writeAuditLog(tx, {
        eventType: AuditEventType.SUBSCRIPTION_SYNCED,
        actor: { type: AuditActorType.SYSTEM, userId: null },
        subjectType: 'User',
        subjectId: account.userId,
        metadata: {
          stripeEvent: event.type,
          previousStatus: account.subscriptionStatus,
          newStatus: best.status,
          plan: best.plan,
          cancelAtPeriodEnd: best.cancelAtPeriodEnd,
          // false: the event named another subscription; this is the customer's current one, re-read.
          eventSubscriptionCurrent: current,
          subscriptionReplaced: account.stripeSubscriptionId !== null && account.stripeSubscriptionId !== best.id,
        },
      });
    });
    this.logger.log(`billing_subscription_synced user ${account.userId} status ${best.status}`);
    return { received: true };
  }

  private snapshot(sub: Stripe.Subscription) {
    const items = sub.items?.data ?? [];
    const priceIds = items.map((i) => i.price?.id);
    const periodEnds = items.map((i) => i.current_period_end).filter((n): n is number => typeof n === 'number');
    return {
      id: sub.id,
      created: sub.created ?? 0,
      plan: PLANS.find((p) => this.prices[p] && priceIds.includes(this.prices[p])) ?? 'unknown',
      status: sub.status as string,
      cancelAtPeriodEnd: sub.cancel_at_period_end,
      currentPeriodEnd: periodEnds.length ? new Date(Math.max(...periodEnds) * 1000) : null,
    };
  }

  private async markProcessed(event: Stripe.Event) {
    await this.prisma.stripeEvent.create({ data: { id: event.id, type: event.type, livemode: event.livemode } }).catch((err: unknown) => {
      if (!isUniqueViolation(err)) throw err;
    });
  }

  // ─── Admin (SUPER_ADMIN only, see the controller) ──────────────────────────

  private adminItem(r: BillingRow, now: Date) {
    const a = this.state(r, now);
    return {
      accountId: r.id,
      email: r.email,
      firstName: r.firstName,
      lastName: r.lastName,
      accountCreatedAt: r.createdAt.toISOString(),
      state: a.state,
      hasAccess: a.hasAccess,
      trialStartedAt: r.trial?.startedAt.toISOString() ?? null,
      trialEndsAt: r.trial?.endsAt.toISOString() ?? null,
      plan: r.billingAccount?.plan ?? null,
      subscriptionStatus: r.billingAccount?.subscriptionStatus ?? null,
      subscriptionReference: r.billingAccount?.stripeSubscriptionId ?? null,
      cancelAtPeriodEnd: r.billingAccount?.cancelAtPeriodEnd ?? false,
      currentPeriodEnd: r.billingAccount?.currentPeriodEnd?.toISOString() ?? null,
      lastSyncedAt: r.billingAccount?.syncedAt?.toISOString() ?? null,
    };
  }

  async adminList(q: BillingAdminQueryDto, now = new Date()) {
    if (q.from && q.to) {
      const span = new Date(q.to).getTime() - new Date(q.from).getTime();
      if (span < 0) throw new BadRequestException('from must be before to');
      if (span > 366 * DAY) throw new BadRequestException('The time range can be at most 366 days.');
    }
    const where: Prisma.UserWhereInput = {
      AND: [
        { role: UserRole.CUSTOMER, OR: [{ trial: { isNot: null } }, { billingAccount: { isNot: null } }] },
        q.state ? accessStateWhere(q.state, now) : {},
        q.plan ? { billingAccount: { is: { plan: q.plan } } } : {},
        q.accountId ? { id: q.accountId } : {},
        q.subscriptionReference ? { billingAccount: { is: { stripeSubscriptionId: q.subscriptionReference } } } : {},
        q.from || q.to ? { createdAt: { ...(q.from && { gte: new Date(q.from) }), ...(q.to && { lte: new Date(q.to) }) } } : {},
      ],
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (q.page - 1) * q.limit, take: q.limit, select: billingSelect }),
      this.prisma.user.count({ where }),
    ]);
    return {
      evaluatedAt: now.toISOString(),
      enabled: this.policy.enabled,
      enforceFrom: this.policy.enforceFrom?.toISOString() ?? null,
      items: rows.map((r) => this.adminItem(r, now)),
      pagination: paginate(q.page, q.limit, total),
    };
  }

  /** Admin → Users: the same state, for a page of accounts (one query). */
  async summaries(userIds: string[], now = new Date()) {
    if (!userIds.length) return new Map<string, ReturnType<BillingService['adminItem']>>();
    const rows = await this.prisma.user.findMany({ where: { id: { in: userIds }, role: UserRole.CUSTOMER }, select: billingSelect });
    return new Map(rows.map((r) => [r.id, this.adminItem(r, now)]));
  }

  assertSuperAdmin(role: UserRole) {
    if (role !== UserRole.SUPER_ADMIN) throw new ForbiddenException('Billing details are visible to super admins only.');
  }
}
