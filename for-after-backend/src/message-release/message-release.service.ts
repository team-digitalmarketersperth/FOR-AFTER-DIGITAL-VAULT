import { Injectable } from '@nestjs/common';
import {
  DeathVerificationCaseStatus,
  MessageStatus,
  Prisma,
  ReleaseTriggerType,
} from '../generated/prisma/client.js';
import { emailKey } from '../auth/dto/register.dto.js';
import { PrismaService } from '../prisma/prisma.service.js';

export type ReleaseOutcome =
  | {
      result: 'released';
      triggerType: ReleaseTriggerType;
      scheduledFor: Date;
      grants: number;
    }
  | { result: 'already_released' }
  // The job no longer matches PostgreSQL (unscheduled, deleted, trigger changed).
  | { result: 'stale'; reason: string }
  // Rescheduled later, or the job fired early: run again at dueAt.
  | { result: 'not_due'; dueAt: Date }
  // Valid schedule, but releasing now would break a rule: stays SCHEDULED.
  | { result: 'blocked'; reason: string };

const isUniqueViolation = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

/**
 * When a scheduled Message may release, or null if its trigger cannot run:
 * FIXED_DATE → scheduledFor (Step 12). ON_DEATH / AFTER_DEATH → the activation
 * dueAt, only if the activation matches the trigger and its case is VERIFIED
 * (Step 15). Every other trigger never runs.
 */
export const releaseDueAt = (
  schedule: {
    triggerType: ReleaseTriggerType;
    scheduledFor: Date | null;
    afterDeathDays: number | null;
  },
  activation: {
    triggerType: ReleaseTriggerType;
    dueAt: Date;
    deathVerificationCase: { status: DeathVerificationCaseStatus };
  } | null,
): Date | null => {
  switch (schedule.triggerType) {
    case ReleaseTriggerType.FIXED_DATE:
      return schedule.scheduledFor;
    case ReleaseTriggerType.ON_DEATH:
    case ReleaseTriggerType.AFTER_DEATH:
      if (
        !activation ||
        activation.triggerType !== schedule.triggerType ||
        activation.deathVerificationCase.status !==
          DeathVerificationCaseStatus.VERIFIED ||
        (schedule.triggerType === ReleaseTriggerType.AFTER_DEATH &&
          schedule.afterDeathDays == null)
      ) {
        return null;
      }
      return activation.dueAt;
    default:
      return null;
  }
};

/**
 * One RecipientMessageAccessGrant per live assigned Recipient, snapshotting
 * contact details only (never notes, birthday or relationship). Idempotent:
 * existing (release, recipient) pairs are skipped. Runs inside the caller's
 * transaction; also used by the backfill script. Returns grants created.
 */
export const createAccessGrants = async (
  tx: Prisma.TransactionClient,
  release: { id: string; messageId: string },
): Promise<number> => {
  const assigned = await tx.messageRecipient.findMany({
    where: { messageId: release.messageId, recipient: { deletedAt: null } },
    select: {
      recipientId: true,
      recipient: { select: { email: true, mobile: true } },
    },
  });
  const { count } = await tx.recipientMessageAccessGrant.createMany({
    data: assigned.map(({ recipientId, recipient }) => ({
      messageReleaseId: release.id,
      messageId: release.messageId,
      recipientId,
      // A mobile-only (or contactless) Recipient still gets a grant; it is
      // just not reachable by email OTP.
      recipientEmailNormalized: emailKey(recipient.email ?? '') || null,
      recipientMobileNormalized: recipient.mobile?.trim() || null,
    })),
    skipDuplicates: true,
  });
  return count;
};

/**
 * Executes a due release (FIXED_DATE, or a VERIFIED death trigger): SCHEDULED → RELEASED plus one
 * MessageRelease row and its Recipient access grants, atomically. PostgreSQL decides everything; a queue job
 * is only a hint to check. Nothing is delivered or sent here. Database errors
 * are thrown so the job is retried.
 */
@Injectable()
export class MessageReleaseService {
  constructor(private readonly prisma: PrismaService) {}

  async release(messageId: string, now = new Date()): Promise<ReleaseOutcome> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        // Row lock without a write. Unschedule and schedule PATCH lock the same
        // row, so they wait for this transaction (and it for them), and the
        // reads below see their committed result.
        const [locked] = await tx.$queryRaw<{ status: MessageStatus }[]>`
          SELECT status FROM "Message"
          WHERE id = ${messageId}::uuid AND "deletedAt" IS NULL
          FOR UPDATE`;
        if (locked?.status === MessageStatus.RELEASED) {
          return { result: 'already_released' };
        }
        if (locked?.status !== MessageStatus.SCHEDULED) {
          return {
            result: 'stale',
            reason: locked ? `status ${locked.status}` : 'message not found',
          };
        }

        const message = await tx.message.findUniqueOrThrow({
          where: { id: messageId },
          select: {
            schedule: {
              select: {
                triggerType: true,
                scheduledFor: true,
                afterDeathDays: true,
              },
            },
            // Step 15: death triggers run only from an activation whose case
            // is VERIFIED. A report or reported date is never enough.
            deathActivation: {
              select: {
                triggerType: true,
                dueAt: true,
                deathVerificationCase: { select: { status: true } },
              },
            },
            release: { select: { id: true } },
            _count: {
              select: {
                recipients: { where: { recipient: { deletedAt: null } } },
              },
            },
          },
        });
        const schedule = message.schedule;
        if (!schedule) return { result: 'stale', reason: 'no schedule' };
        const dueAt = releaseDueAt(schedule, message.deathActivation);
        if (!dueAt) {
          return {
            result: 'stale',
            reason: `trigger ${schedule.triggerType} not executable`,
          };
        }
        // UTC instants on both sides; no clock tolerance: an early job is re-delayed.
        if (dueAt > now) return { result: 'not_due', dueAt };
        if (message.release) return { result: 'already_released' };
        // Scheduling required a live recipient; if all were deleted since,
        // do not release to nobody.
        if (!message._count.recipients) {
          return { result: 'blocked', reason: 'no live recipients' };
        }

        const release = await tx.messageRelease.create({
          data: {
            messageId,
            triggerType: schedule.triggerType,
            // FIXED_DATE: the schedule time; death triggers: the activation dueAt.
            scheduledFor: dueAt,
            releasedAt: now,
          },
          select: { id: true },
        });
        const grants = await createAccessGrants(tx, {
          id: release.id,
          messageId,
        });
        await tx.message.update({
          where: { id: messageId },
          data: { status: MessageStatus.RELEASED },
        });
        return {
          result: 'released',
          triggerType: schedule.triggerType,
          scheduledFor: dueAt,
          grants,
        };
      });
    } catch (err) {
      // Backstop: another transaction created the release first.
      if (isUniqueViolation(err)) return { result: 'already_released' };
      throw err;
    }
  }
}
