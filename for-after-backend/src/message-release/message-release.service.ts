import { Injectable } from '@nestjs/common';
import {
  DeathVerificationCaseStatus,
  MessageStatus,
  Prisma,
  ReleaseTriggerType,
} from '../generated/prisma/client.js';
import { emailKey } from '../auth/dto/register.dto.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { stripPhone } from '../recipients/dto/create-recipient.dto.js';
import { isRecurring, nextOccurrence } from './recipient-occurrences.js';

export type ReleaseOutcome =
  | {
      result: 'released';
      triggerType: ReleaseTriggerType;
      scheduledFor: Date;
      grants: number;
    }
  // Phase 16: one Recipient's yearly occurrence; the Message stays SCHEDULED.
  | {
      result: 'occurrence_released';
      triggerType: ReleaseTriggerType;
      scheduledFor: Date;
      grants: number;
      next: Date | null;
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
 * When a scheduled Message may release as a whole, or null if its trigger
 * cannot run that way: FIXED_DATE / CUSTOM_EVENT → scheduledFor (Step 12,
 * Phase 16). NOW → the moment it was scheduled. ON_DEATH / AFTER_DEATH → the
 * activation dueAt, only if the activation matches the trigger and its case
 * is VERIFIED (Step 15). Recurring triggers release per Recipient instead
 * (releaseOccurrence), never here.
 */
export const releaseDueAt = (
  schedule: {
    triggerType: ReleaseTriggerType;
    scheduledFor: Date | null;
    afterDeathDays: number | null;
    createdAt?: Date;
  },
  activation: {
    triggerType: ReleaseTriggerType;
    dueAt: Date;
    deathVerificationCase: { status: DeathVerificationCaseStatus };
  } | null,
): Date | null => {
  switch (schedule.triggerType) {
    case ReleaseTriggerType.FIXED_DATE:
    case ReleaseTriggerType.CUSTOM_EVENT:
      return schedule.scheduledFor;
    case ReleaseTriggerType.NOW:
      return schedule.createdAt ?? null;
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
 * The name a Recipient sees a released Message is from: "First Last" as the
 * Customer has it now, whitespace collapsed; null when neither is set.
 */
export const senderDisplayName = (owner: {
  firstName: string | null;
  lastName: string | null;
}) =>
  [owner.firstName, owner.lastName]
    .map((part) => part?.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' ') || null;

/**
 * One RecipientMessageAccessGrant per live assigned Recipient (or just
 * `recipientId`), snapshotting contact details and the sender's display name
 * (never notes, birthday or relationship, nor any other Customer data).
 * Idempotent: existing (release, recipient) pairs are skipped, so a retry or a
 * later recurring year never rewrites a snapshot. Runs inside the caller's
 * transaction; also used by the backfill script. Returns grants created.
 */
export const createAccessGrants = async (
  tx: Prisma.TransactionClient,
  release: { id: string; messageId: string },
  recipientId?: string,
): Promise<number> => {
  const assigned = await tx.messageRecipient.findMany({
    where: {
      messageId: release.messageId,
      recipient: { deletedAt: null },
      ...(recipientId ? { recipientId } : {}),
    },
    select: {
      recipientId: true,
      recipient: { select: { email: true, mobile: true } },
    },
  });
  const { owner } = await tx.message.findUniqueOrThrow({
    where: { id: release.messageId },
    select: { owner: { select: { firstName: true, lastName: true } } },
  });
  const senderDisplayNameSnapshot = senderDisplayName(owner);
  const { count } = await tx.recipientMessageAccessGrant.createMany({
    data: assigned.map(({ recipientId, recipient }) => ({
      messageReleaseId: release.id,
      messageId: release.messageId,
      recipientId,
      // A mobile-only Recipient signs in by SMS; a contactless one cannot
      // sign in. Mobiles are E.164 (older, typed ones are only de-formatted).
      recipientEmailNormalized: emailKey(recipient.email ?? '') || null,
      recipientMobileNormalized: stripPhone(recipient.mobile ?? '') || null,
      senderDisplayNameSnapshot,
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
                createdAt: true,
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
        // Step 24: one "a message is waiting" email per grant with an email,
        // committed with the release (an outbox). Not in createAccessGrants:
        // the backfill script must never email past releases.
        const reachable = await tx.recipientMessageAccessGrant.findMany({
          where: {
            messageReleaseId: release.id,
            recipientEmailNormalized: { not: null },
          },
          select: { id: true },
        });
        await tx.releaseNotification.createMany({
          data: reachable.map(({ id }) => ({ grantId: id })),
          skipDuplicates: true,
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

  /**
   * Phase 16: releases one Recipient's yearly occurrence of a recurring
   * trigger (BIRTHDAY, ANNIVERSARY, ANNUAL_AFTER_DEATH). The first occurrence
   * of the Message creates its MessageRelease; the Recipient's first one
   * creates their grant (permanent, as for any release). Every occurrence
   * gets its own ReleaseNotification and creates next year's occurrence. The
   * Message stays SCHEDULED: it keeps recurring. Other Recipients are never
   * touched, so nobody gets access before their own due time.
   */
  async releaseOccurrence(
    occurrenceId: string,
    now = new Date(),
  ): Promise<ReleaseOutcome> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const found = await tx.messageRecipientRelease.findUnique({
          where: { id: occurrenceId },
          select: { messageId: true },
        });
        if (!found) return { result: 'stale', reason: 'occurrence not found' };
        const { messageId } = found;
        // Same lock as release, PATCH and unschedule: serialises every
        // occurrence of this Message and any schedule change.
        const [locked] = await tx.$queryRaw<{ status: MessageStatus }[]>`
          SELECT status FROM "Message"
          WHERE id = ${messageId}::uuid AND "deletedAt" IS NULL
          FOR UPDATE`;
        if (locked?.status !== MessageStatus.SCHEDULED) {
          return {
            result: 'stale',
            reason: locked ? `status ${locked.status}` : 'message not found',
          };
        }
        // Re-read under the lock: unschedule may have removed it, or another
        // worker released it.
        const occ = await tx.messageRecipientRelease.findUnique({
          where: { id: occurrenceId },
          select: {
            recipientId: true,
            occurrenceYear: true,
            dueAt: true,
            releasedAt: true,
          },
        });
        if (!occ) return { result: 'stale', reason: 'occurrence not found' };
        if (occ.releasedAt) return { result: 'already_released' };

        const message = await tx.message.findUniqueOrThrow({
          where: { id: messageId },
          select: {
            schedule: {
              select: {
                triggerType: true,
                timezone: true,
                localTime: true,
                annualMonth: true,
                annualDay: true,
              },
            },
            deathActivation: {
              select: {
                triggerType: true,
                deathVerificationCase: {
                  select: { status: true, verifiedDeathAt: true },
                },
              },
            },
            release: { select: { id: true } },
          },
        });
        const schedule = message.schedule;
        if (!schedule || !isRecurring(schedule.triggerType)) {
          return { result: 'stale', reason: 'trigger changed' };
        }
        let verifiedDeathAt: Date | null = null;
        if (schedule.triggerType === ReleaseTriggerType.ANNUAL_AFTER_DEATH) {
          // Only an admin-verified death; a report is never enough.
          const a = message.deathActivation;
          if (
            a?.triggerType !== ReleaseTriggerType.ANNUAL_AFTER_DEATH ||
            a.deathVerificationCase.status !==
              DeathVerificationCaseStatus.VERIFIED
          ) {
            return { result: 'stale', reason: 'death not verified' };
          }
          verifiedDeathAt = a.deathVerificationCase.verifiedDeathAt;
        }
        if (occ.dueAt > now) return { result: 'not_due', dueAt: occ.dueAt };

        const assigned = await tx.messageRecipient.findFirst({
          where: {
            messageId,
            recipientId: occ.recipientId,
            recipient: { deletedAt: null },
          },
          select: { recipient: { select: { birthday: true } } },
        });
        // Deleted Recipient: no access, no email, no further years.
        if (!assigned) {
          await tx.messageRecipientRelease.delete({
            where: { id: occurrenceId },
          });
          return { result: 'stale', reason: 'recipient removed' };
        }

        const release =
          message.release ??
          (await tx.messageRelease.create({
            data: {
              messageId,
              triggerType: schedule.triggerType,
              scheduledFor: occ.dueAt,
              releasedAt: now,
            },
            select: { id: true },
          }));
        const grants = await createAccessGrants(
          tx,
          { id: release.id, messageId },
          occ.recipientId,
        );
        const grant = await tx.recipientMessageAccessGrant.findUniqueOrThrow({
          where: {
            messageReleaseId_recipientId: {
              messageReleaseId: release.id,
              recipientId: occ.recipientId,
            },
          },
          select: { id: true, recipientEmailNormalized: true },
        });
        await tx.messageRecipientRelease.update({
          where: { id: occurrenceId },
          data: { releasedAt: now },
        });
        // occurrenceId is unique: one email per occurrence, ever.
        if (grant.recipientEmailNormalized) {
          await tx.releaseNotification.create({
            data: { grantId: grant.id, occurrenceId },
          });
        }
        // ponytail: uses the birthday at release time; a birthday edited while
        // scheduled moves only the years after the pending one.
        const next = nextOccurrence(
          schedule,
          assigned.recipient.birthday,
          verifiedDeathAt,
          now,
          occ.occurrenceYear + 1,
        );
        if (next) {
          await tx.messageRecipientRelease.createMany({
            data: [
              {
                messageId,
                recipientId: occ.recipientId,
                occurrenceYear: next.year,
                dueAt: next.dueAt,
              },
            ],
            skipDuplicates: true,
          });
        }
        return {
          result: 'occurrence_released',
          triggerType: schedule.triggerType,
          scheduledFor: occ.dueAt,
          grants,
          next: next?.dueAt ?? null,
        };
      });
    } catch (err) {
      // Backstop: a unique key (release, notification, next year) was taken
      // by a concurrent transaction; the whole transaction rolled back.
      if (isUniqueViolation(err)) return { result: 'already_released' };
      throw err;
    }
  }
}
