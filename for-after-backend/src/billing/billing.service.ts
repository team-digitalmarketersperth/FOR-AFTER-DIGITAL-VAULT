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
import { AuditActorType, AuditEventType, type PaidTier, Prisma, UserRole } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  ACCESS_STATES,
  accessState,
  accessStateSql,
  accessStateWhere,
  answeredQuestions,
  billingListedWhere,
  billingPolicy,
  creationCaps,
  recipientLimit,
  featureAccess,
  allowedMediaKinds,
  entitledPaidTier,
  PLAN_DEFINITIONS,
  PLAN_IN_EFFECT,
  type PlanDefinition,
  planTier,
  subscriptionRank,
  trialEnd,
  type AccessState,
  type BillingPolicy,
} from './billing-access.js';
import type { BillingAdminQueryDto } from './billing.dto.js';
import { StripeGateway } from './stripe-gateway.js';
import { PriceCatalog, priceProblem, type SubscriptionPrice } from './stripe-prices.js';
import { MAX_TRUSTED_CONTACTS } from '../trusted-contacts/trusted-contacts.service.js';

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
      tier: true,
      priceUnresolved: true,
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
  private readonly prices: PriceCatalog;
  private readonly appUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeGateway,
    config: ConfigService,
  ) {
    const { enabled, enforceFrom } = billingPolicy((key) => config.get<string>(key));
    // Open owner decision (docs/billing.md §7): real charges wait until it is taken. Test mode is unaffected.
    if (enabled && stripe.livemode && config.get<string>('BILLING_AFTER_DEATH_POLICY_APPROVED') !== 'true') {
      throw new Error('Live billing needs the subscription-after-death decision first: see docs/billing.md §7 (BILLING_AFTER_DEATH_POLICY_APPROVED).');
    }
    this.policy = { enabled, enforceFrom };
    // Updated Plans Step 6: explicit tier/interval price settings, validated here (a duplicate id fails start-up).
    this.prices = PriceCatalog.fromConfig((key) => config.get<string>(key));
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
    return (await this.writeAccess(userId, now)).hasAccess;
  }

  /** hasAccess plus the state it came from (Step 6: the 402's reason code). Server time; billing off reads nothing. */
  async writeAccess(userId: string, now = new Date()): Promise<{ hasAccess: boolean; state: AccessState }> {
    if (!this.policy.enabled) return { hasAccess: true, state: 'no_billing_record' };
    const { hasAccess, state } = this.state(await this.row(userId), now);
    return { hasAccess, state };
  }

  /** The Customer's own plan page. No Stripe ids, no payment details. */
  async status(userId: string, now = new Date()) {
    const row = await this.row(userId);
    const a = this.state(row, now);
    const acct = row.billingAccount;
    return {
      enabled: this.policy.enabled,
      ...a,
      // Trial Step 3: the caps the create routes enforce (null = no trial cap); the app counts with the live lists.
      trialCaps: creationCaps(a),
      // Trial Step 5: question slots in use (My Story + My Wishes with written words), the count the saves enforce.
      questionsAnswered: await answeredQuestions(this.prisma, userId),
      // Trial Step 7: live Memory Vault memories, the count the create enforces against trialCaps.memories.
      memoriesSaved: await this.prisma.memoryVaultItem.count({ where: { ownerUserId: userId, deletedAt: null } }),
      // Updated Plans Step 7 (additive): live counts and the limits the create routes enforce, resolved here so the app
      // never derives them. recipients.limit null = no count limit (unmapped paid, exempt, billing off: not "unlimited").
      people: await this.people(userId, a, acct?.tier ?? null),
      // Trial Step 4: paid-only features the API enforces (media: false only in an enforced active trial).
      // Updated Plans Step 4 (additive): the kinds of new content media allowed now (by the entitled mapped tier).
      features: { ...featureAccess(a), mediaKinds: allowedMediaKinds({ ...a, paidTier: entitledPaidTier(a, acct?.tier) }) },
      // Updated Plans Step 2 (additive): tier, interval and exemption, the tier's approved definition, and which parts
      // of it the server applies today (`inEffect`); the rest is declared only (`notYetEnforced`).
      productTier: this.productTier(a, acct),
      // Step 7 (additive): the approved plan matrix itself, so the plan page's comparison never copies the numbers.
      planDefinitions: PLAN_DEFINITIONS,
      trial: row.trial && { startedAt: row.trial.startedAt.toISOString(), endsAt: row.trial.endsAt.toISOString() },
      subscription: acct?.subscriptionStatus
        ? {
            plan: acct.plan,
            cancelAtPeriodEnd: acct.cancelAtPeriodEnd,
            currentPeriodEnd: acct.currentPeriodEnd?.toISOString() ?? null,
            // Step 6 (additive): how the subscription's price resolved. "unmapped" = an existing or legacy subscription
            // with no tier (its access is preserved); "unresolved" = a price no configured plan matches.
            mapping: acct.priceUnresolved ? 'unresolved' : acct.tier ? 'mapped' : 'unmapped',
          }
        : null,
      // Step 6: tier + interval pairs that can be bought now (billing on, Stripe configured, that price set). From
      // configuration only: no Stripe call on a read. `plans` (kept for existing consumers) = their intervals.
      checkoutOptions: this.offered(),
      plans: PLANS.filter((p) => this.offered().some((o) => o.interval === p)),
      canManageSubscription: !!acct?.stripeSubscriptionId && this.stripe.configured,
    };
  }

  private async people(userId: string, a: ReturnType<BillingService['state']>, tier: PaidTier | null) {
    const [recipients, contacts] = await Promise.all([
      this.prisma.recipient.count({ where: { ownerUserId: userId, deletedAt: null } }),
      this.prisma.trustedContact.count({ where: { ownerUserId: userId, deletedAt: null } }),
    ]);
    const r = recipientLimit({ ...a, paidTier: entitledPaidTier(a, tier) });
    const trialContacts = creationCaps(a).trustedContacts;
    return {
      recipients: { used: recipients, limit: r?.max ?? null, limitSource: r?.source ?? null },
      // Every account has the two-contact maximum (no plan raises it); an enforced active trial has one.
      trustedContacts: {
        used: contacts,
        limit: trialContacts ?? MAX_TRUSTED_CONTACTS,
        limitSource: trialContacts !== null ? ('trial' as const) : ('maximum' as const),
      },
    };
  }

  private productTier(a: ReturnType<BillingService['state']>, acct: { plan: string | null; tier: PaidTier | null } | null) {
    const t = planTier(a, this.policy, acct);
    const definition = t.tier ? PLAN_DEFINITIONS[t.tier] : null;
    const inEffect = t.tier ? PLAN_IN_EFFECT[t.tier] : [];
    return {
      ...t,
      definition,
      inEffect,
      notYetEnforced: definition ? (Object.keys(definition) as (keyof PlanDefinition)[]).filter((k) => !inEffect.includes(k)) : [],
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

  private offered() {
    return this.policy.enabled && this.stripe.configured ? this.prices.options : [];
  }

  /**
   * Server-allowlisted tier + interval → its configured price (never a client price id); Stripe Checkout hosts the
   * payment. The price is checked with Stripe first (active, recurring, that interval, this mode).
   */
  async checkout(userId: string, tier: PaidTier, interval: Plan, now = new Date()) {
    if (!this.policy.enabled || !this.stripe.configured) throw new ServiceUnavailableException(NOT_AVAILABLE);
    const price = this.prices.priceFor(tier, interval);
    if (!price) throw new BadRequestException('This plan isn’t available.');
    const a = this.state(await this.row(userId), now);
    // Step 8: payment_pending too. A first payment still being confirmed is a subscription; a second Checkout could be
    // paid as well (double charge). The Customer finishes or fixes it through Manage billing, or it expires.
    if (['paid_active', 'cancellation_scheduled', 'payment_issue', 'payment_pending', 'plan_unresolved'].includes(a.state)) {
      throw new ConflictException('You already have a subscription. Manage it from your plan page.');
    }
    const problem = priceProblem(await this.stripe.retrievePrice(price), interval, this.stripe.livemode);
    if (problem) {
      // A configuration fault: the reason is for operators; the Customer is told the plan is unavailable.
      this.logger.error(`billing_price_rejected tier ${tier} interval ${interval} reason ${problem}`);
      throw new ServiceUnavailableException('This plan isn’t available right now.');
    }
    const account = await this.ensureCustomer(userId);
    const session = await this.stripe.createCheckout({
      customer: account.stripeCustomerId,
      price,
      userId,
      successUrl: `${this.appUrl}/settings/plan?checkout=success`,
      cancelUrl: `${this.appUrl}/settings/plan?checkout=cancelled`,
      // Same account, tier, interval and hour → the same Checkout session (double clicks, retries).
      idempotencyKey: `checkout-${userId}-${tier}-${interval}-${Math.floor(now.getTime() / 3_600_000)}`,
    });
    if (!session.url) throw new ServiceUnavailableException(NOT_AVAILABLE);
    this.logger.log(`billing_checkout_created user ${userId} tier ${tier} interval ${interval}`);
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
    const mapped = this.mapping(best.price, best.id, account);
    if (best.price.kind === 'unknown' || best.price.kind === 'ambiguous') {
      // A safe diagnostic: references and the reason only (price ids are configuration, not secrets or content).
      this.logger.warn(
        `billing_price_${mapped.unresolved ? 'unresolved' : 'unmapped_kept'} event ${event.id} user ${account.userId} reason ${best.price.reason} prices ${best.price.priceIds.join(',') || 'none'}`,
      );
    }
    const unchanged =
      best.id === account.stripeSubscriptionId &&
      mapped.plan === account.plan &&
      mapped.tier === account.tier &&
      mapped.unresolved === account.priceUnresolved &&
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
          plan: mapped.plan,
          tier: mapped.tier,
          priceUnresolved: mapped.unresolved,
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
          plan: mapped.plan,
          // Step 6: the tier from the configured price mapping, and how the price resolved.
          tier: mapped.tier,
          priceMapping: best.price.kind,
          priceUnresolved: mapped.unresolved,
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

  /**
   * Step 6: what a subscription's resolved price means for the stored row.
   * - Mapped: its tier and interval.
   * - Legacy price: its interval, no tier (the existing unmapped behaviour).
   * - Unknown or ambiguous, on the unmapped subscription the account already holds: unchanged treatment (existing
   *   unmapped subscriptions keep access; no tier is invented).
   * - Unknown or ambiguous otherwise (a new subscription, or one that was mapped): unresolved. No paid access and no
   *   tier in force; the stored tier is kept as it was, never overwritten with a default.
   */
  private mapping(price: SubscriptionPrice, subscriptionId: string, account: BillingAccount) {
    if (price.kind === 'mapped') return { plan: price.interval, tier: price.tier, unresolved: false };
    if (price.kind === 'legacy') return { plan: price.interval, tier: null, unresolved: false };
    const heldUnmapped = subscriptionId === account.stripeSubscriptionId && account.tier === null && !account.priceUnresolved;
    return { plan: 'unknown', tier: account.tier, unresolved: !heldUnmapped };
  }

  private snapshot(sub: Stripe.Subscription) {
    const items = sub.items?.data ?? [];
    const periodEnds = items.map((i) => i.current_period_end).filter((n): n is number => typeof n === 'number');
    return {
      id: sub.id,
      created: sub.created ?? 0,
      price: this.prices.resolve(items),
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
      // Step 6 (additive): the stored tier and whether the price is unresolved (shown, never guessed).
      tier: r.billingAccount?.tier ?? null,
      priceUnresolved: r.billingAccount?.priceUnresolved ?? false,
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
    // Every filter but the access state: the summary counts this population; the page also applies `state`.
    const scope: Prisma.UserWhereInput = {
      AND: [
        billingListedWhere,
        q.plan ? { billingAccount: { is: { plan: q.plan } } } : {},
        q.accountId ? { id: q.accountId } : {},
        q.subscriptionReference ? { billingAccount: { is: { stripeSubscriptionId: q.subscriptionReference } } } : {},
        q.from || q.to ? { createdAt: { ...(q.from && { gte: new Date(q.from) }), ...(q.to && { lte: new Date(q.to) }) } } : {},
      ],
    };
    const where: Prisma.UserWhereInput = q.state ? { AND: [scope, accessStateWhere(q.state, now)] } : scope;
    // The same scope in SQL, every state counted in one scan (one row per account: trial and billing account are
    // unique per user). The page and its total keep the Prisma predicates above.
    const ts = (d: string) => Prisma.sql`${new Date(d).toISOString()}::timestamp`;
    const filters = [
      q.plan && Prisma.sql`b.plan = ${q.plan}`,
      q.accountId && Prisma.sql`u.id = ${q.accountId}::uuid`,
      q.subscriptionReference && Prisma.sql`b."stripeSubscriptionId" = ${q.subscriptionReference}`,
      q.from && Prisma.sql`u."createdAt" >= ${ts(q.from)}`,
      q.to && Prisma.sql`u."createdAt" <= ${ts(q.to)}`,
    ].filter((f): f is Prisma.Sql => !!f);
    const summarySql = Prisma.sql`
      SELECT state, count(*)::int AS n, count(*) FILTER (WHERE synced)::int AS verified
      FROM (
        SELECT ${accessStateSql(this.policy, now)} AS state, b."syncedAt" IS NOT NULL AS synced
        FROM "User" u
        LEFT JOIN "CustomerTrial" t ON t."userId" = u.id
        LEFT JOIN "BillingAccount" b ON b."userId" = u.id
        WHERE u.role = 'CUSTOMER' AND (t.id IS NOT NULL OR b.id IS NOT NULL)
          ${filters.length ? Prisma.sql`AND ${Prisma.join(filters, ' AND ')}` : Prisma.empty}
      ) s
      GROUP BY state`;
    const [rows, total, grouped] = await this.prisma.$transaction(
      [
        this.prisma.user.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (q.page - 1) * q.limit, take: q.limit, select: billingSelect }),
        this.prisma.user.count({ where }),
        this.prisma.$queryRaw<{ state: AccessState; n: number; verified: number }[]>(summarySql),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    const states = Object.fromEntries(ACCESS_STATES.map((st) => [st, 0])) as Record<AccessState, number>;
    let records = 0;
    let verified = 0;
    for (const g of grouped) {
      states[g.state] = g.n;
      records += g.n;
      verified += g.verified;
    }
    return {
      evaluatedAt: now.toISOString(),
      enabled: this.policy.enabled,
      enforceFrom: this.policy.enforceFrom?.toISOString() ?? null,
      // Accounts in scope (each once, in exactly one state: the states add up to `accounts`); `verified` = accounts
      // with a stored Stripe verification time (syncedAt).
      summary: { accounts: records, verified, states },
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
