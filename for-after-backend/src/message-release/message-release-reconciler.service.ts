import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import {
  DeathVerificationCaseStatus,
  MessageStatus,
  ReleaseTriggerType,
} from '../generated/prisma/client.js';
import { errorCode, PrismaService } from '../prisma/prisma.service.js';
import { MessageReleaseQueue } from './message-release-queue.service.js';

export interface ReconcileResult {
  checked: number;
  enqueued: number;
  failed: number;
}

/**
 * Rebuilds release jobs from PostgreSQL: at startup (Redis may have been
 * flushed) and then every RELEASE_RECONCILE_INTERVAL_SECONDS. Every scheduled
 * FIXED_DATE / CUSTOM_EVENT / NOW message, every VERIFIED ON_DEATH /
 * AFTER_DEATH activation (Step 15) and every pending per-Recipient yearly
 * occurrence (Phase 16) due within the lookahead window gets a job; overdue ones
 * run immediately. Safe to run on several instances at once: job ids are
 * deterministic and the worker re-checks PostgreSQL.
 */
@Injectable()
export class MessageReleaseReconciler
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(MessageReleaseReconciler.name);
  private timer?: NodeJS.Timeout;
  private running?: Promise<ReconcileResult>;
  private reconciling?: Promise<unknown>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: MessageReleaseQueue,
  ) {}

  // A plain in-process timer is enough: it only triggers a re-scan, and
  // PostgreSQL holds every schedule, so a missed tick loses nothing. Worker
  // process only (Phase 17B); runs after the release worker is ready.
  onApplicationBootstrap(): void {
    const tick = () => void (this.reconciling = this.reconcile());
    tick();
    this.timer = setInterval(tick, this.queue.settings.reconcileIntervalMs);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.timer);
    await this.reconciling;
  }

  // One run at a time per instance; a call during a run joins it.
  reconcile(now = new Date()): Promise<ReconcileResult> {
    this.running ??= this.run(now).finally(() => (this.running = undefined));
    return this.running;
  }

  private async run(now: Date): Promise<ReconcileResult> {
    const result = { checked: 0, enqueued: 0, failed: 0 };
    let due: {
      messageId: string;
      scheduledFor: Date | null;
      occurrenceId?: string;
    }[];
    const horizon = new Date(now.getTime() + this.queue.settings.lookaheadMs);
    try {
      // ponytail: unpaginated; page by scheduledFor if thousands fall due in one window.
      const fixedDate = await this.prisma.messageSchedule.findMany({
        where: {
          OR: [
            {
              triggerType: {
                in: [
                  ReleaseTriggerType.FIXED_DATE,
                  ReleaseTriggerType.CUSTOM_EVENT,
                ],
              },
              scheduledFor: { lte: horizon },
            },
            // NOW is due from the moment it was scheduled.
            { triggerType: ReleaseTriggerType.NOW },
          ],
          message: { status: MessageStatus.SCHEDULED, deletedAt: null },
        },
        select: { messageId: true, scheduledFor: true, createdAt: true },
        orderBy: { scheduledFor: 'asc' },
      });
      // Phase 16: pending yearly occurrences per Recipient. Bounded; the
      // (releasedAt, dueAt) index serves it, the rest wait for the next run.
      const occurrences = await this.prisma.messageRecipientRelease.findMany({
        where: {
          releasedAt: null,
          dueAt: { lte: horizon },
          message: { status: MessageStatus.SCHEDULED, deletedAt: null },
        },
        select: { id: true, messageId: true, dueAt: true },
        orderBy: { dueAt: 'asc' },
        take: 1000,
      });
      // Step 15: VERIFIED death-trigger activations, same lookahead rule.
      const activations =
        await this.prisma.deathTriggeredMessageActivation.findMany({
          where: {
            dueAt: {
              lte: new Date(now.getTime() + this.queue.settings.lookaheadMs),
            },
            // ANNUAL_AFTER_DEATH releases through its occurrences instead.
            triggerType: {
              in: [ReleaseTriggerType.ON_DEATH, ReleaseTriggerType.AFTER_DEATH],
            },
            deathVerificationCase: {
              status: DeathVerificationCaseStatus.VERIFIED,
            },
            message: { status: MessageStatus.SCHEDULED, deletedAt: null },
          },
          select: { messageId: true, dueAt: true },
          orderBy: { dueAt: 'asc' },
        });
      due = [
        ...fixedDate.map((s) => ({
          messageId: s.messageId,
          scheduledFor: s.scheduledFor ?? s.createdAt,
        })),
        ...activations.map((a) => ({
          messageId: a.messageId,
          scheduledFor: a.dueAt,
        })),
        ...occurrences.map((o) => ({
          messageId: o.messageId,
          scheduledFor: o.dueAt,
          occurrenceId: o.id,
        })),
      ];
    } catch (err) {
      this.logger.error(`reconciliation_error (code: ${errorCode(err)})`);
      return result;
    }

    for (const { messageId, scheduledFor, occurrenceId } of due) {
      if (!scheduledFor) continue;
      result.checked++;
      try {
        const queued = occurrenceId
          ? await this.queue.ensureOccurrence(
              messageId,
              occurrenceId,
              scheduledFor,
              now,
            )
          : await this.queue.ensure(messageId, scheduledFor, now);
        if (queued) {
          result.enqueued++;
        }
      } catch (err) {
        // One failure never stops the rest; PostgreSQL is untouched.
        result.failed++;
        this.logger.warn(
          `reconciliation_error message ${messageId} (code: ${errorCode(err)})`,
        );
      }
    }
    if (result.enqueued) {
      this.logger.log(`reconciliation_enqueued ${result.enqueued} job(s)`);
    }
    return result;
  }
}
