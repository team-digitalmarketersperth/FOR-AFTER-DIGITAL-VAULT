import { ConflictException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  accessInputsSelect,
  accessState,
  aiMeter,
  type AiMeter,
  type AiUnmetered,
  billingPolicy,
  type BillingPolicy,
  entitledPaidTier,
} from '../billing/billing-access.js';
import { type Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

/** 409: the allowance for this period is used (distinct from the hourly abuse limit, which is 429). */
export const AI_ALLOWANCE_EXHAUSTED = 'AI_ALLOWANCE_EXHAUSTED';
/** 409: this request id was already used by this account (never a second provider call or charge). */
export const AI_REQUEST_DUPLICATE = 'AI_REQUEST_DUPLICATE';
/** 503: a reply came back but its use couldn't be recorded, so it isn't shown; its slot is held until it expires. */
export const AI_USAGE_UNRECORDED = 'AI_USAGE_UNRECORDED';

export const ALLOWANCE_MESSAGE = {
  trial: 'You’ve used the AI companion replies included in your free trial. You can keep writing on your own.',
  month: 'You’ve used this month’s AI companion replies. They reset at the start of next month (UTC). You can keep writing on your own.',
} as const;
export const DUPLICATE_MESSAGE = 'This request was already sent. Send it again to ask for a new reply.';
export const UNRECORDED_MESSAGE = 'The assistant replied, but we couldn’t record it, so it isn’t shown. Please try again in a moment.';

export type AiUsageStatusResponse =
  | {
      metered: true;
      kind: AiMeter['kind'];
      allowance: number;
      used: number;
      /** Requests in progress now, already holding a slot. */
      inProgress: number;
      /** allowance − used − inProgress, never below 0. */
      remaining: number;
      periodEndsAt: string;
      /** The next reset (a paid month's end); null for the trial's one allowance. */
      resetsAt: string | null;
    }
  | { metered: false; reason: AiUnmetered };

/**
 * Updated Plans Step 5: durable AI companion allowances (billing-access aiMeter; values from PLAN_DEFINITIONS).
 *
 * Lifecycle per metered request:
 * - reserve(): one short transaction under the Customer's User row lock counts USED rows plus unexpired RESERVED rows
 *   in the period and inserts a RESERVED row. Unique (userId, requestId) makes a request id single-use per account.
 * - The provider call runs outside any transaction.
 * - settle() → USED only while the reservation is unexpired; release() → RELEASED. Both are conditional, so repeats
 *   change nothing.
 *
 * A reservation lives for the request's hard provider deadline plus a grace period. It counts until then and can
 * only settle before then, so its slot is never reused while the original could still succeed. A crash leaves a
 * RESERVED row that simply stops counting at expiresAt (no sweeper needed). Metadata only: no prompt or reply.
 */
@Injectable()
export class AiUsageService {
  private readonly policy: BillingPolicy;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.policy = billingPolicy((key) => config.get<string>(key));
  }

  private async meterFor(client: Prisma.TransactionClient, userId: string, now: Date) {
    const u = await client.user.findUniqueOrThrow({
      where: { id: userId },
      select: { ...accessInputsSelect, trial: { select: { id: true, startedAt: true, endsAt: true } } },
    });
    const access = accessState({ userCreatedAt: u.createdAt, trial: u.trial, account: u.billingAccount }, this.policy, now);
    return aiMeter({ ...access, paidTier: entitledPaidTier(access, u.billingAccount?.tier) }, u.trial, now);
  }

  private async counts(client: Prisma.TransactionClient, userId: string, period: string, now: Date) {
    const [used, inProgress] = await Promise.all([
      client.aiUsage.count({ where: { userId, period, status: 'USED' } }),
      client.aiUsage.count({ where: { userId, period, status: 'RESERVED', expiresAt: { gt: now } } }),
    ]);
    return { used, inProgress };
  }

  async status(userId: string, now = new Date()): Promise<AiUsageStatusResponse> {
    if (!this.policy.enabled) return { metered: false, reason: 'billing_off' };
    const { meter, unmetered } = await this.meterFor(this.prisma, userId, now);
    if (!meter) return { metered: false, reason: unmetered };
    const { used, inProgress } = await this.counts(this.prisma, userId, meter.period, now);
    return {
      metered: true,
      kind: meter.kind,
      allowance: meter.allowance,
      used,
      inProgress,
      remaining: Math.max(0, meter.allowance - used - inProgress),
      periodEndsAt: meter.periodEndsAt.toISOString(),
      resetsAt: meter.resetsAt?.toISOString() ?? null,
    };
  }

  /**
   * Takes a slot before the provider is called. Returns the reservation id, or null when the account isn't metered.
   * Throws 409 AI_ALLOWANCE_EXHAUSTED (used + in-progress ≥ allowance) or 409 AI_REQUEST_DUPLICATE.
   */
  async reserve(userId: string, requestId: string, lifetimeMs: number, now = new Date()): Promise<string | null> {
    if (!this.policy.enabled) return null;
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId}::uuid FOR UPDATE`;
        const { meter } = await this.meterFor(tx, userId, now);
        if (!meter) return null;
        if (await tx.aiUsage.findUnique({ where: { userId_requestId: { userId, requestId } }, select: { id: true } })) {
          throw duplicateError();
        }
        const { used, inProgress } = await this.counts(tx, userId, meter.period, now);
        if (used + inProgress >= meter.allowance) throw exhaustedError(meter, used);
        const row = await tx.aiUsage.create({
          data: { userId, requestId, period: meter.period, expiresAt: new Date(now.getTime() + lifetimeMs) },
          select: { id: true },
        });
        return row.id;
      });
    } catch (err) {
      // A concurrent duplicate that won the unique index.
      if ((err as { code?: string })?.code === 'P2002') throw duplicateError();
      throw err;
    }
  }

  /**
   * A complete reply was delivered: RESERVED → USED, only while unexpired. A repeat on a USED row is a no-op. Anything
   * else (expired, released, missing, database error) throws 503 AI_USAGE_UNRECORDED and leaves the row as it is.
   */
  async settle(reservationId: string, now = new Date()): Promise<void> {
    try {
      const { count } = await this.prisma.aiUsage.updateMany({
        where: { id: reservationId, status: 'RESERVED', expiresAt: { gt: now } },
        data: { status: 'USED', settledAt: now },
      });
      if (count === 1) return;
      const row = await this.prisma.aiUsage.findUnique({ where: { id: reservationId }, select: { status: true } });
      if (row?.status === 'USED') return;
    } catch {
      // Fall through: the outcome is uncertain, so nothing is released here.
    }
    throw unrecordedError();
  }

  /** No charge (failed, empty, cancelled or truncated): RESERVED → RELEASED. Idempotent; never throws. */
  async release(reservationId: string): Promise<void> {
    await this.prisma.aiUsage
      .updateMany({ where: { id: reservationId, status: 'RESERVED' }, data: { status: 'RELEASED', settledAt: new Date() } })
      .catch(() => undefined);
  }
}

const exhaustedError = (meter: AiMeter, used: number) =>
  new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: AI_ALLOWANCE_EXHAUSTED,
    kind: meter.kind,
    allowance: meter.allowance,
    used,
    resetsAt: meter.resetsAt?.toISOString() ?? null,
    message: ALLOWANCE_MESSAGE[meter.kind],
  });
const duplicateError = () => new ConflictException({ statusCode: 409, error: 'Conflict', code: AI_REQUEST_DUPLICATE, message: DUPLICATE_MESSAGE });
const unrecordedError = () =>
  new ServiceUnavailableException({ statusCode: 503, error: 'Service Unavailable', code: AI_USAGE_UNRECORDED, message: UNRECORDED_MESSAGE });
