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
 * FIXED_DATE message, and every VERIFIED death-trigger activation (Step 15),
 * due within the lookahead window gets a job; overdue ones
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

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: MessageReleaseQueue,
  ) {}

  // A plain in-process timer is enough: it only triggers a re-scan, and
  // PostgreSQL holds every schedule, so a missed tick loses nothing.
  onApplicationBootstrap(): void {
    void this.reconcile();
    this.timer = setInterval(
      () => void this.reconcile(),
      this.queue.settings.reconcileIntervalMs,
    );
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  // One run at a time per instance; a call during a run joins it.
  reconcile(now = new Date()): Promise<ReconcileResult> {
    this.running ??= this.run(now).finally(() => (this.running = undefined));
    return this.running;
  }

  private async run(now: Date): Promise<ReconcileResult> {
    const result = { checked: 0, enqueued: 0, failed: 0 };
    let due: { messageId: string; scheduledFor: Date | null }[];
    try {
      // ponytail: unpaginated; page by scheduledFor if thousands fall due in one window.
      const fixedDate = await this.prisma.messageSchedule.findMany({
        where: {
          triggerType: ReleaseTriggerType.FIXED_DATE,
          scheduledFor: {
            lte: new Date(now.getTime() + this.queue.settings.lookaheadMs),
          },
          message: { status: MessageStatus.SCHEDULED, deletedAt: null },
        },
        select: { messageId: true, scheduledFor: true },
        orderBy: { scheduledFor: 'asc' },
      });
      // Step 15: VERIFIED death-trigger activations, same lookahead rule.
      const activations =
        await this.prisma.deathTriggeredMessageActivation.findMany({
          where: {
            dueAt: {
              lte: new Date(now.getTime() + this.queue.settings.lookaheadMs),
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
        ...fixedDate,
        ...activations.map((a) => ({
          messageId: a.messageId,
          scheduledFor: a.dueAt,
        })),
      ];
    } catch (err) {
      this.logger.error(`reconciliation_error (code: ${errorCode(err)})`);
      return result;
    }

    for (const { messageId, scheduledFor } of due) {
      if (!scheduledFor) continue;
      result.checked++;
      try {
        if (await this.queue.ensure(messageId, scheduledFor, now)) {
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
