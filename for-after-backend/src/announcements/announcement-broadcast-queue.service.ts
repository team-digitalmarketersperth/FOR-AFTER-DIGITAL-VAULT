import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import type { AnnouncementRunStatus } from '../generated/prisma/client.js';
import { positiveInt } from '../media/media.service.js';
import { withTimeout } from '../message-release/message-release-queue.service.js';
import { errorCode, PrismaService } from '../prisma/prisma.service.js';
import { emailQueueSettings } from '../release-notifications/release-notification-queue.service.js';

export type BroadcastJobData = { runId: string };
export const ACTIVE_RUN: AnnouncementRunStatus[] = ['PREPARING', 'SENDING'];

// Exchange Online per-mailbox limits (Microsoft service description): 30
// messages per minute and 10,000 recipients per day. Broadcasts never take
// all of it: OTPs, invitations and release emails share the same mailbox.
const MAILBOX_PER_MINUTE = 30;
const MAILBOX_PER_DAY = 10_000;

const capped = (config: ConfigService, key: string, fallback: number, max: number) => {
  const value = positiveInt(config, key, fallback);
  if (value > max) throw new Error(`${key} must be at most ${max} (Microsoft mailbox limit, shared with transactional email).`);
  return value;
};

export type BroadcastMode = 'off' | 'pilot' | 'all';

/**
 * ANNOUNCEMENT_BROADCAST_ENABLED is the server-side gate, read on every
 * confirmation and before every send: unset/anything else = off (default),
 * "pilot" = pilot-group sends only, "true" = pilot and all-eligible sends.
 * Turning it off (and restarting API and worker) ends a running broadcast
 * BLOCKED; it does not pause it.
 */
export const broadcastSettings = (config: ConfigService) => {
  const email = emailQueueSettings(config);
  return {
    mode: (): BroadcastMode => {
      const v = config.get<string>('ANNOUNCEMENT_BROADCAST_ENABLED');
      return v === 'true' ? 'all' : v === 'pilot' ? 'pilot' : 'off';
    },
    queueName: config.get<string>('ANNOUNCEMENT_BROADCAST_QUEUE_NAME') || 'announcement-broadcast',
    connection: email.connection,
    reconcileIntervalMs: email.reconcileIntervalMs,
    backoffMs: email.backoffMs,
    // One email at a time, spaced by 60 s / rate. Default leaves 20/min for transactional email.
    ratePerMinute: capped(config, 'ANNOUNCEMENT_BROADCAST_RATE_PER_MINUTE', 10, MAILBOX_PER_MINUTE),
    // Provider attempts by all broadcasts in the last 24 hours; reaching it pauses the run.
    dailyLimit: capped(config, 'ANNOUNCEMENT_BROADCAST_DAILY_LIMIT', 2000, MAILBOX_PER_DAY),
  };
};

/**
 * The `announcement-broadcast` queue. A job means "drive this run for one
 * slice"; it carries only the run id. PostgreSQL is the source of truth and a
 * lease on the run row lets one driver at a time act, so duplicate or
 * re-delivered jobs are harmless (they find the lease taken and stop).
 */
@Injectable()
export class AnnouncementBroadcastQueue implements OnModuleDestroy {
  private readonly logger = new Logger(AnnouncementBroadcastQueue.name);
  readonly settings: ReturnType<typeof broadcastSettings>;
  readonly queue: Queue<BroadcastJobData>;

  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.settings = broadcastSettings(config);
    this.queue = new Queue<BroadcastJobData>(this.settings.queueName, { connection: this.settings.connection });
    this.queue.on('error', (err) => this.logger.error(`announcement_broadcast_queue_error (code: ${errorCode(err)})`));
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
  }

  /** Best effort: a lost job is replaced by the reconciler once the run's lease has lapsed. */
  async enqueue(runId: string, at = new Date()): Promise<boolean> {
    try {
      await withTimeout(
        this.queue.add(
          'drive',
          { runId },
          {
            jobId: `announcement-run-${runId}-${at.getTime()}`,
            delay: Math.max(0, at.getTime() - Date.now()),
            // A failed slice is not retried by BullMQ: the reconciler resumes the run.
            attempts: 1,
            removeOnComplete: true,
            removeOnFail: { age: 7 * 24 * 3600, count: 1000 },
          },
        ),
      );
      return true;
    } catch (err) {
      this.logger.warn(`announcement_broadcast_queue_add_failed run ${runId} (code: ${errorCode(err)}); the reconciler will retry`);
      return false;
    }
  }

  /** Reconciler: active runs nobody is driving or that are due to resume (lost job, crashed worker). Bounded. */
  async enqueueIdle(now = new Date()): Promise<number> {
    const runs = await this.prisma.announcementSendRun.findMany({
      where: { status: { in: ACTIVE_RUN }, OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }] },
      orderBy: { createdAt: 'asc' },
      take: 20,
      select: { id: true },
    });
    let queued = 0;
    for (const { id } of runs) if (await this.enqueue(id, now)) queued++;
    return queued;
  }
}
