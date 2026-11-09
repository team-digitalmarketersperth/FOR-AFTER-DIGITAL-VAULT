import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { type Job, Worker } from 'bullmq';
import { isUUID } from 'class-validator';
import { writeAuditLog } from '../audit/audit-log.service.js';
import { maskEmail } from '../auth/dto/register.dto.js';
import { EmailProvider, EmailSendError } from '../email/email-provider.js';
import { announcement } from '../email/email-templates.js';
import { EmailConfig } from '../email/email.module.js';
import { AuditActorType, AuditEventType, type AnnouncementTestStatus } from '../generated/prisma/client.js';
import { withTimeout } from '../message-release/message-release-queue.service.js';
import { errorCode, PrismaService } from '../prisma/prisma.service.js';
import { ANNOUNCEMENT_DESTINATIONS, type AnnouncementDestination } from './announcements.dto.js';
import { type AnnouncementTestJobData, AnnouncementTestQueue, PROCESSING_STALE_MS } from './announcement-test-queue.service.js';

// Failures that prove the provider did not accept the email (rejected before or
// at the door), so another attempt cannot make a duplicate. Every other
// retryable error (timeout, network, 5xx) may have been accepted: UNKNOWN.
export const NOT_ACCEPTED_RETRYABLE = new Set(['rate_limit_exceeded', 'unauthorized', 'token_unavailable']);

export type TestOutcome = 'accepted' | 'failed' | 'unknown' | 'retry' | 'skipped';

/**
 * Worker for `announcement-test-email` (worker process only). Re-reads
 * PostgreSQL every time and sends the row's own snapshot, never the live draft.
 * Claims QUEUED → PROCESSING first; a row already PROCESSING means an earlier
 * attempt may have sent, so it becomes UNKNOWN instead of being sent again.
 */
@Injectable()
export class AnnouncementTestProcessor implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(AnnouncementTestProcessor.name);
  private worker?: Worker<AnnouncementTestJobData>;
  private timer?: NodeJS.Timeout;
  private reconciling?: Promise<unknown>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: AnnouncementTestQueue,
    private readonly email: EmailProvider,
    private readonly config: EmailConfig,
  ) {}

  async onModuleInit(): Promise<void> {
    const { queueName, connection } = this.queue.settings;
    this.worker = new Worker<AnnouncementTestJobData>(queueName, (job) => this.process(job), { connection });
    this.worker.on('error', (err) => this.logger.error(`Announcement test worker error (code: ${errorCode(err)})`));
    await withTimeout(this.worker.waitUntilReady());
    this.logger.log('announcement-test-email worker ready');
  }

  onApplicationBootstrap(): void {
    const tick = () => void (this.reconciling = this.reconcile());
    tick();
    this.timer = setInterval(tick, this.queue.settings.reconcileIntervalMs);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.timer);
    await this.worker?.close();
    await this.reconciling;
  }

  /** Re-queue QUEUED rows that missed their job; settle sends that died mid-flight as UNKNOWN. */
  async reconcile(now = new Date()): Promise<void> {
    try {
      const stuck = await this.prisma.announcementTestSend.findMany({
        where: { status: 'PROCESSING', updatedAt: { lte: new Date(now.getTime() - PROCESSING_STALE_MS) } },
        take: 50,
        select: { id: true },
      });
      for (const { id } of stuck) await this.finish(id, 'PROCESSING', 'UNKNOWN', 'worker_interrupted');
      const queued = await this.queue.enqueueStale(now);
      if (queued || stuck.length) this.logger.log(`announcement_test_reconciled queued ${queued} unknown ${stuck.length}`);
    } catch (err) {
      this.logger.error(`announcement_test_reconcile_error (code: ${errorCode(err)})`);
    }
  }

  async process(job: Job<AnnouncementTestJobData>): Promise<TestOutcome> {
    const id = job.data?.testSendId;
    if (typeof id !== 'string' || !isUUID(id)) return 'skipped';
    const { count } = await this.prisma.announcementTestSend.updateMany({
      where: { id, status: 'QUEUED' },
      data: { status: 'PROCESSING', attemptCount: { increment: 1 } },
    });
    if (!count) {
      // Already settled → nothing to do. Still PROCESSING → an earlier attempt may have sent it.
      const settled = await this.finish(id, 'PROCESSING', 'UNKNOWN', 'worker_interrupted');
      return settled ? 'unknown' : 'skipped';
    }
    const row = await this.prisma.announcementTestSend.findUniqueOrThrow({ where: { id } });
    const path = row.ctaDestination ? ANNOUNCEMENT_DESTINATIONS[row.ctaDestination as AnnouncementDestination] : null;
    if (row.ctaDestination && !path) {
      await this.finish(id, 'PROCESSING', 'FAILED', 'invalid_destination');
      return 'failed';
    }
    let providerMessageId: string | null | undefined;
    try {
      ({ providerMessageId } = await this.email.send({
        kind: 'announcement-test',
        to: row.toEmail,
        idempotencyKey: `announcement-test/${id}`,
        ...announcement(
          { subject: row.subject, body: row.body, cta: path ? { label: row.ctaLabel!, path } : null },
          this.config.settings.appBaseUrl,
          true,
        ),
      }));
    } catch (err) {
      // Not one of the provider's classified failures, so nothing proves it was not accepted.
      if (!(err instanceof EmailSendError)) {
        await this.finish(id, 'PROCESSING', 'UNKNOWN', 'unknown_error');
        return 'unknown';
      }
      const { code, retryable } = err;
      if (!retryable) {
        await this.finish(id, 'PROCESSING', 'FAILED', code);
        return 'failed';
      }
      if (!NOT_ACCEPTED_RETRYABLE.has(code)) {
        // Possibly accepted (Graph has no idempotency key): never retried automatically.
        await this.finish(id, 'PROCESSING', 'UNKNOWN', code);
        return 'unknown';
      }
      if (job.attemptsMade + 1 >= (job.opts.attempts ?? 1)) {
        await this.finish(id, 'PROCESSING', 'FAILED', code);
        return 'failed';
      }
      // Provably not accepted: back to QUEUED, and BullMQ retries with backoff.
      await this.prisma.announcementTestSend.updateMany({ where: { id, status: 'PROCESSING' }, data: { status: 'QUEUED', lastErrorCode: code } });
      throw Object.assign(new Error(`email_send_failed: ${code}`), { code });
    }
    // The provider accepted it. A database error here must not become a send failure: it propagates, the row stays
    // PROCESSING, and the job retry or the reconciler settles it as UNKNOWN (never sent again).
    await this.finish(id, ['PROCESSING', 'UNKNOWN'], 'ACCEPTED', null, providerMessageId);
    this.logger.log(`announcement_test_accepted test ${id} to ${maskEmail(row.toEmail)}`);
    return 'accepted';
  }

  /** Moves a row out of `from` once (conditional update), with its completion audit row. Returns whether it moved. */
  private async finish(
    id: string,
    from: AnnouncementTestStatus | AnnouncementTestStatus[],
    to: 'ACCEPTED' | 'FAILED' | 'UNKNOWN',
    code: string | null,
    providerMessageId?: string | null,
  ): Promise<boolean> {
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.announcementTestSend.updateMany({
        where: { id, status: { in: ([] as AnnouncementTestStatus[]).concat(from) } },
        data: {
          status: to,
          lastErrorCode: code,
          finishedAt: now,
          ...(to === 'ACCEPTED' ? { acceptedAt: now, providerMessageId: providerMessageId ?? null } : {}),
        },
      });
      if (!count) return false;
      const row = await tx.announcementTestSend.findUniqueOrThrow({
        where: { id },
        select: { announcementId: true, announcementVersion: true, requestedByUserId: true },
      });
      await writeAuditLog(tx, {
        eventType: AuditEventType.ANNOUNCEMENT_TEST_COMPLETED,
        actor: { type: AuditActorType.SYSTEM, userId: null },
        subjectType: 'AnnouncementTestSend',
        subjectId: id,
        metadata: {
          announcementId: row.announcementId,
          version: row.announcementVersion,
          requestedBy: row.requestedByUserId,
          outcome: to.toLowerCase(),
          errorCategory: code,
        },
      });
      if (to !== 'ACCEPTED') this.logger.warn(`announcement_test_${to.toLowerCase()} test ${id} (code: ${code})`);
      return true;
    });
  }
}
