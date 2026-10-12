import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { DelayedError, type Job, Worker } from 'bullmq';
import { isUUID } from 'class-validator';
import { DeadLetterService } from '../dead-letters/dead-letter.service.js';
import { withTimeout } from '../message-release/message-release-queue.service.js';
import { errorCode } from '../prisma/prisma.service.js';
import {
  DeathVerificationQueue,
  type SafeguardJobData,
} from './death-verification-queue.service.js';
import { DeathVerificationWorkflow } from './death-verification-workflow.service.js';

/**
 * Worker process only (Phase 17B): consumes safeguard jobs and runs the
 * death-verification reconciler at startup and on an interval. The workflow
 * decides everything against PostgreSQL.
 */
@Injectable()
export class DeathVerificationProcessor
  implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(DeathVerificationProcessor.name);
  private worker?: Worker<SafeguardJobData>;
  private timer?: NodeJS.Timeout;
  private reconciling?: Promise<unknown>;

  constructor(
    private readonly queue: DeathVerificationQueue,
    private readonly workflow: DeathVerificationWorkflow,
    private readonly deadLetters: DeadLetterService,
  ) {}

  async onModuleInit(): Promise<void> {
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
    this.deadLetters.watch(this.worker, 'death-verification');
    // Fail fast: a worker process that cannot reach queue Redis is useless.
    await withTimeout(this.worker.waitUntilReady());
    this.logger.log('death-verification worker ready');
  }

  // After every worker is ready (onModuleInit), so nothing is queued unconsumed.
  onApplicationBootstrap(): void {
    const tick = () => void (this.reconciling = this.queue.reconcile());
    tick();
    this.timer = setInterval(tick, this.workflow.settings.reconcileIntervalMs);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.timer);
    // Waits for an active job and a running reconcile before Prisma closes.
    await this.worker?.close();
    await this.reconciling;
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
}
