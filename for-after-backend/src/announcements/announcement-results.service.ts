import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { paginate, writeAuditLog, type AuditActor } from '../audit/audit-log.service.js';
import { OPEN_STATUSES } from '../death-verification/death-verification-workflow.service.js';
import { emailSettings } from '../email/email-provider.js';
import { type AnnouncementRecipientStatus, type AnnouncementRunStatus, AuditEventType, Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AnnouncementPolicy } from './announcement-audience.service.js';
import { emailHash, MAX_ATTEMPTS, skipReason } from './announcement-broadcast.processor.js';
import { ACTIVE_RUN, AnnouncementBroadcastQueue } from './announcement-broadcast-queue.service.js';
import { unsubscribePlaceholder } from './announcement-broadcast.service.js';
import type { CreateRetryDto, RecipientQueryDto } from './announcements.dto.js';
import { NOT_ACCEPTED_RETRYABLE } from './announcement-test.processor.js';

/**
 * Each manual retry is one provider attempt (the processor stops automatic
 * retries at MAX_ATTEMPTS), so this allows at most two manual retries.
 */
export const RETRY_ATTEMPT_LIMIT = MAX_ATTEMPTS + 2;
// shortcut: one retry request covers at most this many recipients; a larger set is retried in several requests.
export const RETRY_BATCH_MAX = 500;

const adminRef = { select: { id: true, firstName: true, lastName: true, email: true } } as const;
const RETRY_CODES = [...NOT_ACCEPTED_RETRYABLE];

const MESSAGES: Record<string, string> = {
  run_stopped: 'This send was stopped. Stopped sends are not retried.',
  run_blocked: 'This send was stopped by the server. It cannot be retried.',
  run_preparing: 'The audience is still being prepared.',
  broadcast_disabled: 'Customer broadcasting is turned off on this server, so retry is unavailable.',
  pilot_only: 'This server only allows pilot sends, so this all-eligible send cannot be retried.',
  policy_blocked: 'The communication policy changed since this send was confirmed, so it cannot be retried.',
};
const NOTHING_TO_RETRY = 'There are no failed emails that can be retried now. Refresh the results.';
const RETRY_SET_CHANGED = 'The failed emails that can be retried have changed since you reviewed them. Review the retry again.';
const RETRY_OPERATION_REUSED = 'This retry confirmation was already used for a different request.';
const RUN_IN_PROGRESS = 'Another customer send is in progress. Retry after it finishes.';

type Db = PrismaService | Prisma.TransactionClient;
type RunForRetry = { status: AnnouncementRunStatus; cancelRequestedAt: Date | null; audience: 'PILOT' | 'ALL_ELIGIBLE'; policyVersion: string };
type Candidate = { id: string; userId: string; emailHash: string; reasonCode: string | null; attemptCount: number; attemptedAt: Date | null; finishedAt: Date | null };

/**
 * Why one recipient row cannot be retried, from its own record (null = the row allows it).
 * Only FAILED rows whose last failure provably was not accepted (throttling, sign-in) and
 * that exhausted automatic attempts qualify. Never ACCEPTED, UNKNOWN (possibly accepted),
 * permanent failures (invalid address, rejected message, sender misconfiguration),
 * pending, processing, skipped or cancelled rows.
 */
export function retryRowBlock(r: { status: AnnouncementRecipientStatus; reasonCode: string | null; attemptCount: number }): string | null {
  if (r.status !== 'FAILED') return 'not_failed';
  if (!r.reasonCode || !NOT_ACCEPTED_RETRYABLE.has(r.reasonCode)) return 'permanent_failure';
  if (r.attemptCount >= RETRY_ATTEMPT_LIMIT) return 'retry_limit_reached';
  return null;
}

/** The reviewed set's identity: order-independent, ids only. */
export const retrySetHash = (ids: string[]) => createHash('sha256').update([...ids].sort().join(',')).digest('hex');

/**
 * Notification centre results: recipient-level monitoring and safe manual
 * retry of a customer run. SUPER_ADMIN only (controller). Responses carry ids,
 * states and safe reason codes; an address is shown only while it is still the
 * one the email was prepared for (no address is stored with the run).
 */
@Injectable()
export class AnnouncementResultsService {
  private readonly logger = new Logger(AnnouncementResultsService.name);
  private readonly appBaseUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: AnnouncementBroadcastQueue,
    private readonly policy: AnnouncementPolicy,
    config: ConfigService,
  ) {
    this.appBaseUrl = emailSettings(config).appBaseUrl;
  }

  /** Why nothing in this run can be retried right now (null = the run allows retries). */
  private runBlock(run: RunForRetry): string | null {
    if (run.cancelRequestedAt || run.status === 'CANCELLED') return 'run_stopped';
    if (run.status === 'BLOCKED') return 'run_blocked';
    if (run.status === 'PREPARING') return 'run_preparing';
    const mode = this.queue.settings.mode();
    if (mode === 'off') return 'broadcast_disabled';
    if (mode === 'pilot' && run.audience !== 'PILOT') return 'pilot_only';
    if (this.policy.blockers.length || this.policy.version !== run.policyVersion) return 'policy_blocked';
    return null;
  }

  private async findRun(db: Db, announcementId: string, runId: string) {
    const run = await db.announcementSendRun.findFirst({
      where: { id: runId, announcementId },
      select: {
        id: true,
        status: true,
        cancelRequestedAt: true,
        audience: true,
        policyVersion: true,
        subject: true,
        announcementVersion: true,
        completedAt: true,
        html: true,
        text: true,
      },
    });
    if (!run) throw new NotFoundException('Broadcast not found.');
    return run;
  }

  /** The send-time rules, now (skipReason): account, address unchanged, death report, suppression, consent. */
  private async currentChecks(db: Db, rows: { userId: string; emailHash: string }[]) {
    if (!rows.length) return new Map<string, string | null>();
    const userIds = rows.map((r) => r.userId);
    const [users, reports, suppressed] = await Promise.all([
      db.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, role: true, status: true, deletedAt: true, email: true, emailVerifiedAt: true, marketingConsentAt: true },
      }),
      db.deathVerificationCase.findMany({ where: { ownerUserId: { in: userIds }, status: { in: OPEN_STATUSES } }, select: { ownerUserId: true } }),
      db.emailSuppression.findMany({ where: { emailHash: { in: rows.map((r) => r.emailHash) } }, select: { emailHash: true } }),
    ]);
    const byId = new Map(users.map((u) => [u.id, u]));
    const open = new Set(reports.map((r) => r.ownerUserId));
    const blocked = new Set(suppressed.map((s) => s.emailHash));
    return new Map(
      rows.map((r) => [r.userId, skipReason(byId.get(r.userId) ?? null, r.emailHash, { openDeathReport: open.has(r.userId), suppressed: blocked.has(r.emailHash) })]),
    );
  }

  /** Recipients that may be retried now, by their own record and the current rules (not the run gate). */
  private async eligible(db: Db, runId: string, recipientId?: string): Promise<Candidate[]> {
    const found: Candidate[] = [];
    // Pages by id, so rows blocked by the current rules cannot hide eligible ones behind them.
    for (let after: string | undefined; ; ) {
      const rows = await db.announcementRunRecipient.findMany({
        where: {
          runId,
          status: 'FAILED',
          reasonCode: { in: RETRY_CODES },
          attemptCount: { lt: RETRY_ATTEMPT_LIMIT },
          ...(recipientId ? { id: recipientId } : after ? { id: { gt: after } } : {}),
        },
        orderBy: { id: 'asc' },
        take: RETRY_BATCH_MAX,
        select: { id: true, userId: true, emailHash: true, reasonCode: true, attemptCount: true, attemptedAt: true, finishedAt: true },
      });
      const checks = await this.currentChecks(db, rows);
      found.push(...rows.filter((r) => !checks.get(r.userId)));
      if (found.length >= RETRY_BATCH_MAX) return found.slice(0, RETRY_BATCH_MAX);
      if (rows.length < RETRY_BATCH_MAX) return found;
      after = rows.at(-1)!.id;
    }
  }

  /** For the results page: how many failures could be retried, why not (if so), and recent retry requests. */
  async summary(announcementId: string, runId: string) {
    const run = await this.findRun(this.prisma, announcementId, runId);
    const [eligible, activity] = await Promise.all([
      this.eligible(this.prisma, runId),
      this.prisma.announcementRetry.findMany({
        where: { runId },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { id: true, createdAt: true, scope: true, recipientCount: true, requestedBy: adminRef },
      }),
    ]);
    return { eligible: eligible.length, blockedReason: this.runBlock(run), limit: RETRY_BATCH_MAX, activity };
  }

  /** One page of recipients. Search matches the current name or address of the account. */
  async recipients(announcementId: string, runId: string, q: RecipientQueryDto) {
    const run = await this.findRun(this.prisma, announcementId, runId);
    const search = q.q
      ? {
          user: {
            OR: [
              { email: { contains: q.q, mode: 'insensitive' as const } },
              { firstName: { contains: q.q, mode: 'insensitive' as const } },
              { lastName: { contains: q.q, mode: 'insensitive' as const } },
            ],
          },
        }
      : {};
    const where: Prisma.AnnouncementRunRecipientWhereInput = { runId, ...(q.status ? { status: q.status } : {}), ...search };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.announcementRunRecipient.findMany({
        where,
        orderBy: { id: 'asc' },
        skip: (q.page - 1) * q.limit,
        take: q.limit,
        select: recipientSelect,
      }),
      this.prisma.announcementRunRecipient.count({ where }),
    ]);
    const items = await this.view(run, rows);
    return { items, pagination: paginate(q.page, q.limit, total) };
  }

  /** One recipient with its retry history (each retry keeps the outcome it replaced). */
  async recipient(announcementId: string, runId: string, recipientId: string) {
    const run = await this.findRun(this.prisma, announcementId, runId);
    const row = await this.prisma.announcementRunRecipient.findFirst({
      where: { id: recipientId, runId },
      select: {
        ...recipientSelect,
        providerMessageId: true,
        retryItems: {
          orderBy: { createdAt: 'asc' },
          select: {
            previousReasonCode: true,
            previousAttemptCount: true,
            previousAttemptedAt: true,
            retry: { select: { createdAt: true, scope: true, requestedBy: adminRef } },
          },
        },
      },
    });
    if (!row) throw new NotFoundException('Recipient not found.');
    const [item] = await this.view(run, [row]);
    return {
      ...item!,
      // Whether Microsoft returned a request id; the id itself stays server-side.
      providerReference: !!row.providerMessageId,
      history: row.retryItems.map((h) => ({
        retriedAt: h.retry.createdAt,
        scope: h.retry.scope,
        requestedBy: h.retry.requestedBy,
        previousReasonCode: h.previousReasonCode,
        previousAttemptCount: h.previousAttemptCount,
        previousAttemptedAt: h.previousAttemptedAt,
      })),
    };
  }

  private async view(run: RunForRetry, rows: RecipientRow[]) {
    const runBlock = this.runBlock(run);
    const checks = await this.currentChecks(
      this.prisma,
      rows.filter((r) => r.status === 'FAILED'),
    );
    return rows.map((r) => {
      const blocked = r.status === 'FAILED' ? (retryRowBlock(r) ?? checks.get(r.userId) ?? runBlock) : null;
      // The address the email was prepared for, only while the account still has it.
      const same = !!r.user && emailHash(r.user.email) === r.emailHash;
      return {
        id: r.id,
        email: same ? r.user!.email : null,
        name: [r.user?.firstName, r.user?.lastName].filter(Boolean).join(' ') || null,
        status: r.status,
        reasonCode: r.reasonCode,
        attemptCount: r.attemptCount,
        lastAttemptAt: r.attemptedAt,
        finishedAt: r.finishedAt,
        retryable: r.status === 'FAILED' && !blocked,
        retryBlockedReason: blocked,
      };
    });
  }

  /** The email exactly as queued for this run (snapshot), with a non-working unsubscribe link. */
  async email(announcementId: string, runId: string) {
    const run = await this.findRun(this.prisma, announcementId, runId);
    const placeholder = unsubscribePlaceholder(runId);
    const link = `${this.appBaseUrl}/unsubscribe`;
    return {
      subject: run.subject,
      announcementVersion: run.announcementVersion,
      html: run.html.replaceAll(placeholder, link),
      text: run.text.replaceAll(placeholder, link),
    };
  }

  /** What a retry would queue now: the exact set (count + hash) or why nothing can be retried. */
  async reviewRetry(announcementId: string, runId: string, recipientId?: string) {
    const run = await this.findRun(this.prisma, announcementId, runId);
    const blocked = this.runBlock(run);
    const set = await this.eligible(this.prisma, runId, recipientId);
    return {
      subject: run.subject,
      announcementVersion: run.announcementVersion,
      audience: run.audience,
      scope: recipientId ? 'ONE' : 'ALL',
      count: set.length,
      setHash: retrySetHash(set.map((r) => r.id)),
      blockers: blocked ? [{ code: blocked, message: MESSAGES[blocked] }] : set.length ? [] : [{ code: 'nothing_to_retry', message: NOTHING_TO_RETRY }],
    };
  }

  /**
   * Queues exactly the reviewed set again in the same run (no new run). One
   * transaction under the broadcast lock: replay check, run gate, fresh set =
   * reviewed set, previous outcomes kept (AnnouncementRetryItem), rows back to
   * QUEUED only if still FAILED, a COMPLETED run reopened, audit. The worker
   * then sends with the run's snapshot and rechecks each recipient first.
   */
  async confirmRetry(announcementId: string, runId: string, dto: CreateRetryDto, actor: AuditActor) {
    let result: { retryId: string; count: number; created: boolean };
    try {
      result = await this.prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('announcement-broadcast'))`;
          const replay = await tx.announcementRetry.findUnique({
            where: { requestedByUserId_clientOperationId: { requestedByUserId: actor.userId, clientOperationId: dto.clientOperationId } },
            select: { id: true, runId: true, recipientCount: true, setHash: true },
          });
          if (replay) {
            if (replay.runId !== runId || replay.setHash !== dto.setHash) throw new ConflictException(RETRY_OPERATION_REUSED);
            return { retryId: replay.id, count: replay.recipientCount, created: false };
          }
          const run = await this.findRun(tx, announcementId, runId);
          const blocked = this.runBlock(run);
          if (blocked) throw new ConflictException(MESSAGES[blocked]);
          const set = await this.eligible(tx, runId, dto.recipientId);
          if (!set.length) throw new ConflictException(NOTHING_TO_RETRY);
          if (retrySetHash(set.map((r) => r.id)) !== dto.setHash) throw new ConflictException(RETRY_SET_CHANGED);
          if (await tx.announcementSendRun.findFirst({ where: { id: { not: runId }, status: { in: ACTIVE_RUN } }, select: { id: true } })) {
            throw new ConflictException(RUN_IN_PROGRESS);
          }
          const retry = await tx.announcementRetry.create({
            data: {
              runId,
              requestedByUserId: actor.userId,
              clientOperationId: dto.clientOperationId,
              scope: dto.recipientId ? 'ONE' : 'ALL',
              setHash: dto.setHash,
              recipientCount: set.length,
              previousRunStatus: run.status,
              previousCompletedAt: run.completedAt,
              items: {
                create: set.map((r) => ({
                  recipientId: r.id,
                  previousReasonCode: r.reasonCode,
                  previousAttemptCount: r.attemptCount,
                  previousAttemptedAt: r.attemptedAt,
                  previousFinishedAt: r.finishedAt,
                })),
              },
            },
            select: { id: true },
          });
          const ids = set.map((r) => r.id);
          const { count } = await tx.announcementRunRecipient.updateMany({
            where: { id: { in: ids }, runId, status: 'FAILED', reasonCode: { in: RETRY_CODES }, attemptCount: { lt: RETRY_ATTEMPT_LIMIT } },
            data: { status: 'QUEUED', reasonCode: 'manual_retry', nextAttemptAt: null, finishedAt: null },
          });
          if (count !== ids.length) throw new ConflictException(RETRY_SET_CHANGED);
          if (run.status === 'COMPLETED') {
            // Reopen for the worker; the earlier completion stays in the retry record and the FINISHED audit row.
            const reopened = await tx.announcementSendRun.updateMany({
              where: { id: runId, status: 'COMPLETED', cancelRequestedAt: null },
              data: { status: 'SENDING', completedAt: null, finishReason: null, leaseOwner: null, leaseUntil: null },
            });
            if (!reopened.count) throw new ConflictException(RETRY_SET_CHANGED);
          }
          await writeAuditLog(tx, {
            eventType: AuditEventType.ANNOUNCEMENT_BROADCAST_RETRY_REQUESTED,
            actor,
            subjectType: 'AnnouncementSendRun',
            subjectId: runId,
            metadata: {
              announcementId,
              version: run.announcementVersion,
              retryId: retry.id,
              scope: dto.recipientId ? 'one' : 'all',
              recipients: ids.length,
              previousState: run.status.toLowerCase(),
              operationId: dto.clientOperationId,
            },
          });
          return { retryId: retry.id, count: ids.length, created: true };
        },
        { timeout: 15_000 },
      );
    } catch (err) {
      // The one-active-run index: another run became active between the check and the reopen.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new ConflictException(RUN_IN_PROGRESS);
      throw err;
    }
    // A replay re-queues too; a duplicate job only finds the lease taken.
    await this.queue.enqueue(runId);
    if (result.created) this.logger.log(`announcement_broadcast_retry_requested run ${runId} recipients ${result.count} admin ${actor.userId}`);
    return { retryId: result.retryId, count: result.count };
  }
}

const recipientSelect = {
  id: true,
  userId: true,
  emailHash: true,
  status: true,
  reasonCode: true,
  attemptCount: true,
  attemptedAt: true,
  finishedAt: true,
  user: { select: { email: true, firstName: true, lastName: true } },
} as const;
type RecipientRow = Prisma.AnnouncementRunRecipientGetPayload<{ select: typeof recipientSelect }>;
