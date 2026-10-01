import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { DelayedError, type Job, Queue, Worker } from 'bullmq';
import { isUUID } from 'class-validator';
import {
  DeathVerificationCaseStatus as Status,
  MessageStatus,
} from '../generated/prisma/client.js';
import {
  MessageReleaseQueue,
  PENDING_JOB_STATES,
  withTimeout,
} from '../message-release/message-release-queue.service.js';
import { errorCode, PrismaService } from '../prisma/prisma.service.js';
import {
  DEATH_TRIGGERS,
  DeathVerificationWorkflow,
} from './death-verification-workflow.service.js';

// The only thing stored in Redis: no names, notes or report data.
export interface SafeguardJobData {
  caseId: string;
}

// BullMQ rejects custom ids with a single ':', so '-' instead of ':'.
export const safeguardJobId = (caseId: string) =>
  `death-verification-safeguard-${caseId}`;

const JOB_NAME = 'safeguard';

export interface DeathReconcileResult {
  notices: number;
  safeguards: number;
  activations: number;
  failed: number;
}

/**
 * Executes the death-verification workflow. PostgreSQL is the source of
 * truth; BullMQ only wakes the worker when a safeguard window ends, and the
 * reconciler (startup + every DEATH_VERIFICATION_RECONCILE_INTERVAL_SECONDS)
 * rebuilds everything from PostgreSQL:
 *  - PENDING cases whose safety notice was never sent (incl. Step 14 cases),
 *  - SAFEGUARD_ACTIVE cases (overdue → advanced now; otherwise job ensured),
 *  - VERIFIED cases whose death-trigger activation is missing or incomplete.
 * Message release jobs stay in the Step 12 message-release queue.
 */
@Injectable()
export class DeathVerificationQueue
  implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(DeathVerificationQueue.name);
  // Also used by the admin queue monitor (Step 16): counts, failed jobs, retry.
  readonly queue: Queue<SafeguardJobData>;
  private worker?: Worker<SafeguardJobData>;
  private timer?: NodeJS.Timeout;
  private running?: Promise<DeathReconcileResult>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly workflow: DeathVerificationWorkflow,
    private readonly releases: MessageReleaseQueue,
  ) {
    const { queueName, connection } = workflow.settings;
    this.queue = new Queue<SafeguardJobData>(queueName, {
      connection: { ...connection, enableOfflineQueue: false },
    });
    this.queue.on('error', (err) =>
      this.logger.error(
        `Death verification queue error (code: ${errorCode(err)})`,
      ),
    );
  }

  onModuleInit(): void {
    const { queueName, connection } = this.workflow.settings;
    this.worker = new Worker<SafeguardJobData>(
      queueName,
      (job, token) => this.process(job, token),
      { connection },
    );
    this.worker.on('error', (err) =>
      this.logger.error(
        `Death verification worker error (code: ${errorCode(err)})`,
      ),
    );
  }

  onApplicationBootstrap(): void {
    void this.reconcile();
    this.timer = setInterval(
      () => void this.reconcile(),
      this.workflow.settings.reconcileIntervalMs,
    );
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.timer);
    await this.worker?.close();
    await this.queue.close();
  }

  /** After a report: send the notice and start the safeguard. Never throws. */
  async afterReport(caseId: string): Promise<void> {
    try {
      await this.startSafeguard(caseId);
    } catch (err) {
      this.logger.warn(
        `death_safeguard_start_deferred case ${caseId} (code: ${errorCode(err)}); the reconciler will retry`,
      );
    }
  }

  /** After admin verification: build activations and queue releases. Never throws. */
  async afterVerify(caseId: string): Promise<void> {
    try {
      await this.activate(caseId);
    } catch (err) {
      this.logger.warn(
        `death_trigger_activation_deferred case ${caseId} (code: ${errorCode(err)}); the reconciler will retry`,
      );
    }
  }

  async process(job: Job<SafeguardJobData>, token?: string): Promise<string> {
    const caseId = job.data?.caseId;
    if (typeof caseId !== 'string' || !isUUID(caseId)) {
      this.logger.warn(
        `death_safeguard_stale_job job ${job.id}: invalid payload`,
      );
      return 'stale';
    }
    const outcome = await this.workflow.elapseSafeguard(caseId);
    if (outcome.result === 'not_due') {
      // Fired early: back to delayed for the stored time.
      await job.moveToDelayed(outcome.dueAt.getTime(), token);
      throw new DelayedError();
    }
    if (outcome.result === 'stale') {
      this.logger.log(
        `death_safeguard_stale_job case ${caseId}: ${outcome.reason}`,
      );
    }
    return outcome.result;
  }

  // One run at a time per instance; a call during a run joins it.
  reconcile(now = new Date()): Promise<DeathReconcileResult> {
    this.running ??= this.run(now).finally(() => (this.running = undefined));
    return this.running;
  }

  private async run(now: Date): Promise<DeathReconcileResult> {
    const result = { notices: 0, safeguards: 0, activations: 0, failed: 0 };
    let cases: {
      id: string;
      status: Status;
      safeguardEndsAt: Date | null;
    }[];
    try {
      // ponytail: unpaginated; open death cases are few. Page by openedAt if not.
      cases = await this.prisma.deathVerificationCase.findMany({
        where: {
          OR: [
            {
              status: Status.PENDING_VERIFICATION,
              safetyNoticeSentAt: null,
              reports: { some: {} },
            },
            { status: Status.SAFEGUARD_ACTIVE },
            {
              status: Status.VERIFIED,
              OR: [
                { deathTriggersActivatedAt: null },
                {
                  owner: {
                    messages: {
                      some: {
                        status: MessageStatus.SCHEDULED,
                        deletedAt: null,
                        deathActivation: { is: null },
                        schedule: { triggerType: { in: DEATH_TRIGGERS } },
                      },
                    },
                  },
                },
              ],
            },
          ],
        },
        select: { id: true, status: true, safeguardEndsAt: true },
      });
    } catch (err) {
      this.logger.error(`death_reconciliation_error (code: ${errorCode(err)})`);
      return result;
    }

    for (const kase of cases) {
      try {
        if (kase.status === Status.PENDING_VERIFICATION) {
          if (await this.startSafeguard(kase.id, now)) result.notices++;
        } else if (kase.status === Status.SAFEGUARD_ACTIVE) {
          if (kase.safeguardEndsAt && kase.safeguardEndsAt <= now) {
            await this.workflow.elapseSafeguard(kase.id, now);
          } else if (kase.safeguardEndsAt) {
            await this.ensureSafeguardJob(kase.id, kase.safeguardEndsAt, now);
          }
          result.safeguards++;
        } else {
          await this.activate(kase.id);
          result.activations++;
        }
      } catch (err) {
        // One failure never stops the rest; PostgreSQL stays authoritative.
        result.failed++;
        this.logger.warn(
          `death_reconciliation_error case ${kase.id} (code: ${errorCode(err)})`,
        );
      }
    }
    return result;
  }

  // True if the safeguard started (notice sent).
  private async startSafeguard(caseId: string, now?: Date): Promise<boolean> {
    const started = await this.workflow.startSafeguard(caseId, now);
    if (started.result !== 'started') return false;
    // Best effort: if Redis is down the reconciler recreates the job.
    await this.ensureSafeguardJob(
      caseId,
      started.safeguardEndsAt,
      now ?? new Date(),
    ).catch((err: unknown) =>
      this.logger.warn(
        `death_safeguard_queue_failed case ${caseId} (code: ${errorCode(err)})`,
      ),
    );
    return true;
  }

  // Keeps one delayed job that fires no later than safeguardEndsAt.
  private ensureSafeguardJob(caseId: string, endsAt: Date, now: Date) {
    return withTimeout(
      (async () => {
        const jobId = safeguardJobId(caseId);
        const job = await this.queue.getJob(jobId);
        if (job) {
          const state = await job.getState();
          const firesAt = job.timestamp + (job.opts.delay ?? 0);
          if (
            state === 'active' ||
            (PENDING_JOB_STATES.has(state) &&
              firesAt <= endsAt.getTime() + 1000)
          ) {
            return;
          }
          await this.queue.remove(jobId);
        }
        await this.queue.add(
          JOB_NAME,
          { caseId },
          {
            jobId,
            delay: Math.max(0, endsAt.getTime() - now.getTime()),
            attempts: this.workflow.settings.attempts,
            backoff: {
              type: 'exponential',
              delay: this.workflow.settings.backoffMs,
            },
            removeOnComplete: { age: 24 * 3600, count: 1000 },
            removeOnFail: { age: 7 * 24 * 3600, count: 1000 },
          },
        );
      })(),
    );
  }

  // VERIFIED case → activation rows (PostgreSQL) → message-release jobs.
  private async activate(caseId: string): Promise<void> {
    const waiting = await this.workflow.activateTriggers(caseId);
    for (const { messageId, dueAt } of waiting ?? []) {
      // The message-release reconciler repairs any job that fails here.
      await this.releases
        .ensure(messageId, dueAt)
        .then((queued) => {
          if (queued) {
            this.logger.log(
              `death_trigger_release_queued case ${caseId} message ${messageId} due ${dueAt.toISOString()}`,
            );
          }
        })
        .catch((err: unknown) =>
          this.logger.warn(
            `death_trigger_release_queue_failed message ${messageId} (code: ${errorCode(err)})`,
          ),
        );
    }
  }
}
