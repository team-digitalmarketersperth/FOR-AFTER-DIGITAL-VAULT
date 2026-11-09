import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { withTimeout } from '../message-release/message-release-queue.service.js';
import { errorCode, PrismaService } from '../prisma/prisma.service.js';
import { emailQueueSettings } from '../release-notifications/release-notification-queue.service.js';

export type AnnouncementTestJobData = { testSendId: string };
export const announcementTestJobId = (id: string) => `announcement-test-${id}`;

// Rows younger than this are left to the enqueue right after the request.
const RECONCILE_GRACE_MS = 2 * 60_000;
// A claimed send with no outcome after this long: the worker died mid-send.
export const PROCESSING_STALE_MS = 15 * 60_000;

/**
 * Notification centre Step 2: its own small queue, so test emails never wait in
 * front of (or behind) release notifications. Same Redis, attempts and backoff
 * as `email-delivery`. PostgreSQL (AnnouncementTestSend) is the source of truth;
 * a job carries only the row id, and the job id is derived from it, so enqueueing
 * twice never makes a second job.
 */
@Injectable()
export class AnnouncementTestQueue implements OnModuleDestroy {
  private readonly logger = new Logger(AnnouncementTestQueue.name);
  readonly settings: ReturnType<typeof emailQueueSettings> & { queueName: string };
  readonly queue: Queue<AnnouncementTestJobData>;

  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.settings = {
      ...emailQueueSettings(config),
      queueName: config.get<string>('ANNOUNCEMENT_TEST_QUEUE_NAME') || 'announcement-test-email',
    };
    this.queue = new Queue<AnnouncementTestJobData>(this.settings.queueName, { connection: this.settings.connection });
    this.queue.on('error', (err) => this.logger.error(`announcement_test_queue_error (code: ${errorCode(err)})`));
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
  }

  /** Best effort: a failure is logged and repaired by the reconciler (the row stays QUEUED). */
  async enqueue(testSendId: string): Promise<boolean> {
    try {
      await withTimeout(
        this.queue.add(
          'announcement-test',
          { testSendId },
          {
            jobId: announcementTestJobId(testSendId),
            attempts: Math.min(this.settings.attempts, 3),
            backoff: { type: 'exponential', delay: this.settings.backoffMs },
            removeOnComplete: { age: 24 * 3600, count: 1000 },
            removeOnFail: { age: 7 * 24 * 3600, count: 1000 },
          },
        ),
      );
      return true;
    } catch (err) {
      this.logger.warn(`announcement_test_queue_add_failed test ${testSendId} (code: ${errorCode(err)}); the reconciler will retry`);
      return false;
    }
  }

  /** Reconciler: QUEUED rows that missed their enqueue. Bounded per run. */
  async enqueueStale(now = new Date()): Promise<number> {
    const rows = await this.prisma.announcementTestSend.findMany({
      where: { status: 'QUEUED', createdAt: { lte: new Date(now.getTime() - RECONCILE_GRACE_MS) } },
      orderBy: { createdAt: 'asc' },
      take: 50,
      select: { id: true },
    });
    let queued = 0;
    for (const { id } of rows) if (await this.enqueue(id)) queued++;
    return queued;
  }
}
