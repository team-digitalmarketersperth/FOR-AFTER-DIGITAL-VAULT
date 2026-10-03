import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { positiveInt } from '../media/media.service.js';
import { withTimeout } from '../message-release/message-release-queue.service.js';
import { errorCode, PrismaService } from '../prisma/prisma.service.js';

export type NotificationJobData = { notificationId: string };

export const notificationJobId = (id: string) => `release-notification-${id}`;

// Rows younger than this are left to the enqueue right after the release; the
// reconciler only picks up rows that missed it (crash, Redis blip).
const RECONCILE_GRACE_MS = 2 * 60_000;

export const emailQueueSettings = (config: ConfigService) => {
  const url = config.get<string>('QUEUE_REDIS_URL') || config.get('REDIS_URL');
  if (!url) throw new Error('REDIS_URL is not set. Add it to .env.');
  return {
    queueName: config.get<string>('EMAIL_QUEUE_NAME') || 'email-delivery',
    connection: { url },
    attempts: positiveInt(config, 'EMAIL_JOB_ATTEMPTS', 5),
    backoffMs: positiveInt(config, 'EMAIL_JOB_BACKOFF_MS', 30_000),
    reconcileIntervalMs:
      positiveInt(config, 'EMAIL_RECONCILE_INTERVAL_SECONDS', 60) * 1000,
  };
};

/**
 * The `email-delivery` queue (Step 24): released-message notifications only.
 * PostgreSQL (ReleaseNotification) is the source of truth; a job carries just
 * the row id, never an address, subject or content. The job id is derived
 * from the row, so enqueueing twice never makes a second job.
 */
@Injectable()
export class ReleaseNotificationQueue implements OnModuleDestroy {
  private readonly logger = new Logger(ReleaseNotificationQueue.name);
  readonly settings: ReturnType<typeof emailQueueSettings>;
  readonly queue: Queue<NotificationJobData>;

  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.settings = emailQueueSettings(config);
    this.queue = new Queue<NotificationJobData>(this.settings.queueName, {
      connection: this.settings.connection,
    });
    this.queue.on('error', (err) =>
      this.logger.error(`email_queue_error (code: ${errorCode(err)})`),
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
  }

  /** Best effort: a failure is logged and repaired by the reconciler. */
  async enqueue(notificationId: string): Promise<boolean> {
    try {
      await withTimeout(
        this.queue.add(
          'message-released',
          { notificationId },
          {
            jobId: notificationJobId(notificationId),
            attempts: this.settings.attempts,
            backoff: { type: 'exponential', delay: this.settings.backoffMs },
            removeOnComplete: { age: 24 * 3600, count: 1000 },
            removeOnFail: { age: 7 * 24 * 3600, count: 1000 },
          },
        ),
      );
      return true;
    } catch (err) {
      this.logger.warn(
        `email_queue_add_failed notification ${notificationId} (code: ${errorCode(err)}); the reconciler will retry`,
      );
      return false;
    }
  }

  /** Right after a release: queue that message's new notifications. */
  async enqueueForMessage(messageId: string): Promise<number> {
    const rows = await this.prisma.releaseNotification.findMany({
      where: { status: 'PENDING', grant: { messageId } },
      select: { id: true },
    });
    for (const { id } of rows) await this.enqueue(id);
    return rows.length;
  }

  /** Reconciler: PENDING rows that missed their enqueue. Bounded per run. */
  async enqueueStale(now = new Date()): Promise<number> {
    const rows = await this.prisma.releaseNotification.findMany({
      where: {
        status: 'PENDING',
        createdAt: { lte: new Date(now.getTime() - RECONCILE_GRACE_MS) },
      },
      orderBy: { createdAt: 'asc' },
      take: 200,
      select: { id: true },
    });
    let queued = 0;
    for (const { id } of rows) if (await this.enqueue(id)) queued++;
    return queued;
  }
}
