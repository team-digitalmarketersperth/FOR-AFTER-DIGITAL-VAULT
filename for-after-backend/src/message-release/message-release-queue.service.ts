import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { ReleaseTriggerType } from '../generated/prisma/client.js';
import { positiveInt } from '../media/media.service.js';
import { errorCode } from '../prisma/prisma.service.js';

// The only thing stored in Redis: no content, recipient data or URLs.
// occurrenceId (Phase 16): one Recipient's yearly occurrence instead of the
// whole Message.
export interface ReleaseJobData {
  messageId: string;
  occurrenceId?: string;
}

// BullMQ rejects custom ids with a single ':' (reserved for its own ids).
export const releaseJobId = (messageId: string) =>
  `message-release-${messageId}`;
export const occurrenceJobId = (occurrenceId: string) =>
  `message-release-occurrence-${occurrenceId}`;

const jobIdFor = ({ messageId, occurrenceId }: ReleaseJobData) =>
  occurrenceId ? occurrenceJobId(occurrenceId) : releaseJobId(messageId);

const JOB_NAME = 'release';
// A Redis outage must not hang the scheduling API.
const REDIS_TIMEOUT_MS = 5000;
// States in which an existing job will still run by itself.
export const PENDING_JOB_STATES = new Set([
  'delayed',
  'waiting',
  'prioritized',
  'active',
]);

export const releaseSettings = (config: ConfigService) => {
  const url = config.get<string>('QUEUE_REDIS_URL') || config.get('REDIS_URL');
  if (!url) throw new Error('REDIS_URL is not set. Add it to .env.');
  return {
    queueName: config.get<string>('RELEASE_QUEUE_NAME') || 'message-release',
    connection: { url },
    lookaheadMs:
      positiveInt(config, 'RELEASE_QUEUE_LOOKAHEAD_SECONDS', 86400) * 1000,
    reconcileIntervalMs:
      positiveInt(config, 'RELEASE_RECONCILE_INTERVAL_SECONDS', 60) * 1000,
    attempts: positiveInt(config, 'RELEASE_JOB_ATTEMPTS', 5),
    backoffMs: positiveInt(config, 'RELEASE_JOB_BACKOFF_MS', 5000),
  };
};
export type ReleaseSettings = ReturnType<typeof releaseSettings>;

type ScheduleTiming = {
  triggerType: ReleaseTriggerType;
  scheduledFor: Date | null;
  createdAt?: Date;
};

// Triggers queued straight from a schedule change (whole-message release).
const scheduleDueAt = (s: ScheduleTiming | null) => {
  switch (s?.triggerType) {
    case ReleaseTriggerType.FIXED_DATE:
    case ReleaseTriggerType.CUSTOM_EVENT:
      return s.scheduledFor;
    case ReleaseTriggerType.NOW:
      return s.createdAt ?? null;
    default:
      return null;
  }
};

export const withTimeout = <T>(work: Promise<T>): Promise<T> =>
  Promise.race([
    work,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error('Redis timeout')),
        REDIS_TIMEOUT_MS,
      ).unref(),
    ),
  ]);

/**
 * Keeps the BullMQ release queue in line with PostgreSQL. Redis is only an
 * execution aid: a missing, late or stale job is repaired by the reconciler,
 * and the worker re-checks PostgreSQL before releasing anything.
 */
@Injectable()
export class MessageReleaseQueue implements OnModuleDestroy {
  private readonly logger = new Logger(MessageReleaseQueue.name);
  readonly settings: ReleaseSettings;
  // Also used by the admin queue monitor (Step 16): counts, failed jobs, retry.
  readonly queue: Queue<ReleaseJobData>;

  constructor(config: ConfigService) {
    this.settings = releaseSettings(config);
    // Fail fast instead of buffering commands while Redis is down.
    this.queue = new Queue<ReleaseJobData>(this.settings.queueName, {
      connection: { ...this.settings.connection, enableOfflineQueue: false },
    });
    // Code only: messages can include the host.
    this.queue.on('error', (err) =>
      this.logger.error(`Release queue error (code: ${errorCode(err)})`),
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
  }

  /**
   * Called after a schedule change has committed. Never throws: a Redis
   * failure is logged and repaired by the next reconciliation. null = the
   * message is no longer scheduled.
   */
  async sync(
    messageId: string,
    schedule: ScheduleTiming | null,
    now = new Date(),
  ): Promise<void> {
    // FIXED_DATE, CUSTOM_EVENT and NOW (immediately, after commit) are queued
    // from a schedule change. Death triggers are queued from their activation
    // (Step 15); recurring occurrences by ensureOccurrence.
    const dueAt = scheduleDueAt(schedule);
    try {
      await withTimeout(this.apply({ messageId }, dueAt, now));
    } catch (err) {
      this.logger.warn(
        `release_queue_sync_failed message ${messageId} (code: ${errorCode(err)}); the reconciler will retry`,
      );
    }
  }

  /**
   * Reconciler / death-trigger activation: makes sure a due-soon message has a
   * job that will fire no later than dueAt (FIXED_DATE scheduledFor or a death
   * activation's dueAt). Returns true if it (re)queued one. Throws on Redis errors.
   */
  ensure(messageId: string, scheduledFor: Date, now = new Date()) {
    return this.ensureJob({ messageId }, scheduledFor, now);
  }

  /** Same, for one Recipient's yearly occurrence (Phase 16). */
  ensureOccurrence(
    messageId: string,
    occurrenceId: string,
    dueAt: Date,
    now = new Date(),
  ) {
    return this.ensureJob({ messageId, occurrenceId }, dueAt, now);
  }

  /** ensureOccurrence that never throws (after a schedule change commits). */
  async syncOccurrences(
    messageId: string,
    occurrences: { id: string; dueAt: Date }[],
    now = new Date(),
  ): Promise<void> {
    for (const o of occurrences) {
      await this.ensureOccurrence(messageId, o.id, o.dueAt, now).catch((err) =>
        this.logger.warn(
          `release_queue_sync_failed occurrence ${o.id} (code: ${errorCode(err)}); the reconciler will retry`,
        ),
      );
    }
  }

  private ensureJob(data: ReleaseJobData, scheduledFor: Date, now: Date) {
    return withTimeout(
      (async () => {
        const job = await this.queue.getJob(jobIdFor(data));
        if (job) {
          const state = await job.getState();
          const firesAt = job.timestamp + (job.opts.delay ?? 0);
          // An early job is fine (the worker re-delays it); a late one is not.
          if (
            state === 'active' ||
            (PENDING_JOB_STATES.has(state) &&
              firesAt <= scheduledFor.getTime() + 1000)
          ) {
            return false;
          }
        }
        return this.apply(data, scheduledFor, now);
      })(),
    );
  }

  // Replace the job with one for dueAt (null = remove only). Only times inside
  // the lookahead window are queued; everything else waits in PostgreSQL.
  // Returns true if a job was added.
  private async apply(
    data: ReleaseJobData,
    dueAt: Date | null,
    now: Date,
  ): Promise<boolean> {
    const jobId = jobIdFor(data);
    // 0 if missing or running; a running job re-reads PostgreSQL anyway.
    await this.queue.remove(jobId);
    if (!dueAt) return false;
    const delay = Math.max(0, dueAt.getTime() - now.getTime());
    if (delay > this.settings.lookaheadMs) return false;
    await this.queue.add(JOB_NAME, data, {
      jobId,
      delay,
      attempts: this.settings.attempts,
      backoff: { type: 'exponential', delay: this.settings.backoffMs },
      // Bounded history; the reconciler replaces finished jobs as needed.
      removeOnComplete: { age: 24 * 3600, count: 1000 },
      removeOnFail: { age: 7 * 24 * 3600, count: 1000 },
    });
    return true;
  }
}
