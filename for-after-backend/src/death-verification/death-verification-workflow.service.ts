import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { maskEmail } from '../auth/dto/register.dto.js';
import {
  DeathVerificationActorType,
  DeathVerificationAuditEventType,
  DeathVerificationCaseStatus as Status,
  MessageStatus,
  Prisma,
  ReleaseTriggerType,
} from '../generated/prisma/client.js';
import { positiveInt } from '../media/media.service.js';
import { errorCode, PrismaService } from '../prisma/prisma.service.js';
import { DeathNoticeDelivery } from './death-verification-notice.js';

const DAY_MS = 86_400_000;

export const deathVerificationSettings = (config: ConfigService) => {
  const url = config.get<string>('QUEUE_REDIS_URL') || config.get('REDIS_URL');
  if (!url) throw new Error('REDIS_URL is not set. Add it to .env.');
  return {
    // 14 days by default. Stored per case as safeguardEndsAt when it starts.
    safeguardMs:
      positiveInt(config, 'DEATH_VERIFICATION_SAFEGUARD_SECONDS', 1_209_600) *
      1000,
    queueName:
      config.get<string>('DEATH_VERIFICATION_QUEUE_NAME') ||
      'death-verification',
    connection: { url },
    reconcileIntervalMs:
      positiveInt(config, 'DEATH_VERIFICATION_RECONCILE_INTERVAL_SECONDS', 60) *
      1000,
    attempts: positiveInt(config, 'DEATH_VERIFICATION_JOB_ATTEMPTS', 5),
    backoffMs: positiveInt(config, 'DEATH_VERIFICATION_JOB_BACKOFF_MS', 5000),
  };
};
export type DeathVerificationSettings = ReturnType<
  typeof deathVerificationSettings
>;

/** Open (non-terminal) cases: the only ones a Customer can cancel. */
export const OPEN_STATUSES: Status[] = [
  Status.PENDING_VERIFICATION,
  Status.SAFEGUARD_ACTIVE,
  Status.READY_FOR_REVIEW,
];

export const DEATH_TRIGGERS: ReleaseTriggerType[] = [
  ReleaseTriggerType.ON_DEATH,
  ReleaseTriggerType.AFTER_DEATH,
];

type Actor =
  | { type: 'SYSTEM' }
  | { type: 'CUSTOMER' | 'ADMIN'; userId: string }
  | { type: 'TRUSTED_CONTACT'; trustedContactId: string };

/** Appends one audit row inside the caller's transaction. No free text. */
export const audit = (
  tx: Prisma.TransactionClient,
  caseId: string,
  eventType: DeathVerificationAuditEventType,
  actor: Actor,
) =>
  tx.deathVerificationAuditEvent.create({
    data: {
      deathVerificationCaseId: caseId,
      eventType,
      actorType: DeathVerificationActorType[actor.type],
      actorUserId: 'userId' in actor ? actor.userId : null,
      actorTrustedContactId:
        'trustedContactId' in actor ? actor.trustedContactId : null,
    },
  });

/**
 * When a death-triggered Message becomes due, or null if it cannot be
 * activated. ON_DEATH: as soon as For After verified the death (verifiedAt),
 * never the historical time of death. AFTER_DEATH: the approved time of death
 * + afterDeathDays (UTC days), so it may already be overdue at verification.
 */
export const deathTriggerDueAt = (
  schedule: { triggerType: ReleaseTriggerType; afterDeathDays: number | null },
  verifiedAt: Date,
  verifiedDeathAt: Date,
): Date | null => {
  if (schedule.triggerType === ReleaseTriggerType.ON_DEATH) return verifiedAt;
  if (
    schedule.triggerType === ReleaseTriggerType.AFTER_DEATH &&
    schedule.afterDeathDays != null
  ) {
    return new Date(
      verifiedDeathAt.getTime() + schedule.afterDeathDays * DAY_MS,
    );
  }
  return null;
};

export type SafeguardStart =
  | { result: 'started'; safeguardEndsAt: Date }
  | { result: 'skipped' }
  | { result: 'failed' };

export type SafeguardElapse =
  | { result: 'ready_for_review' }
  | { result: 'not_due'; dueAt: Date }
  | { result: 'stale'; reason: string };

/**
 * System-driven case transitions, all decided in PostgreSQL with conditional
 * updates so a concurrent Customer/admin decision can never be overwritten:
 *
 *   PENDING_VERIFICATION --notice sent--> SAFEGUARD_ACTIVE --time--> READY_FOR_REVIEW
 *   VERIFIED --> DeathTriggeredMessageActivation rows (release is Step 12's job)
 *
 * Nothing here verifies a death or releases a Message.
 */
@Injectable()
export class DeathVerificationWorkflow {
  private readonly logger = new Logger(DeathVerificationWorkflow.name);
  readonly settings: DeathVerificationSettings;

  constructor(
    private readonly prisma: PrismaService,
    private readonly delivery: DeathNoticeDelivery,
    config: ConfigService,
  ) {
    this.settings = deathVerificationSettings(config);
  }

  /**
   * Sends the account-holder safety notice and, only if it succeeded, starts
   * the safeguard window. On failure the case stays PENDING_VERIFICATION and
   * the reconciler retries after one interval. `now` is for tests only.
   */
  async startSafeguard(caseId: string, now?: Date): Promise<SafeguardStart> {
    const attemptAt = now ?? new Date();
    // Claim this attempt, so two instances never send at the same time.
    const { count } = await this.prisma.deathVerificationCase.updateMany({
      where: {
        id: caseId,
        status: Status.PENDING_VERIFICATION,
        safetyNoticeSentAt: null,
        reports: { some: {} },
        OR: [
          { safetyNoticeLastAttemptAt: null },
          {
            // Half an interval: a reconciler tick is never skipped by timer
            // jitter, yet two instances cannot both send in one tick.
            safetyNoticeLastAttemptAt: {
              lte: new Date(
                attemptAt.getTime() - this.settings.reconcileIntervalMs / 2,
              ),
            },
          },
        ],
      },
      data: {
        safetyNoticeLastAttemptAt: attemptAt,
        safetyNoticeAttemptCount: { increment: 1 },
      },
    });
    if (!count) return { result: 'skipped' };

    const kase = await this.prisma.deathVerificationCase.findUniqueOrThrow({
      where: { id: caseId },
      select: {
        safetyNoticeAttemptCount: true,
        owner: { select: { email: true, firstName: true, lastName: true } },
      },
    });
    const { owner } = kase;
    try {
      await this.delivery.sendAccountHolderSafetyNotice({
        caseId,
        email: owner.email,
        displayName:
          [owner.firstName, owner.lastName].filter(Boolean).join(' ') ||
          'For After member',
        safeguardEndsAt: new Date(
          attemptAt.getTime() + this.settings.safeguardMs,
        ),
      });
    } catch (err) {
      this.logger.warn(
        `death_safety_notice_failed case ${caseId} attempt ${kase.safetyNoticeAttemptCount} (code: ${errorCode(err)}); will retry`,
      );
      return { result: 'failed' };
    }

    // The window starts after the successful send, never before.
    const sentAt = now ?? new Date();
    const safeguardEndsAt = new Date(
      sentAt.getTime() + this.settings.safeguardMs,
    );
    const started = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.deathVerificationCase.updateMany({
        // Not cancelled meanwhile by the Customer.
        where: {
          id: caseId,
          status: Status.PENDING_VERIFICATION,
          safetyNoticeSentAt: null,
        },
        data: {
          status: Status.SAFEGUARD_ACTIVE,
          safetyNoticeSentAt: sentAt,
          safeguardStartedAt: sentAt,
          safeguardEndsAt,
        },
      });
      if (!count) return false;
      const system = { type: 'SYSTEM' } as const;
      await audit(tx, caseId, 'SAFETY_NOTICE_SENT', system);
      await audit(tx, caseId, 'SAFEGUARD_STARTED', system);
      return true;
    });
    if (!started) return { result: 'skipped' };
    this.logger.log(
      `death_safety_notice_sent case ${caseId} to ${maskEmail(owner.email)}`,
    );
    this.logger.log(
      `death_safeguard_started case ${caseId} ends ${safeguardEndsAt.toISOString()}`,
    );
    return { result: 'started', safeguardEndsAt };
  }

  /** SAFEGUARD_ACTIVE → READY_FOR_REVIEW once safeguardEndsAt has passed. Never VERIFIED. */
  async elapseSafeguard(
    caseId: string,
    now = new Date(),
  ): Promise<SafeguardElapse> {
    const advanced = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.deathVerificationCase.updateMany({
        where: {
          id: caseId,
          status: Status.SAFEGUARD_ACTIVE,
          safetyNoticeSentAt: { not: null },
          safeguardEndsAt: { lte: now },
        },
        data: { status: Status.READY_FOR_REVIEW },
      });
      if (count)
        await audit(tx, caseId, 'SAFEGUARD_ELAPSED', { type: 'SYSTEM' });
      return count > 0;
    });
    if (advanced) {
      this.logger.log(`death_safeguard_ready_for_review case ${caseId}`);
      return { result: 'ready_for_review' };
    }
    const kase = await this.prisma.deathVerificationCase.findUnique({
      where: { id: caseId },
      select: { status: true, safeguardEndsAt: true },
    });
    if (kase?.status === Status.SAFEGUARD_ACTIVE && kase.safeguardEndsAt) {
      return { result: 'not_due', dueAt: kase.safeguardEndsAt };
    }
    // Cancelled, rejected, verified, already advanced or deleted: no-op.
    return {
      result: 'stale',
      reason: kase ? `status ${kase.status}` : 'case not found',
    };
  }

  /**
   * Builds one DeathTriggeredMessageActivation per SCHEDULED ON_DEATH /
   * AFTER_DEATH Message of a VERIFIED case (idempotent: messageId is unique,
   * existing rows are kept). Returns the activations still waiting to release,
   * for queueing. Returns null if the case is not VERIFIED.
   */
  async activateTriggers(
    caseId: string,
    now = new Date(),
  ): Promise<{ messageId: string; dueAt: Date }[] | null> {
    const result = await this.prisma.$transaction(async (tx) => {
      // Serialises concurrent activations of the same case (verify + reconciler).
      await tx.$queryRaw`SELECT id FROM "DeathVerificationCase" WHERE id = ${caseId}::uuid FOR UPDATE`;
      const kase = await tx.deathVerificationCase.findUnique({
        where: { id: caseId },
        select: {
          status: true,
          ownerUserId: true,
          verifiedAt: true,
          verifiedDeathAt: true,
          deathTriggersActivatedAt: true,
        },
      });
      if (
        kase?.status !== Status.VERIFIED ||
        !kase.verifiedAt ||
        !kase.verifiedDeathAt
      ) {
        return null;
      }
      const { verifiedAt, verifiedDeathAt } = kase;
      const first = !kase.deathTriggersActivatedAt;
      if (first) {
        await audit(tx, caseId, 'DEATH_TRIGGER_ACTIVATION_STARTED', {
          type: 'SYSTEM',
        });
      }
      const pending = await tx.message.findMany({
        where: {
          ownerUserId: kase.ownerUserId,
          status: MessageStatus.SCHEDULED,
          deletedAt: null,
          deathActivation: { is: null },
          schedule: { triggerType: { in: DEATH_TRIGGERS } },
        },
        select: {
          id: true,
          schedule: { select: { triggerType: true, afterDeathDays: true } },
        },
      });
      const data = pending.flatMap(({ id, schedule }) => {
        const dueAt =
          schedule && deathTriggerDueAt(schedule, verifiedAt, verifiedDeathAt);
        return schedule && dueAt
          ? [
              {
                messageId: id,
                deathVerificationCaseId: caseId,
                triggerType: schedule.triggerType,
                activatedAt: now,
                dueAt,
              },
            ]
          : [];
      });
      const { count } = await tx.deathTriggeredMessageActivation.createMany({
        data,
        skipDuplicates: true,
      });
      if (first) {
        await tx.deathVerificationCase.update({
          where: { id: caseId },
          data: { deathTriggersActivatedAt: now },
        });
        await audit(tx, caseId, 'DEATH_TRIGGER_ACTIVATION_COMPLETED', {
          type: 'SYSTEM',
        });
      }
      const waiting = await tx.deathTriggeredMessageActivation.findMany({
        where: {
          deathVerificationCaseId: caseId,
          message: { status: MessageStatus.SCHEDULED, deletedAt: null },
        },
        select: { messageId: true, dueAt: true },
      });
      return { created: count, waiting };
    });
    if (!result) return null;
    if (result.created) {
      this.logger.log(
        `death_trigger_activation_created case ${caseId} count ${result.created}`,
      );
    }
    return result.waiting;
  }
}
