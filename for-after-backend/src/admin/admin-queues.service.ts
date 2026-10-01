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
import { AuditEventType } from '../generated/prisma/client.js';
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

// Our job ids: message-release-<uuid>, death-verification-safeguard-<uuid>.
const JOB_ID = /^[A-Za-z0-9_-]{1,200}$/;

/**
 * First line only, no URLs (connection strings carry credentials), no email
 * addresses, max 200 chars. Stack traces are never returned.
 */
export const sanitizeFailedReason = (reason?: string | null) =>
  (reason ?? '')
    .split('\n')[0]
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[url]')
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[email]')
    .slice(0, 200) || null;

// Payloads are id-only by design; only a valid UUID is echoed back.
const payloadIds = (data: unknown) =>
  Object.fromEntries(
    Object.entries((data ?? {}) as Record<string, unknown>).filter(
      ([k, v]) =>
        (k === 'messageId' || k === 'caseId') &&
        typeof v === 'string' &&
        isUUID(v),
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
    releases: MessageReleaseQueue,
    deaths: DeathVerificationQueue,
  ) {
    this.queues = new Map<string, Queue>([
      ['message-release', releases.queue],
      ['death-verification', deaths.queue],
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
