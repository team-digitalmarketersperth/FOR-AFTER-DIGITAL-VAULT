import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { DelayedError, type Job, Worker } from 'bullmq';
import { isUUID } from 'class-validator';
import { DeadLetterService } from '../dead-letters/dead-letter.service.js';
import { errorCode } from '../prisma/prisma.service.js';
import { ReleaseNotificationQueue } from '../release-notifications/release-notification-queue.service.js';
import {
  MessageReleaseQueue,
  type ReleaseJobData,
  withTimeout,
} from './message-release-queue.service.js';
import {
  MessageReleaseService,
  type ReleaseOutcome,
} from './message-release.service.js';

/**
 * BullMQ worker for release jobs. Thin: the decision is always made by
 * MessageReleaseService against PostgreSQL. Logs ids and outcome categories
 * only, never message content or recipient data. Worker process only (Phase 17B).
 */
@Injectable()
export class MessageReleaseProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MessageReleaseProcessor.name);
  private worker?: Worker<ReleaseJobData>;

  constructor(
    private readonly releases: MessageReleaseService,
    private readonly queue: MessageReleaseQueue,
    private readonly notifications: ReleaseNotificationQueue,
    private readonly deadLetters: DeadLetterService,
  ) {}

  async onModuleInit(): Promise<void> {
    const { queueName, connection } = this.queue.settings;
    this.worker = new Worker<ReleaseJobData>(
      queueName,
      (job, token) => this.process(job, token),
      { connection },
    );
    this.worker.on('error', (err) =>
      this.logger.error(`Release worker error (code: ${errorCode(err)})`),
    );
    // Exhausted → dead letter + alert. The message stays SCHEDULED and the
    // reconciler queues it again; a later success resolves the dead letter.
    this.deadLetters.watch(this.worker, 'message-release');
    // Fail fast: a worker process that cannot reach queue Redis is useless.
    await withTimeout(this.worker.waitUntilReady());
    this.logger.log('message-release worker ready');
  }

  async onModuleDestroy(): Promise<void> {
    // Waits for an active job to finish.
    await this.worker?.close();
  }

  async process(
    job: Job<ReleaseJobData>,
    token?: string,
  ): Promise<ReleaseOutcome['result']> {
    const { messageId, occurrenceId } = job.data ?? {};
    const ctx = `message ${messageId} job ${job.id} attempt ${job.attemptsMade + 1}`;
    if (
      typeof messageId !== 'string' ||
      !isUUID(messageId) ||
      (occurrenceId !== undefined && !isUUID(occurrenceId))
    ) {
      this.logger.warn(`release_stale_job job ${job.id}: invalid payload`);
      return 'stale';
    }

    let outcome: ReleaseOutcome;
    try {
      outcome = occurrenceId
        ? await this.releases.releaseOccurrence(occurrenceId)
        : await this.releases.release(messageId);
    } catch (err) {
      // Thrown so BullMQ retries with backoff. Never falls back to Redis data.
      this.logger.warn(
        `release_retryable_failure ${ctx} (code: ${errorCode(err)})`,
      );
      throw err;
    }

    switch (outcome.result) {
      case 'released':
      case 'occurrence_released':
        this.logger.log(
          `release_success ${ctx} trigger ${outcome.triggerType} scheduledFor ${outcome.scheduledFor.toISOString()}${occurrenceId ? ` occurrence ${occurrenceId}` : ''}`,
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
