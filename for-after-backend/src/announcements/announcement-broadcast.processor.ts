import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Worker } from 'bullmq';
import { isUUID } from 'class-validator';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { writeAuditLog } from '../audit/audit-log.service.js';
import { emailHash, signUnsubscribe, suppress } from '../communications/communications.service.js';
import { OPEN_STATUSES } from '../death-verification/death-verification-workflow.service.js';
import { EmailProvider, EmailSendError, emailSettings } from '../email/email-provider.js';
import {
  type AnnouncementRecipientStatus,
  type AnnouncementRunStatus,
  AuditActorType,
  AuditEventType,
  Prisma,
  type UserRole,
  type UserStatus,
} from '../generated/prisma/client.js';
import { withTimeout } from '../message-release/message-release-queue.service.js';
import { errorCode, PrismaService } from '../prisma/prisma.service.js';
import { AnnouncementPolicy, reasonSql } from './announcement-audience.service.js';
import { unsubscribePlaceholder } from './announcement-broadcast.service.js';
import { ACTIVE_RUN, AnnouncementBroadcastQueue, type BroadcastJobData } from './announcement-broadcast-queue.service.js';
import { NOT_ACCEPTED_RETRYABLE } from './announcement-test.processor.js';

// Longer than any one provider call (EMAIL_SEND_TIMEOUT_MS, 10 s by default); renewed before each claim.
export const LEASE_MS = 2 * 60_000;
// One job drives a run for at most this long, then hands over to a fresh job.
const SLICE_MS = 45_000;
const SWEEP_BATCH = 1000;
// Provider attempts per recipient, counting only provably-not-accepted failures.
export const MAX_ATTEMPTS = 3;
const DAILY_LIMIT_PAUSE_MS = 15 * 60_000;
const EMAIL_SHAPE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// sha256 of the lower-cased address (shared with suppressions); re-exported for existing callers.
export { emailHash };
// A permanent provider failure that means the address itself does not exist: suppress it (hard bounce).
const HARD_BOUNCE = /InvalidRecipient/i;

type Account = {
  role: UserRole;
  status: UserStatus;
  deletedAt: Date | null;
  email: string;
  emailVerifiedAt: Date | null;
  marketingConsentAt: Date | null;
} | null;

/**
 * The send-time recheck: the same rules and order as the audience review
 * (reasonSql), plus the address check. Returns a safe skip reason, or null to
 * send. The current verified address must be the one prepared for the run: a
 * changed address is skipped, never redirected to an unreviewed destination.
 */
export function skipReason(user: Account, preparedHash: string, flags: { openDeathReport: boolean; suppressed: boolean }): string | null {
  if (!user || user.role !== 'CUSTOMER' || user.deletedAt || user.status !== 'ACTIVE') return 'account_unavailable';
  if (!EMAIL_SHAPE.test(user.email)) return 'email_invalid';
  if (!user.emailVerifiedAt) return 'email_not_verified';
  if (emailHash(user.email) !== preparedHash) return 'email_changed';
  if (flags.openDeathReport) return 'open_death_report';
  if (flags.suppressed) return 'suppressed';
  if (!user.marketingConsentAt) return 'no_consent';
  return null;
}

type Claimed = { id: string; userId: string; emailHash: string; attemptCount: number };

/**
 * Step 4 worker for `announcement-broadcast` (worker process only). A job
 * drives one run for a slice under a lease on the run row, so at most one
 * driver acts on a run and, with one active run at a time, on all broadcasts:
 * the configured rate is global. Each slice: honour cancel, the gate and the
 * policy; prepare the audience in keyset batches; then claim one recipient at
 * a time, recheck it, send outside any transaction, record the outcome.
 * A recipient found PROCESSING by a new lease holder may have been accepted
 * already: it becomes UNKNOWN and is never resent automatically.
 */
@Injectable()
export class AnnouncementBroadcastProcessor implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(AnnouncementBroadcastProcessor.name);
  private worker?: Worker<BroadcastJobData>;
  private timer?: NodeJS.Timeout;
  private reconciling?: Promise<unknown>;
  private stopping = false;
  /** Customers scanned per preparation transaction (smaller in tests to exercise resume). */
  prepareBatchSize = 500;
  private wake?: () => void;

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: AnnouncementBroadcastQueue,
    private readonly email: EmailProvider,
    private readonly policy: AnnouncementPolicy,
    config: ConfigService,
  ) {
    this.appBaseUrl = emailSettings(config).appBaseUrl;
    this.secret = config.get<string>('SESSION_SECRET') ?? '';
  }

  private readonly appBaseUrl: string;
  private readonly secret: string;

  private get settings() {
    return this.queue.settings;
  }

  async onModuleInit(): Promise<void> {
    const { queueName, connection } = this.settings;
    this.worker = new Worker<BroadcastJobData>(queueName, (job) => this.drive(job.data?.runId), { connection, concurrency: 1 });
    this.worker.on('error', (err) => this.logger.error(`Announcement broadcast worker error (code: ${errorCode(err)})`));
    await withTimeout(this.worker.waitUntilReady());
    this.logger.log('announcement-broadcast worker ready');
  }

  onApplicationBootstrap(): void {
    const tick = () => void (this.reconciling = this.reconcile());
    tick();
    this.timer = setInterval(tick, this.settings.reconcileIntervalMs);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    // Graceful: the current slice stops after its in-flight send is recorded; the lease lapses, the reconciler resumes.
    this.stopping = true;
    this.wake?.();
    clearInterval(this.timer);
    await this.worker?.close();
    await this.reconciling;
  }

  async reconcile(now = new Date()): Promise<void> {
    try {
      const queued = await this.queue.enqueueIdle(now);
      if (queued) this.logger.log(`announcement_broadcast_reconciled runs ${queued}`);
    } catch (err) {
      this.logger.error(`announcement_broadcast_reconcile_error (code: ${errorCode(err)})`);
    }
  }

  /** Overridable in tests; interrupted by shutdown. */
  protected pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      this.wake = () => (clearTimeout(t), resolve());
    });
  }

  /**
   * One slice of a run. 'busy': another driver holds the lease (or the run is
   * not active); 'finished': the run reached a final state; 'continue': a
   * follow-up job is queued; 'lost': the lease was taken over mid-slice.
   */
  async drive(runId: unknown): Promise<'busy' | 'finished' | 'continue' | 'lost'> {
    if (typeof runId !== 'string' || !isUUID(runId)) return 'busy';
    const owner = randomUUID();
    const now = new Date();
    const { count } = await this.prisma.announcementSendRun.updateMany({
      where: { id: runId, status: { in: ACTIVE_RUN }, OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }] },
      data: { leaseOwner: owner, leaseUntil: new Date(now.getTime() + LEASE_MS) },
    });
    if (!count) return 'busy';
    // After an unexpected error: hold off briefly, then the reconciler resumes.
    let resumeAt: Date | null | undefined = new Date(Date.now() + 30_000);
    try {
      // We hold the only lease, so anything still PROCESSING was claimed by a driver that died mid-send.
      const orphans = await this.prisma.announcementRunRecipient.updateMany({
        where: { runId, status: 'PROCESSING' },
        data: { status: 'UNKNOWN', reasonCode: 'worker_interrupted', finishedAt: new Date() },
      });
      if (orphans.count) this.logger.warn(`announcement_broadcast_interrupted run ${runId} unknown ${orphans.count}`);
      resumeAt = await this.slice(runId, owner);
    } finally {
      if (resumeAt !== undefined) {
        // null: finished; a date: paused until then (Retry-After, daily limit, next slice).
        await this.prisma.announcementSendRun
          .updateMany({ where: { id: runId, leaseOwner: owner }, data: { leaseOwner: null, leaseUntil: resumeAt } })
          .catch((err: unknown) => this.logger.error(`announcement_broadcast_release_failed run ${runId} (code: ${errorCode(err)})`));
      }
    }
    if (resumeAt === undefined) return 'lost';
    if (resumeAt === null) return 'finished';
    await this.queue.enqueue(runId, resumeAt);
    return 'continue';
  }

  /** Returns when to resume (a date), null when the run is final, undefined when the lease was lost. */
  private async slice(runId: string, owner: string): Promise<Date | null | undefined> {
    const end = Date.now() + SLICE_MS;
    while (!this.stopping && Date.now() < end) {
      const renewed = await this.prisma.announcementSendRun.updateMany({
        where: { id: runId, leaseOwner: owner },
        data: { leaseUntil: new Date(Date.now() + LEASE_MS) },
      });
      if (!renewed.count) return undefined;
      const run = await this.prisma.announcementSendRun.findUniqueOrThrow({
        where: { id: runId },
        select: { id: true, status: true, cancelRequestedAt: true, policyVersion: true, audience: true },
      });
      if (!ACTIVE_RUN.includes(run.status)) return null;
      if (run.cancelRequestedAt) {
        if (await this.sweep(runId, 'CANCELLED', null)) continue;
        if (await this.finish(runId, 'CANCELLED', null)) return null;
        continue;
      }
      const blocked = this.blockedReason(run);
      if (blocked) {
        if (await this.sweep(runId, 'SKIPPED', blocked)) continue;
        if (await this.finish(runId, 'BLOCKED', blocked)) return null;
        continue;
      }
      if (run.status === 'PREPARING') {
        await this.prepareBatch(runId);
        continue;
      }
      const since = new Date(Date.now() - 24 * 3600_000);
      if ((await this.prisma.announcementRunRecipient.count({ where: { attemptedAt: { gte: since } } })) >= this.settings.dailyLimit) {
        this.logger.warn(`announcement_broadcast_daily_limit run ${runId} limit ${this.settings.dailyLimit}`);
        return new Date(Date.now() + DAILY_LIMIT_PAUSE_MS);
      }
      const claimed = await this.claim(runId);
      if (!claimed) {
        // Only recipients waiting out a throttling backoff left: come back then.
        const waiting = await this.prisma.announcementRunRecipient.findFirst({
          where: { runId, status: 'QUEUED' },
          orderBy: { nextAttemptAt: 'asc' },
          select: { nextAttemptAt: true },
        });
        if (waiting) return waiting.nextAttemptAt ?? new Date();
        if (await this.finish(runId, 'COMPLETED', null)) return null;
        continue;
      }
      const { called, pauseUntil } = await this.attempt(runId, claimed);
      if (pauseUntil) return pauseUntil;
      if (called) await this.pause(Math.ceil(60_000 / this.settings.ratePerMinute));
    }
    return new Date();
  }

  private blockedReason(run: { policyVersion: string; audience: 'PILOT' | 'ALL_ELIGIBLE' }): string | null {
    const mode = this.settings.mode();
    // "pilot" lets only pilot runs send; an all-eligible run under it is stopped like "off".
    if (mode === 'off' || (mode === 'pilot' && run.audience !== 'PILOT')) return 'broadcast_disabled';
    if (this.policy.blockers.length || this.policy.version !== run.policyVersion) return 'policy_blocked';
    return null;
  }

  /**
   * One keyset batch of the audience: Customers created at or before the run's
   * boundary, after the stored cursor, ordered by id. Eligible ones get a
   * QUEUED row (unique per run + user and run + address); the cursor moves in
   * the same transaction, so an interrupted preparation resumes exactly.
   */
  private async prepareBatch(runId: string): Promise<void> {
    // Session time zone is not UTC: timestamps go in as UTC text, never a JS Date.
    const nowIso = new Date().toISOString();
    await this.prisma.$transaction(async (tx) => {
      const [batch] = await tx.$queryRaw<{ last: string | null }[]>`
        WITH batch AS (
          SELECT u.id, u.email, u.status, u."deletedAt", u."emailVerifiedAt", u."marketingConsentAt"
          FROM "User" u, "AnnouncementSendRun" r
          WHERE r.id = ${runId}::uuid
            AND u.role = 'CUSTOMER'
            AND u."createdAt" <= r."audienceBoundaryAt"
            AND u.id > COALESCE(r."prepareCursor", '00000000-0000-0000-0000-000000000000'::uuid)
          ORDER BY u.id
          LIMIT ${this.prepareBatchSize}
          -- An account deleted mid-batch is skipped (or waits), never an FK error; ordinary updates are not blocked.
          FOR KEY SHARE OF u
        ), ins AS (
          INSERT INTO "AnnouncementRunRecipient" (id, "runId", "userId", "emailHash", "createdAt", "updatedAt")
          SELECT gen_random_uuid(), ${runId}::uuid, b.id, encode(sha256(convert_to(lower(b.email), 'UTF8')), 'hex'),
                 ${nowIso}::timestamp, ${nowIso}::timestamp
          FROM batch b
          -- Every rule of the audience review: account, address, death report, suppression, consent.
          WHERE ${reasonSql(Prisma.raw('b'))} = 'pass'
          ON CONFLICT DO NOTHING
          RETURNING 1
        )
        SELECT (SELECT id::text FROM batch ORDER BY id DESC LIMIT 1) AS last, (SELECT count(*) FROM ins)::int AS inserted`;
      if (batch.last) {
        await tx.announcementSendRun.update({ where: { id: runId }, data: { prepareCursor: batch.last } });
        return;
      }
      const run = await tx.announcementSendRun.update({
        where: { id: runId },
        data: { status: 'SENDING', preparedAt: new Date() },
        select: { announcementId: true, announcementVersion: true, reviewedCount: true },
      });
      const prepared = await tx.announcementRunRecipient.count({ where: { runId } });
      await writeAuditLog(tx, {
        eventType: AuditEventType.ANNOUNCEMENT_BROADCAST_QUEUED,
        actor: { type: AuditActorType.SYSTEM, userId: null },
        subjectType: 'AnnouncementSendRun',
        subjectId: runId,
        metadata: { announcementId: run.announcementId, version: run.announcementVersion, prepared, reviewed: run.reviewedCount },
      });
      this.logger.log(`announcement_broadcast_prepared run ${runId} recipients ${prepared}`);
    });
  }

  private async claim(runId: string): Promise<Claimed | null> {
    // Only the lease holder changes QUEUED rows; a row can still vanish (an account hard-deleted
    // mid-run cascades to its recipient row): skip it and take the next one.
    for (;;) {
      const now = new Date();
      const next = await this.prisma.announcementRunRecipient.findFirst({
        where: { runId, status: 'QUEUED', OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
        orderBy: { id: 'asc' },
        select: { id: true },
      });
      if (!next) return null;
      const { count } = await this.prisma.announcementRunRecipient.updateMany({
        where: { id: next.id, status: 'QUEUED' },
        data: { status: 'PROCESSING', attemptCount: { increment: 1 }, attemptedAt: now },
      });
      const claimed =
        count &&
        (await this.prisma.announcementRunRecipient.findUnique({
          where: { id: next.id },
          select: { id: true, userId: true, emailHash: true, attemptCount: true },
        }));
      if (claimed) return claimed;
    }
  }

  /** Back to QUEUED, attempt not counted: used only when the provider was NOT called. */
  private unclaim(id: string) {
    return this.prisma.announcementRunRecipient.updateMany({
      where: { id, status: 'PROCESSING' },
      data: { status: 'QUEUED', attemptCount: { decrement: 1 }, attemptedAt: null },
    });
  }

  /** Recheck and load the snapshot; null = not sent now (skipped, or unclaimed for a stop / closed gate). */
  private async beforeSend(runId: string, rec: Claimed) {
    const user = await this.prisma.user.findUnique({
      where: { id: rec.userId },
      select: { role: true, status: true, deletedAt: true, email: true, emailVerifiedAt: true, marketingConsentAt: true },
    });
    const [openReports, suppressions] = await Promise.all([
      this.prisma.deathVerificationCase.count({ where: { ownerUserId: rec.userId, status: { in: OPEN_STATUSES } } }),
      this.prisma.emailSuppression.count({ where: { emailHash: rec.emailHash } }),
    ]);
    const skip = skipReason(user, rec.emailHash, { openDeathReport: openReports > 0, suppressed: suppressions > 0 });
    if (skip) {
      await this.settle(rec.id, 'SKIPPED', skip);
      return null;
    }
    // Last look right before the provider: a stop or a closed gate requested meanwhile wins.
    const run = await this.prisma.announcementSendRun.findUniqueOrThrow({
      where: { id: runId },
      select: { subject: true, html: true, text: true, cancelRequestedAt: true, policyVersion: true, audience: true },
    });
    if (run.cancelRequestedAt || this.blockedReason(run)) {
      await this.unclaim(rec.id); // the next loop sweeps it
      return null;
    }
    // This recipient's own unsubscribe link (account + the address this email goes to).
    const placeholder = unsubscribePlaceholder(runId);
    const link = `${this.appBaseUrl}/unsubscribe?token=${signUnsubscribe(rec.userId, rec.emailHash, this.secret)}`;
    return { to: user!.email, subject: run.subject, html: run.html.replaceAll(placeholder, link), text: run.text.replaceAll(placeholder, link) };
  }

  private async attempt(runId: string, rec: Claimed): Promise<{ called: boolean; pauseUntil?: Date }> {
    let message: Awaited<ReturnType<typeof this.beforeSend>>;
    try {
      message = await this.beforeSend(runId, rec);
    } catch (err) {
      // Failed before the provider was called (e.g. database blip): not an attempt, so it can be retried safely.
      // Best effort: if the database is still down, the next lease holder marks it UNKNOWN (conservative).
      await this.unclaim(rec.id).catch(() => undefined);
      throw err;
    }
    if (!message) return { called: false };
    let providerMessageId: string | null | undefined;
    try {
      ({ providerMessageId } = await this.email.send({ kind: 'announcement', ...message, idempotencyKey: `announcement/${rec.id}` }));
    } catch (err) {
      return { called: true, pauseUntil: await this.recordFailure(rec, err) };
    }
    // The provider accepted it. A database error here must not become a send failure: it propagates, the row
    // stays PROCESSING, and the next lease holder marks it UNKNOWN (never resent, automatically or manually).
    // UNKNOWN too: a slow send that outlived its lease still reports the truth.
    await this.settle(rec.id, 'ACCEPTED', null, providerMessageId, ['PROCESSING', 'UNKNOWN']);
    return { called: true };
  }

  /** The outcome of a send that threw. Returns when the whole run should resume, if it must wait. */
  private async recordFailure(rec: Claimed, err: unknown): Promise<Date | undefined> {
    // Not one of the provider's classified failures, so nothing proves it was not accepted.
    if (!(err instanceof EmailSendError)) {
      await this.settle(rec.id, 'UNKNOWN', 'unknown_error');
      return undefined;
    }
    const { code, retryable } = err;
    if (!retryable) {
      await this.settle(rec.id, 'FAILED', code);
      if (HARD_BOUNCE.test(code)) {
        await this.prisma.$transaction((tx) => suppress(tx, { emailHash: rec.emailHash, reason: 'HARD_BOUNCE', userId: rec.userId }));
      }
      return undefined;
    }
    // Timeout, network, 5xx: Graph may have accepted it and has no idempotency key. Never resent.
    if (!NOT_ACCEPTED_RETRYABLE.has(code)) {
      await this.settle(rec.id, 'UNKNOWN', code);
      return undefined;
    }
    if (rec.attemptCount >= MAX_ATTEMPTS) {
      await this.settle(rec.id, 'FAILED', code);
      return undefined;
    }
    const nextAttemptAt = new Date(Date.now() + (err.retryAfterMs ?? this.settings.backoffMs * 2 ** (rec.attemptCount - 1)));
    await this.prisma.announcementRunRecipient.updateMany({
      where: { id: rec.id, status: 'PROCESSING' },
      data: { status: 'QUEUED', reasonCode: code, nextAttemptAt },
    });
    // Throttling concerns the mailbox, not this customer: the whole run waits.
    return code === 'rate_limit_exceeded' ? nextAttemptAt : undefined;
  }

  private settle(
    id: string,
    to: AnnouncementRecipientStatus,
    reasonCode: string | null,
    providerMessageId?: string | null,
    from: AnnouncementRecipientStatus[] = ['PROCESSING'],
  ) {
    return this.prisma.announcementRunRecipient.updateMany({
      where: { id, status: { in: from } },
      data: { status: to, reasonCode, finishedAt: new Date(), ...(to === 'ACCEPTED' ? { providerMessageId: providerMessageId ?? null } : {}) },
    });
  }

  /** Moves one bounded batch of never-attempted recipients to `to`. Returns whether any moved. */
  private async sweep(runId: string, to: 'CANCELLED' | 'SKIPPED', reasonCode: string | null): Promise<boolean> {
    const rows = await this.prisma.announcementRunRecipient.findMany({
      where: { runId, status: 'QUEUED' },
      orderBy: { id: 'asc' },
      take: SWEEP_BATCH,
      select: { id: true },
    });
    if (!rows.length) return false;
    await this.prisma.announcementRunRecipient.updateMany({
      where: { id: { in: rows.map((r) => r.id) }, status: 'QUEUED' },
      data: { status: to, reasonCode, finishedAt: new Date() },
    });
    return true;
  }

  /**
   * Ends the run unless work appeared since the caller looked. Under the lock confirmRetry holds, so a retry either
   * commits first (its QUEUED rows are seen here: returns false, the slice carries on) or finds the final state and
   * reopens it. True when the run is no longer active.
   */
  private finish(runId: string, status: Exclude<AnnouncementRunStatus, 'PREPARING' | 'SENDING'>, reason: string | null): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('announcement-broadcast'))`;
      if (await tx.announcementRunRecipient.count({ where: { runId, status: { in: ['QUEUED', 'PROCESSING'] } } })) return false;
      const { count } = await tx.announcementSendRun.updateMany({
        where: { id: runId, status: { in: ACTIVE_RUN } },
        data: { status, finishReason: reason, completedAt: new Date() },
      });
      if (!count) return true;
      const run = await tx.announcementSendRun.findUniqueOrThrow({ where: { id: runId }, select: { announcementId: true, announcementVersion: true } });
      const groups = await tx.announcementRunRecipient.groupBy({ by: ['status'], where: { runId }, _count: { _all: true } });
      const totals = Object.fromEntries(groups.map((g) => [g.status.toLowerCase(), g._count._all]));
      await writeAuditLog(tx, {
        eventType: AuditEventType.ANNOUNCEMENT_BROADCAST_FINISHED,
        actor: { type: AuditActorType.SYSTEM, userId: null },
        subjectType: 'AnnouncementSendRun',
        subjectId: runId,
        metadata: { announcementId: run.announcementId, version: run.announcementVersion, outcome: status.toLowerCase(), reason, ...totals },
      });
      this.logger.log(`announcement_broadcast_finished run ${runId} outcome ${status.toLowerCase()}${reason ? ` reason ${reason}` : ''}`);
      return true;
    });
  }
}
