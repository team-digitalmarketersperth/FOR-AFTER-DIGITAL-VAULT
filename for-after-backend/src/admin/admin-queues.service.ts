import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { isUUID } from 'class-validator';
import {
  type AuditActor,
  paginate,
  writeAuditLog,
} from '../audit/audit-log.service.js';
import { DeathVerificationQueue } from '../death-verification/death-verification-queue.service.js';
import { ReleaseNotificationQueue } from '../release-notifications/release-notification-queue.service.js';
import {
  type DeadLetterQueue,
  sanitizeFailedReason,
} from '../dead-letters/dead-letter.service.js';
import {
  AuditEventType,
  DeadLetterStatus,
  type Prisma,
} from '../generated/prisma/client.js';
import {
  MessageReleaseQueue,
  withTimeout,
} from '../message-release/message-release-queue.service.js';
import { errorCode, PrismaService } from '../prisma/prisma.service.js';

const COUNT_STATES = [
  'waiting',
  'active',
  'delayed',
  'prioritized',
  'failed',
  'completed',
] as const;

// Our job ids: message-release-<uuid>, message-release-occurrence-<uuid>,
// death-verification-safeguard-<uuid>, release-notification-<uuid>.
const JOB_ID = /^[A-Za-z0-9_-]{1,200}$/;

// Shared with dead letters (Phase 17A); re-exported for existing imports.
export { sanitizeFailedReason };

// Payloads are id-only by design; only a valid UUID is echoed back. An email
// job carries only its ReleaseNotification id: never an address or content.
const PAYLOAD_KEYS = new Set([
  'messageId',
  'occurrenceId',
  'caseId',
  'notificationId',
]);
const payloadIds = (data: unknown) =>
  Object.fromEntries(
    Object.entries((data ?? {}) as Record<string, unknown>).filter(
      ([k, v]) => PAYLOAD_KEYS.has(k) && typeof v === 'string' && isUUID(v),
    ),
  );

/**
 * Read-mostly view of the queues this API owns. The allowlist maps a stable
 * public name to the app's own Queue instance, so a request can never name an
 * arbitrary Redis key. Retrying only re-queues a failed job; the worker still
 * re-checks PostgreSQL before releasing or advancing anything.
 */
@Injectable()
export class AdminQueuesService {
  private readonly logger = new Logger(AdminQueuesService.name);
  private readonly queues: ReadonlyMap<string, Queue>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly releases: MessageReleaseQueue,
    private readonly deaths: DeathVerificationQueue,
    private readonly emails: ReleaseNotificationQueue,
  ) {
    this.queues = new Map<string, Queue>([
      ['message-release', releases.queue],
      ['death-verification', deaths.queue],
      ['email-delivery', emails.queue],
    ]);
  }

  async summary() {
    return this.redis(
      Promise.all(
        [...this.queues].map(async ([name, queue]) => {
          const counts = await queue.getJobCounts(...COUNT_STATES);
          return {
            name,
            ...(Object.fromEntries(
              COUNT_STATES.map((s) => [s, counts[s] ?? 0]),
            ) as Record<(typeof COUNT_STATES)[number], number>),
          };
        }),
      ),
    );
  }

  async failed(name: string, page: number, limit: number) {
    const queue = this.get(name);
    const start = (page - 1) * limit;
    const [total, jobs] = await this.redis(
      Promise.all([
        queue.getFailedCount(),
        queue.getFailed(start, start + limit - 1),
      ]),
    );
    this.logger.log(`admin_queue_viewed queue ${name} failed page ${page}`);
    return {
      items: jobs.filter(Boolean).map((job) => this.toFailedJob(name, job)),
      pagination: paginate(page, limit, total),
    };
  }

  async retry(name: string, jobId: string, actor: AuditActor) {
    const queue = this.get(name);
    if (!JOB_ID.test(jobId)) throw new BadRequestException('jobId is invalid');
    const job = await this.redis(queue.getJob(jobId));
    if (!job) throw new NotFoundException('Job not found.');
    const state = await this.redis(job.getState());
    if (state !== 'failed') {
      throw new ConflictException('Only failed jobs can be retried.');
    }
    const attemptsMade = job.attemptsMade;
    try {
      // A fresh retry budget; eligibility is decided by the worker, not here.
      await withTimeout(job.retry('failed', { resetAttemptsMade: true }));
    } catch (err) {
      this.logger.warn(
        `admin_failed_job_retry_refused queue ${name} job ${jobId} (code: ${errorCode(err)})`,
      );
      throw new ConflictException(
        'The job could not be retried. Refresh and try again.',
      );
    }
    // Its dead letter (if any) now waits for this run's outcome.
    await this.prisma.deadLetterJob.updateMany({
      where: { queueName: name, jobId, status: DeadLetterStatus.OPEN },
      data: { status: DeadLetterStatus.REQUEUED, requeuedAt: new Date() },
    });
    await writeAuditLog(this.prisma, {
      eventType: AuditEventType.FAILED_JOB_RETRIED,
      actor,
      subjectType: 'Job',
      subjectId: jobId,
      metadata: { queue: name, attemptsMade },
    });
    this.logger.log(
      `admin_failed_job_retried queue ${name} job ${jobId} admin ${actor.userId}`,
    );
    return { queue: name, jobId, state: 'waiting' as const };
  }

  /** Phase 17A: durable dead letters (PostgreSQL), newest failure first. */
  async deadLetters(query: {
    queue?: DeadLetterQueue;
    status?: DeadLetterStatus;
    from?: string;
    to?: string;
    page: number;
    limit: number;
  }) {
    const { queue, status, from, to, page, limit } = query;
    const where: Prisma.DeadLetterJobWhereInput = {
      queueName: queue,
      status,
      failedAt:
        from || to
          ? {
              ...(from ? { gte: new Date(from) } : {}),
              ...(to ? { lte: new Date(to) } : {}),
            }
          : undefined,
    };
    const [total, items] = await this.prisma.$transaction([
      this.prisma.deadLetterJob.count({ where }),
      this.prisma.deadLetterJob.findMany({
        where,
        orderBy: [{ failedAt: 'desc' }, { id: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);
    return { items, pagination: paginate(page, limit, total) };
  }

  async deadLetter(id: string) {
    const row = await this.prisma.deadLetterJob.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Dead letter not found.');
    return row;
  }

  /**
   * Re-queue an OPEN dead letter through the queue's own helper, derived from
   * the entity id in PostgreSQL (never from a stored payload). The worker
   * still makes every business decision; the row stays REQUEUED until that run
   * completes (RESOLVED) or fails again (OPEN, one new alert).
   */
  async retryDeadLetter(id: string, actor: AuditActor) {
    const row = await this.deadLetter(id);
    // Claim first: of two concurrent retries exactly one gets count 1.
    const { count } = await this.prisma.deadLetterJob.updateMany({
      where: { id, status: DeadLetterStatus.OPEN },
      data: { status: DeadLetterStatus.REQUEUED, requeuedAt: new Date() },
    });
    if (!count) {
      throw new ConflictException('Only open dead letters can be retried.');
    }
    let outcome: 'requeued' | 'stale';
    try {
      outcome = await this.requeue(row.entityType, row.entityId);
    } catch (err) {
      await this.prisma.deadLetterJob.updateMany({
        where: { id, status: DeadLetterStatus.REQUEUED },
        data: { status: DeadLetterStatus.OPEN },
      });
      this.logger.error(
        `admin_dead_letter_retry_failed deadLetter ${id} (code: ${errorCode(err)})`,
      );
      throw new ServiceUnavailableException(
        'The job could not be queued. Try again shortly.',
      );
    }
    if (outcome === 'stale') {
      // Its entity is gone: nothing left to run.
      await this.prisma.deadLetterJob.updateMany({
        where: { id, status: DeadLetterStatus.REQUEUED },
        data: {
          status: DeadLetterStatus.RESOLVED,
          resolvedAt: new Date(),
          resolution: 'stale',
        },
      });
    }
    await writeAuditLog(this.prisma, {
      eventType: AuditEventType.DEAD_LETTER_RETRY_REQUESTED,
      actor,
      subjectType: 'DeadLetterJob',
      subjectId: id,
      metadata: { queue: row.queueName, jobId: row.jobId, outcome },
    });
    this.logger.log(
      `admin_dead_letter_retried deadLetter ${id} queue ${row.queueName} job ${row.jobId} (${outcome}) admin ${actor.userId}`,
    );
    return this.deadLetter(id);
  }

  // The canonical enqueue for each entity. Throws on Redis errors.
  private async requeue(
    entityType: string,
    id: string | null,
  ): Promise<'requeued' | 'stale'> {
    if (!id) return 'stale';
    const now = new Date();
    const where = { where: { id }, select: { id: true } };
    switch (entityType) {
      case 'Message':
        if (!(await this.prisma.message.findUnique(where))) return 'stale';
        await this.releases.ensure(id, now);
        return 'requeued';
      case 'MessageRecipientRelease': {
        const occ = await this.prisma.messageRecipientRelease.findUnique({
          where: { id },
          select: { messageId: true },
        });
        if (!occ) return 'stale';
        await this.releases.ensureOccurrence(occ.messageId, id, now, now);
        return 'requeued';
      }
      case 'DeathVerificationCase':
        if (!(await this.prisma.deathVerificationCase.findUnique(where)))
          return 'stale';
        await this.deaths.requeueSafeguard(id, now);
        return 'requeued';
      case 'ReleaseNotification':
        if (!(await this.prisma.releaseNotification.findUnique(where)))
          return 'stale';
        await this.emails.requeue(id);
        return 'requeued';
      default:
        return 'stale';
    }
  }

  /** Total failed jobs, or null when Redis cannot be read (never a fake 0). */
  async failedTotal(): Promise<number | null> {
    try {
      const summary = await this.summary();
      return summary.reduce((sum, q) => sum + q.failed, 0);
    } catch {
      return null;
    }
  }

  private toFailedJob(queue: string, job: Job) {
    return {
      jobId: job.id,
      queue,
      name: job.name,
      attemptsMade: job.attemptsMade,
      maxAttempts: job.opts.attempts ?? 1,
      failedReasonSanitized: sanitizeFailedReason(job.failedReason),
      createdAt: new Date(job.timestamp),
      failedAt: job.finishedOn ? new Date(job.finishedOn) : null,
      payload: payloadIds(job.data),
    };
  }

  private get(name: string): Queue {
    const queue = this.queues.get(name);
    if (!queue) throw new NotFoundException('Queue not found.');
    return queue;
  }

  // Bounded, and never leaks Redis error text (it can include the host).
  private async redis<T>(work: Promise<T>): Promise<T> {
    try {
      return await withTimeout(work);
    } catch (err) {
      this.logger.error(`admin_queue_unavailable (code: ${errorCode(err)})`);
      throw new ServiceUnavailableException('Queue data is unavailable.');
    }
  }
}
