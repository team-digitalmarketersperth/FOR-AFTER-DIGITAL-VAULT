import { Prisma, ReleaseTriggerType } from '../generated/prisma/client.js';
import {
  dateOnlyParts,
  localParts,
  nextAnnualOccurrence,
} from '../message-schedules/recurrence.js';

/** Triggers released per Recipient, once a year (Phase 16). */
export const RECURRING_TRIGGERS: ReleaseTriggerType[] = [
  ReleaseTriggerType.BIRTHDAY,
  ReleaseTriggerType.ANNIVERSARY,
  ReleaseTriggerType.ANNUAL_AFTER_DEATH,
];

export const isRecurring = (t: ReleaseTriggerType) =>
  RECURRING_TRIGGERS.includes(t);

export type RecurringSchedule = {
  triggerType: ReleaseTriggerType;
  timezone: string | null;
  localTime: string | null;
  annualMonth: number | null;
  annualDay: number | null;
};

/**
 * The yearly month/day a recurring trigger fires on for one Recipient, or
 * null if it cannot be resolved (no birthday, incomplete schedule, death not
 * verified). BIRTHDAY: the Recipient's own birthday. ANNIVERSARY: the
 * schedule's month/day. ANNUAL_AFTER_DEATH: the local date of the verified
 * death in the schedule's timezone.
 */
const monthDay = (
  s: RecurringSchedule,
  birthday: Date | null,
  verifiedDeathAt: Date | null,
): { month: number; day: number } | null => {
  if (!s.timezone || !s.localTime) return null;
  switch (s.triggerType) {
    case ReleaseTriggerType.BIRTHDAY:
      return birthday ? dateOnlyParts(birthday) : null;
    case ReleaseTriggerType.ANNIVERSARY:
      return s.annualMonth && s.annualDay
        ? { month: s.annualMonth, day: s.annualDay }
        : null;
    case ReleaseTriggerType.ANNUAL_AFTER_DEATH:
      return verifiedDeathAt ? localParts(verifiedDeathAt, s.timezone) : null;
    default:
      return null;
  }
};

/**
 * The next occurrence strictly after `after`, from `fromYear` on. Missed years
 * are skipped, never released in a burst.
 */
export const nextOccurrence = (
  s: RecurringSchedule,
  birthday: Date | null,
  verifiedDeathAt: Date | null,
  after: Date,
  fromYear: number,
): { year: number; dueAt: Date } | null => {
  const md = monthDay(s, birthday, verifiedDeathAt);
  return md
    ? nextAnnualOccurrence(
        md.month,
        md.day,
        s.localTime!,
        s.timezone!,
        after,
        fromYear,
      )
    : null;
};

/**
 * The first occurrence. BIRTHDAY / ANNIVERSARY: the next one after `now`.
 * ANNUAL_AFTER_DEATH: the first anniversary of the verified death (one
 * calendar year later), even if that is already past at verification, like
 * an overdue AFTER_DEATH it then releases promptly.
 */
export const firstOccurrence = (
  s: RecurringSchedule,
  birthday: Date | null,
  verifiedDeathAt: Date | null,
  now: Date,
) => {
  if (s.triggerType === ReleaseTriggerType.ANNUAL_AFTER_DEATH) {
    if (!verifiedDeathAt || !s.timezone) return null;
    const deathYear = localParts(verifiedDeathAt, s.timezone).year;
    return nextOccurrence(
      s,
      null,
      verifiedDeathAt,
      verifiedDeathAt,
      deathYear + 1,
    );
  }
  // Start at last year so "later today" in a zone behind UTC is not missed.
  return nextOccurrence(s, birthday, null, now, now.getUTCFullYear() - 1);
};

/**
 * One pending occurrence per live assigned Recipient (inside the caller's
 * transaction). Idempotent via the (message, recipient, year) unique key.
 * Recipients whose occurrence cannot be resolved get none. Returns the count.
 */
export const createFirstOccurrences = async (
  tx: Prisma.TransactionClient,
  messageId: string,
  schedule: RecurringSchedule,
  now: Date,
  verifiedDeathAt: Date | null = null,
): Promise<number> => {
  const assigned = await tx.messageRecipient.findMany({
    where: { messageId, recipient: { deletedAt: null } },
    select: { recipientId: true, recipient: { select: { birthday: true } } },
  });
  const data = assigned.flatMap(({ recipientId, recipient }) => {
    const next = firstOccurrence(
      schedule,
      recipient.birthday,
      verifiedDeathAt,
      now,
    );
    return next
      ? [
          {
            messageId,
            recipientId,
            occurrenceYear: next.year,
            dueAt: next.dueAt,
          },
        ]
      : [];
  });
  const { count } = await tx.messageRecipientRelease.createMany({
    data,
    skipDuplicates: true,
  });
  return count;
};
