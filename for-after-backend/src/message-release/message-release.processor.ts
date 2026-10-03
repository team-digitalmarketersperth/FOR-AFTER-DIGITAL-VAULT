import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { DelayedError, type Job, Worker } from 'bullmq';
import { isUUID } from 'class-validator';
import { errorCode } from '../prisma/prisma.service.js';
import { ReleaseNotificationQueue } from '../release-notifications/release-notification-queue.service.js';
import {
  MessageReleaseQueue,
  type ReleaseJobData,
} from './message-release-queue.service.js';
import {
  MessageReleaseService,
  type ReleaseOutcome,
} from './message-release.service.js';

/**
 * BullMQ worker for release jobs. Thin: the decision is always made by
 * MessageReleaseService against PostgreSQL. Logs ids and outcome categories
 * only, never message content or recipient data.
 */
@Injectable()
export class MessageReleaseProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MessageReleaseProcessor.name);
  private worker?: Worker<ReleaseJobData>;

  constructor(
    private readonly releases: MessageReleaseService,
    private readonly queue: MessageReleaseQueue,
    private readonly notifications: ReleaseNotificationQueue,
  ) {}

  onModuleInit(): void {
    const { queueName, connection } = this.queue.settings;
    this.worker = new Worker<ReleaseJobData>(
      queueName,
      (job, token) => this.process(job, token),
      { connection },
    );
    this.worker.on('error', (err) =>
      this.logger.error(`Release worker error (code: ${errorCode(err)})`),
    );
    // The message stays SCHEDULED; the reconciler queues it again.
    this.worker.on('failed', (job, err) => {
      if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
        this.logger.error(
          `release_retries_exhausted message ${job.data.messageId} job ${job.id} (code: ${errorCode(err)})`,
        );
      }
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }

  async process(
    job: Job<ReleaseJobData>,
    token?: string,
  ): Promise<ReleaseOutcome['result']> {
    const messageId = job.data?.messageId;
    const ctx = `message ${messageId} job ${job.id} attempt ${job.attemptsMade + 1}`;
    if (typeof messageId !== 'string' || !isUUID(messageId)) {
      this.logger.warn(`release_stale_job job ${job.id}: invalid payload`);
      return 'stale';
    }

    let outcome: ReleaseOutcome;
    try {
      outcome = await this.releases.release(messageId);
    } catch (err) {
      // Thrown so BullMQ retries with backoff. Never falls back to Redis data.
      this.logger.warn(
        `release_retryable_failure ${ctx} (code: ${errorCode(err)})`,
      );
      throw err;
    }

    switch (outcome.result) {
      case 'released':
        this.logger.log(
          `release_success ${ctx} trigger ${outcome.triggerType} scheduledFor ${outcome.scheduledFor.toISOString()}`,
        );
        this.logger.log(
          `recipient_release_grants_created ${ctx} count ${outcome.grants}`,
        );
        // Step 24: email the Recipients now. Never fails the release: a miss
        // is picked up by the notification reconciler.
        await this.notifications
          .enqueueForMessage(messageId)
          .catch((err) =>
            this.logger.warn(
              `release_notification_enqueue_failed ${ctx} (code: ${errorCode(err)})`,
            ),
          );
        break;
      case 'already_released':
        this.logger.log(`release_already_completed ${ctx}`);
        break;
      case 'stale':
        this.logger.log(`release_stale_job ${ctx}: ${outcome.reason}`);
        break;
      case 'blocked':
        this.logger.warn(`release_business_block ${ctx}: ${outcome.reason}`);
        break;
      case 'not_due':
        this.logger.log(
          `release_not_due ${ctx}: due ${outcome.dueAt.toISOString()}`,
        );
        // Back to delayed for the authoritative time; not a failure or retry.
        await job.moveToDelayed(outcome.dueAt.getTime(), token);
        throw new DelayedError();
    }
    return outcome.result;
  }
}
