import { Injectable, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Job, Worker } from 'bullmq';
import { isUUID } from 'class-validator';
import { EmailProvider } from '../email/email-provider.js';
import { EmailModule } from '../email/email.module.js';
import { deadLetterAlert } from '../email/email-templates.js';
import {
  DeadLetterStatus,
  OpsAlertStatus,
} from '../generated/prisma/client.js';
import { errorCode, PrismaService } from '../prisma/prisma.service.js';

/** Stable public queue names (the admin allowlist), not the Redis names. */
export const DEAD_LETTER_QUEUES = [
  'message-release',
  'death-verification',
  'email-delivery',
] as const;
export type DeadLetterQueue = (typeof DEAD_LETTER_QUEUES)[number];

/**
 * The one sanitizer for job failure text (admin failed-jobs view and dead
 * letters): first line only (no stack), no URLs (connection strings carry
 * credentials), no email addresses, no `secret=value` pairs, max 200 chars.
 */
export const sanitizeFailedReason = (reason?: string | null) =>
  (reason ?? '')
    .split('\n')[0]
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[url]')
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[email]')
    .replace(
      /\b(pass(word)?|secret|token|api[-_]?key|authorization|otp|session(id)?)\b\s*[:=]\s*\S+/gi,
      '$1=[redacted]',
    )
    .replace(/\bbearer\s+\S+/gi, 'Bearer [redacted]')
    .slice(0, 200) || null;

const SAFE_CODE = /^[A-Za-z0-9_.-]{1,64}$/;

/** A short category: provider / Prisma / driver code, else the error class. */
export const safeErrorCode = (err: unknown): string => {
  const db = errorCode(err);
  const name = (err as { name?: unknown } | null)?.name;
  for (const c of [db === 'UNKNOWN' ? undefined : db, name]) {
    if (typeof c === 'string' && SAFE_CODE.test(c)) return c;
  }
  return 'unknown_error';
};

/** BullMQ (6.x) emits `failed` after every attempt; this is the last one. */
export const isTerminalFailure = (job: Job, err: Error | undefined) =>
  err?.name === 'UnrecoverableError' ||
  job.attemptsMade >= (job.opts.attempts ?? 1);

type JobIds = Partial<
  Record<'messageId' | 'occurrenceId' | 'caseId' | 'notificationId', unknown>
>;
// The canonical business entity behind each queue's id-only payload.
const ENTITY: Record<DeadLetterQueue, (d: JobIds) => [string, unknown]> = {
  'message-release': (d) =>
    d.occurrenceId
      ? ['MessageRecipientRelease', d.occurrenceId]
      : ['Message', d.messageId],
  'death-verification': (d) => ['DeathVerificationCase', d.caseId],
  'email-delivery': (d) => ['ReleaseNotification', d.notificationId],
};

// Worker outcomes are short categories (released, stale, already_sent, …).
const OUTCOME = /^[a-z_]{1,40}$/;

/**
 * Phase 17A. Durable dead letters in PostgreSQL for jobs whose automatic
 * retries are exhausted, plus one operational alert per new terminal failure.
 * BullMQ's failed set stays as a short-term view only.
 *
 * Idempotent by the (queueName, jobId) unique key: a repeated callback for the
 * same failure changes nothing; a new terminal failure after a requeue reopens
 * the row and alerts once more. Never throws into the worker.
 */
@Injectable()
export class DeadLetterService {
  private readonly logger = new Logger(DeadLetterService.name);
  private readonly alertTo: string | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailProvider,
    config: ConfigService,
  ) {
    this.alertTo = config.get<string>('OPS_ALERT_EMAIL')?.trim() || null;
    if (this.alertTo && !/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(this.alertTo))
      throw new Error('OPS_ALERT_EMAIL must be an email address.');
  }

  /** Hooks a worker: terminal failure → dead letter; completion → resolved. */
  watch(worker: Worker, queue: DeadLetterQueue): void {
    worker.on('failed', (job, err) => {
      if (job && isTerminalFailure(job, err)) void this.record(queue, job, err);
    });
    worker.on('completed', (job, result) => {
      if (job.id) void this.resolve(queue, job.id, result);
    });
  }

  /** Returns the row id when this call opened it (and alerted), else null. */
  async record(
    queue: DeadLetterQueue,
    job: Job,
    err: Error | undefined,
  ): Promise<string | null> {
    try {
      const jobId = String(job.id);
      const key = { queueName: queue, jobId };
      // Same failure seen twice → same failedAt → no second update or alert.
      const failure = {
        attemptsMade: job.attemptsMade,
        errorCode: safeErrorCode(err),
        errorMessage: sanitizeFailedReason(err?.message),
        failedAt: new Date(job.finishedOn ?? Date.now()),
      };
      const [entityType, entityId] = ENTITY[queue]((job.data ?? {}) as JobIds);
      const { count: created } = await this.prisma.deadLetterJob.createMany({
        data: [
          {
            ...key,
            ...failure,
            jobName: job.name,
            entityType,
            entityId:
              typeof entityId === 'string' && isUUID(entityId) ? entityId : null,
          },
        ],
        skipDuplicates: true,
      });
      let opened = created === 1;
      if (!opened) {
        // Failed again after a requeue or resolve: reopen and alert once.
        const newer = { ...key, failedAt: { lt: failure.failedAt } };
        const { count } = await this.prisma.deadLetterJob.updateMany({
          where: { ...newer, status: { not: DeadLetterStatus.OPEN } },
          data: {
            ...failure,
            failureCount: { increment: 1 },
            status: DeadLetterStatus.OPEN,
            resolution: null,
            resolvedAt: null,
            alertStatus: OpsAlertStatus.PENDING,
            alertedAt: null,
          },
        });
        opened = count === 1;
        // Still open (e.g. the release reconciler re-ran it): count, no alert.
        if (!opened)
          await this.prisma.deadLetterJob.updateMany({
            where: { ...newer, status: DeadLetterStatus.OPEN },
            data: { ...failure, failureCount: { increment: 1 } },
          });
      }
      const row = await this.prisma.deadLetterJob.findUniqueOrThrow({
        where: { queueName_jobId: key },
      });
      this.logger.error(
        `dead_letter_recorded queue ${queue} job ${jobId} deadLetter ${row.id} attempts ${job.attemptsMade} (code: ${failure.errorCode})${opened ? '' : ' already open'}`,
      );
      if (!opened) return null;
      await this.alert(row);
      return row.id;
    } catch (e) {
      // The job's own failure handling is unchanged; nothing was recorded.
      this.logger.error(
        `dead_letter_record_failed queue ${queue} job ${job.id} (code: ${errorCode(e)})`,
      );
      return null;
    }
  }

  /** A run of this job id completed: close any dead letter for it. */
  async resolve(
    queue: DeadLetterQueue,
    jobId: string,
    result: unknown,
  ): Promise<void> {
    const resolution =
      typeof result === 'string' && OUTCOME.test(result) ? result : 'completed';
    try {
      const { count } = await this.prisma.deadLetterJob.updateMany({
        where: {
          queueName: queue,
          jobId,
          status: { not: DeadLetterStatus.RESOLVED },
        },
        data: {
          status: DeadLetterStatus.RESOLVED,
          resolvedAt: new Date(),
          resolution,
        },
      });
      if (count)
        this.logger.log(
          `dead_letter_resolved queue ${queue} job ${jobId} (${resolution})`,
        );
    } catch (e) {
      this.logger.warn(
        `dead_letter_resolve_failed queue ${queue} job ${jobId} (code: ${errorCode(e)})`,
      );
    }
  }

  /**
   * One direct send, never through a queue: if email-delivery itself is down,
   * its alert fails here once and is logged; it cannot feed the queue back.
   */
  private async alert(row: {
    id: string;
    queueName: string;
    jobId: string;
    entityType: string;
    entityId: string | null;
    attemptsMade: number;
    errorCode: string | null;
    failedAt: Date;
    failureCount: number;
  }): Promise<void> {
    let status: OpsAlertStatus = OpsAlertStatus.NOT_CONFIGURED;
    if (!this.alertTo) {
      this.logger.warn(
        `ops_alert_not_configured deadLetter ${row.id} queue ${row.queueName}: set OPS_ALERT_EMAIL`,
      );
    } else {
      try {
        await this.email.send({
          kind: 'ops-alert',
          to: this.alertTo,
          idempotencyKey: `dead-letter/${row.id}/${row.failureCount}`,
          ...deadLetterAlert(row),
        });
        status = OpsAlertStatus.SENT;
        this.logger.log(`ops_alert_sent deadLetter ${row.id}`);
      } catch (e) {
        status = OpsAlertStatus.FAILED;
        this.logger.error(
          `ops_alert_failed deadLetter ${row.id} (code: ${safeErrorCode(e)})`,
        );
      }
    }
    // ponytail: a crash right here leaves alertStatus PENDING (visible in the
    // admin view); add an alert reconciler if that ever matters.
    await this.prisma.deadLetterJob.update({
      where: { id: row.id },
      data: {
        alertStatus: status,
        alertedAt: status === OpsAlertStatus.SENT ? new Date() : null,
      },
    });
  }
}

@Module({
  imports: [EmailModule],
  providers: [DeadLetterService],
  exports: [DeadLetterService],
})
export class DeadLetterModule {}
