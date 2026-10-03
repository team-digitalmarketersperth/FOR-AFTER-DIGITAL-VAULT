import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { type Job, UnrecoverableError, Worker } from 'bullmq';
import { isUUID } from 'class-validator';
import { maskEmail } from '../auth/dto/register.dto.js';
import { EmailProvider, EmailSendError } from '../email/email-provider.js';
import { messageReleased } from '../email/email-templates.js';
import { EmailConfig } from '../email/email.module.js';
import { errorCode, PrismaService } from '../prisma/prisma.service.js';
import {
  type NotificationJobData,
  ReleaseNotificationQueue,
} from './release-notification-queue.service.js';

export type NotificationOutcome = 'sent' | 'already_sent' | 'stale';

/**
 * Worker for the `email-delivery` queue. Re-reads PostgreSQL every time: sends
 * only for a RELEASED message and a row not already SENT, then records the
 * result. Transient provider errors are retried with backoff; permanent ones
 * (invalid address, unverified sender, …) fail at once and stay visible in
 * the admin failed-jobs view. A failed email never touches the release: the
 * Recipient can still sign in and read the message.
 */
@Injectable()
export class ReleaseNotificationProcessor
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(ReleaseNotificationProcessor.name);
  private worker?: Worker<NotificationJobData>;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: ReleaseNotificationQueue,
    private readonly email: EmailProvider,
    private readonly config: EmailConfig,
  ) {}

  onModuleInit(): void {
    const { queueName, connection, reconcileIntervalMs } = this.queue.settings;
    this.worker = new Worker<NotificationJobData>(
      queueName,
      (job) => this.process(job),
      { connection },
    );
    this.worker.on('error', (err) =>
      this.logger.error(`Email worker error (code: ${errorCode(err)})`),
    );
    this.worker.on('failed', (job, err) => {
      if (
        job &&
        (err instanceof UnrecoverableError ||
          job.attemptsMade >= (job.opts.attempts ?? 1))
      ) {
        this.logger.error(
          `release_notification_failed notification ${job.data.notificationId} job ${job.id} (${err.message})`,
        );
      }
    });
    void this.reconcile();
    this.timer = setInterval(() => void this.reconcile(), reconcileIntervalMs);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.timer);
    await this.worker?.close();
  }

  async reconcile(): Promise<void> {
    try {
      const queued = await this.queue.enqueueStale();
      if (queued) this.logger.log(`release_notification_reconciled ${queued}`);
    } catch (err) {
      this.logger.error(
        `release_notification_reconcile_error (code: ${errorCode(err)})`,
      );
    }
  }

  async process(job: Job<NotificationJobData>): Promise<NotificationOutcome> {
    const id = job.data?.notificationId;
    if (typeof id !== 'string' || !isUUID(id)) return 'stale';
    const row = await this.prisma.releaseNotification.findUnique({
      where: { id },
      select: {
        status: true,
        grant: {
          select: {
            recipientEmailNormalized: true,
            message: { select: { status: true } },
          },
        },
      },
    });
    const to = row?.grant.recipientEmailNormalized;
    if (!row || !to || row.grant.message.status !== 'RELEASED') return 'stale';
    if (row.status === 'SENT') return 'already_sent';

    try {
      const { providerMessageId } = await this.email.send({
        kind: 'message-released',
        to,
        // A retry after a lost response is not sent twice.
        idempotencyKey: `release-notification/${id}`,
        ...messageReleased(this.config.settings.appBaseUrl),
      });
      await this.prisma.releaseNotification.update({
        where: { id },
        data: {
          status: 'SENT',
          sentAt: new Date(),
          providerMessageId,
          attemptCount: { increment: 1 },
          lastErrorCode: null,
          failedAt: null,
        },
      });
      this.logger.log(
        `release_notification_sent notification ${id} to ${maskEmail(to)}`,
      );
      return 'sent';
    } catch (err) {
      const code = err instanceof EmailSendError ? err.code : 'unknown_error';
      const retryable = err instanceof EmailSendError ? err.retryable : true;
      const last =
        !retryable || job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      await this.prisma.releaseNotification.update({
        where: { id },
        data: {
          attemptCount: { increment: 1 },
          lastErrorCode: code,
          ...(last ? { status: 'FAILED' as const, failedAt: new Date() } : {}),
        },
      });
      // Safe category only: shown (sanitized) in the admin failed-jobs view.
      if (!retryable)
        throw new UnrecoverableError(`email_send_failed: ${code}`);
      throw new Error(`email_send_failed: ${code}`);
    }
  }
}
