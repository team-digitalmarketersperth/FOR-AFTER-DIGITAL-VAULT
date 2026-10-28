import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  MessageStatus,
  Prisma,
  ReleaseTriggerType,
} from '../generated/prisma/client.js';
import { MessageReleaseQueue } from '../message-release/message-release-queue.service.js';
import { createFirstOccurrences } from '../message-release/recipient-occurrences.js';
import { checkComposition } from '../messages/message-composition.js';
import { recordActivity } from '../activity/customer-activity.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { CreateMessageScheduleDto } from './dto/create-message-schedule.dto.js';
import { UpdateMessageScheduleDto } from './dto/update-message-schedule.dto.js';
import { isIanaZone, isValidMonthDay, localDateTime } from './recurrence.js';

// messageId and anything from Message never leave this API.
const scheduleSelect = {
  id: true,
  triggerType: true,
  scheduledFor: true,
  afterDeathDays: true,
  timezone: true,
  localTime: true,
  annualMonth: true,
  annualDay: true,
  eventDate: true,
  eventLabel: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.MessageScheduleSelect;

type ScheduleRow = Prisma.MessageScheduleGetPayload<{
  select: typeof scheduleSelect;
}>;
// releasedRecipientCount: Recipients a recurring schedule has already been
// released to (the Message stays SCHEDULED). Always 0 for other triggers
// while scheduled.
export type ScheduleResponse = ScheduleRow & { releasedRecipientCount: number };
type ScheduleState = Pick<
  ScheduleRow,
  | 'triggerType'
  | 'scheduledFor'
  | 'afterDeathDays'
  | 'timezone'
  | 'localTime'
  | 'annualMonth'
  | 'annualDay'
  | 'eventDate'
  | 'eventLabel'
>;
type Field = Exclude<keyof ScheduleState, 'triggerType'>;
const FIELDS: Field[] = [
  'scheduledFor',
  'afterDeathDays',
  'timezone',
  'localTime',
  'annualMonth',
  'annualDay',
  'eventDate',
  'eventLabel',
];

// Exactly the fields each trigger takes from the client (the DB CHECK in the
// migration mirrors this). CUSTOM_EVENT's scheduledFor is derived, never sent.
const TRIGGER_FIELDS: Record<ReleaseTriggerType, Field[]> = {
  NOW: [],
  FIXED_DATE: ['scheduledFor'],
  BIRTHDAY: ['timezone', 'localTime'],
  ANNIVERSARY: ['timezone', 'localTime', 'annualMonth', 'annualDay'],
  CUSTOM_EVENT: ['timezone', 'localTime', 'eventDate', 'eventLabel'],
  ON_DEATH: [],
  AFTER_DEATH: ['afterDeathDays'],
  ANNUAL_AFTER_DEATH: ['timezone', 'localTime'],
};

// Same message whether the message is missing, deleted or someone else's.
const MESSAGE_NOT_FOUND = 'Message not found.';
const SCHEDULE_NOT_FOUND = 'Schedule not found.';
export const ALREADY_SCHEDULED = 'Message already has a schedule.';
export const NOT_DRAFT = 'Only draft messages can be scheduled.';
export const NOT_SCHEDULED = 'Message is not scheduled.';
export const NO_RECIPIENTS = 'Assign at least one recipient before scheduling.';
export const MISSING_BIRTHDAY =
  'Every recipient needs a birthday for a birthday release. Add it in People I Love, or remove that recipient.';
export const ALREADY_RELEASED_TO_SOME =
  'This message has already been released to a recipient, so its schedule can no longer change.';

const bad = (message: string) => new BadRequestException(message);

/**
 * Validates a complete schedule (after any PATCH merge). Each trigger takes
 * exactly its own fields; contradictions are rejected, never silently
 * dropped. Returns the state to store (CUSTOM_EVENT gets its derived UTC
 * scheduledFor). The database CHECK constraint is the final backstop.
 */
export function checkSchedule(
  input: ScheduleState,
  now = new Date(),
): ScheduleState {
  const t = input.triggerType;
  const allowed = TRIGGER_FIELDS[t];
  if (!allowed) throw bad('Unknown release type.');
  for (const f of FIELDS) {
    const set = input[f] != null;
    if (allowed.includes(f) && !set) throw bad(`${t} requires ${f}.`);
    if (!allowed.includes(f) && set) throw bad(`${t} does not take ${f}.`);
  }
  if (input.timezone != null && !isIanaZone(input.timezone)) {
    throw bad('timezone must be an IANA time zone, e.g. Australia/Perth.');
  }
  switch (t) {
    case ReleaseTriggerType.FIXED_DATE:
      if (input.scheduledFor! <= now)
        throw bad('scheduledFor must be in the future.');
      return input;
    case ReleaseTriggerType.ANNIVERSARY:
      if (!isValidMonthDay(input.annualMonth!, input.annualDay!)) {
        throw bad('annualMonth/annualDay is not a calendar date.');
      }
      return input;
    case ReleaseTriggerType.CUSTOM_EVENT: {
      const scheduledFor = localDateTime(
        input.eventDate!,
        input.localTime!,
        input.timezone!,
      );
      if (scheduledFor <= now) throw bad('The event must be in the future.');
      return { ...input, scheduledFor };
    }
    default:
      return input;
  }
}

const toDate = (value: string | null | undefined) =>
  value == null ? null : new Date(value);

const fromDto = (dto: UpdateMessageScheduleDto): Partial<ScheduleState> => {
  const out: Partial<ScheduleState> = {};
  if (dto.scheduledFor !== undefined)
    out.scheduledFor = toDate(dto.scheduledFor);
  if (dto.eventDate !== undefined) out.eventDate = toDate(dto.eventDate);
  for (const f of [
    'afterDeathDays',
    'timezone',
    'localTime',
    'annualMonth',
    'annualDay',
    'eventLabel',
  ] as const) {
    if (dto[f] !== undefined) (out as Record<string, unknown>)[f] = dto[f];
  }
  return out;
};

const emptyState = (triggerType: ReleaseTriggerType): ScheduleState => ({
  triggerType,
  ...(Object.fromEntries(FIELDS.map((f) => [f, null])) as Omit<
    ScheduleState,
    'triggerType'
  >),
});

// PATCH: sent fields win (null clears); unsent fields are kept only while the
// trigger type stays the same, so no stale field survives a type change.
// CUSTOM_EVENT's derived scheduledFor is always recomputed.
const merge = (
  stored: ScheduleState,
  dto: UpdateMessageScheduleDto,
): ScheduleState => {
  const triggerType = dto.triggerType ?? stored.triggerType;
  const base =
    triggerType === stored.triggerType
      ? { ...stored }
      : emptyState(triggerType);
  if (stored.triggerType === ReleaseTriggerType.CUSTOM_EVENT) {
    base.scheduledFor = null;
  }
  return { ...base, ...fromDto(dto), triggerType };
};

// The fields written to MessageSchedule (all of them, so a type change clears the rest).
const toData = (s: ScheduleState) =>
  ({
    triggerType: s.triggerType,
    ...Object.fromEntries(FIELDS.map((f) => [f, s[f]])),
  }) as ScheduleState;

/**
 * BIRTHDAY / ANNIVERSARY: (re)build the pending per-Recipient occurrences
 * inside the scheduling transaction. Pending ones of a previous version are
 * dropped (their queued jobs then find nothing and no-op). BIRTHDAY needs a
 * birthday for every live assigned Recipient (409, never a silent skip).
 * ANNUAL_AFTER_DEATH gets occurrences only from a verified death.
 */
/** An assigned Recipient a BIRTHDAY release cannot place (the dashboard's attention list uses it too). */
export const MISSING_BIRTHDAY_RECIPIENT = {
  deletedAt: null,
  birthday: null,
} satisfies Prisma.RecipientWhereInput;

const rebuildOccurrences = async (
  tx: Prisma.TransactionClient,
  messageId: string,
  s: ScheduleState,
  now: Date,
) => {
  await tx.messageRecipientRelease.deleteMany({
    where: { messageId, releasedAt: null },
  });
  if (s.triggerType === ReleaseTriggerType.BIRTHDAY) {
    const missing = await tx.messageRecipient.count({
      where: { messageId, recipient: MISSING_BIRTHDAY_RECIPIENT },
    });
    if (missing) throw new ConflictException(MISSING_BIRTHDAY);
  }
  if (
    s.triggerType === ReleaseTriggerType.BIRTHDAY ||
    s.triggerType === ReleaseTriggerType.ANNIVERSARY
  ) {
    await createFirstOccurrences(tx, messageId, s, now);
  }
};

const pendingOccurrences = (tx: Prisma.TransactionClient, messageId: string) =>
  tx.messageRecipientRelease.findMany({
    where: { messageId, releasedAt: null },
    select: { id: true, dueAt: true },
  });

const isUniqueViolation = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

// PostgreSQL holds the schedule; nothing here releases, delivers or sets
// RELEASED. After each committed change the release queue is synced
// (best-effort: a Redis failure never undoes the change, the reconciler
// repairs it). Every query is scoped through the owning Message.
@Injectable()
export class MessageSchedulesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly releaseQueue: MessageReleaseQueue,
  ) {}

  private ownedMessage(ownerUserId: string, messageId: string) {
    return { id: messageId, ownerUserId, deletedAt: null };
  }

  private scheduledBy(ownerUserId: string, messageId: string) {
    return {
      messageId,
      message: {
        ...this.ownedMessage(ownerUserId, messageId),
        status: MessageStatus.SCHEDULED,
      },
    };
  }

  // DRAFT → SCHEDULED. The conditional status UPDATE locks the message row;
  // media and message edits take the same lock (they require DRAFT), so the
  // composition read next cannot go stale before commit. An incomplete
  // composition throws 409 and rolls the status back.
  async create(
    ownerUserId: string,
    messageId: string,
    dto: CreateMessageScheduleDto,
  ): Promise<ScheduleResponse> {
    const now = new Date();
    const state = checkSchedule(
      { ...emptyState(dto.triggerType), ...fromDto(dto) },
      now,
    );
    let created: {
      schedule: ScheduleRow;
      occurrences: { id: string; dueAt: Date }[];
    } | null;
    try {
      created = await this.prisma.$transaction(async (tx) => {
        const { count } = await tx.message.updateMany({
          where: {
            ...this.ownedMessage(ownerUserId, messageId),
            status: MessageStatus.DRAFT,
            schedule: { is: null },
            recipients: { some: { recipient: { deletedAt: null } } },
          },
          data: { status: MessageStatus.SCHEDULED },
        });
        if (!count) return null;
        const { mediaAssets, ...content } = await tx.message.findUniqueOrThrow({
          where: { id: messageId },
          select: {
            contentType: true,
            textContent: true,
            mediaAssets: {
              where: { deletedAt: null },
              select: { kind: true, status: true },
            },
          },
        });
        checkComposition({ ...content, media: mediaAssets });
        const schedule = await tx.messageSchedule.create({
          data: { messageId, ...toData(state) },
          select: scheduleSelect,
        });
        await rebuildOccurrences(tx, messageId, state, now);
        await recordActivity(tx, { userId: ownerUserId, type: 'MESSAGE_SCHEDULED', entityId: messageId });
        return {
          schedule,
          occurrences: await pendingOccurrences(tx, messageId),
        };
      });
    } catch (err) {
      // A concurrent create won the unique messageId.
      if (isUniqueViolation(err))
        throw new ConflictException(ALREADY_SCHEDULED);
      throw err;
    }
    if (created) {
      // After commit: NOW is queued with no delay here; the worker releases.
      await this.releaseQueue.sync(messageId, created.schedule);
      await this.releaseQueue.syncOccurrences(messageId, created.occurrences);
      return { ...created.schedule, releasedRecipientCount: 0 };
    }

    // Nothing matched: explain why, without revealing other users' messages.
    const message = await this.prisma.message.findFirst({
      where: this.ownedMessage(ownerUserId, messageId),
      select: {
        status: true,
        schedule: { select: { id: true } },
        _count: {
          select: {
            recipients: { where: { recipient: { deletedAt: null } } },
          },
        },
      },
    });
    if (!message) throw new NotFoundException(MESSAGE_NOT_FOUND);
    if (message.schedule) throw new ConflictException(ALREADY_SCHEDULED);
    if (message.status !== MessageStatus.DRAFT) {
      throw new ConflictException(NOT_DRAFT);
    }
    if (!message._count.recipients) throw bad(NO_RECIPIENTS);
    throw new ConflictException(NOT_DRAFT);
  }

  async findForMessage(
    ownerUserId: string,
    messageId: string,
  ): Promise<ScheduleResponse> {
    const schedule = await this.prisma.messageSchedule.findFirst({
      where: {
        messageId,
        message: this.ownedMessage(ownerUserId, messageId),
      },
      select: scheduleSelect,
    });
    if (!schedule) throw await this.missing(ownerUserId, messageId);
    // One grant per released Recipient; ownership was checked above.
    const releasedRecipientCount =
      await this.prisma.recipientMessageAccessGrant.count({
        where: { messageId },
      });
    return { ...schedule, releasedRecipientCount };
  }

  // SCHEDULED stays SCHEDULED. The full final state is validated and written,
  // conditional on the message still being owned, live and SCHEDULED. The
  // message row is locked first (as release and unschedule do), so a release
  // can never run on the old time while this change commits.
  async update(
    ownerUserId: string,
    messageId: string,
    dto: UpdateMessageScheduleDto,
  ): Promise<ScheduleResponse> {
    const stored = await this.prisma.messageSchedule.findFirst({
      where: this.scheduledBy(ownerUserId, messageId),
      select: scheduleSelect,
    });
    if (!stored) throw await this.missing(ownerUserId, messageId);
    const now = new Date();
    const state = checkSchedule(merge(stored, dto), now);
    let updated: {
      schedule: ScheduleRow;
      occurrences: { id: string; dueAt: Date }[];
    } | null;
    try {
      updated = await this.prisma.$transaction(async (tx) => {
        const { count } = await tx.message.updateMany({
          where: {
            ...this.ownedMessage(ownerUserId, messageId),
            status: MessageStatus.SCHEDULED,
          },
          data: { status: MessageStatus.SCHEDULED },
        });
        if (!count) return null;
        await this.assertNothingReleased(tx, messageId);
        const schedule = await tx.messageSchedule.update({
          where: this.scheduledBy(ownerUserId, messageId),
          data: toData(state),
          select: scheduleSelect,
        });
        await rebuildOccurrences(tx, messageId, state, now);
        await recordActivity(tx, { userId: ownerUserId, type: 'MESSAGE_RESCHEDULED', entityId: messageId });
        return {
          schedule,
          occurrences: await pendingOccurrences(tx, messageId),
        };
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2025'
      ) {
        throw await this.missing(ownerUserId, messageId);
      }
      throw err;
    }
    if (!updated) throw await this.missing(ownerUserId, messageId);
    await this.releaseQueue.sync(messageId, updated.schedule);
    await this.releaseQueue.syncOccurrences(messageId, updated.occurrences);
    // Only reachable before any release (assertNothingReleased).
    return { ...updated.schedule, releasedRecipientCount: 0 };
  }

  // A recurring Message that already released to someone can never go back
  // to DRAFT or change timing (the Recipient has seen it). Called after the
  // Message row lock, so a release cannot slip in between.
  private async assertNothingReleased(
    tx: Prisma.TransactionClient,
    messageId: string,
  ) {
    const released = await tx.messageRelease.count({ where: { messageId } });
    if (released) throw new ConflictException(ALREADY_RELEASED_TO_SOME);
  }

  // Unschedule: SCHEDULED → DRAFT and the schedule row is removed, atomically.
  // Not a cancellation; CANCELLED is reserved for later lifecycle rules.
  async remove(ownerUserId: string, messageId: string): Promise<void> {
    const done = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.message.updateMany({
        where: {
          ...this.ownedMessage(ownerUserId, messageId),
          status: MessageStatus.SCHEDULED,
          schedule: { isNot: null },
        },
        data: { status: MessageStatus.DRAFT },
      });
      if (!count) return false;
      // Throws 409 and rolls the DRAFT change back.
      await this.assertNothingReleased(tx, messageId);
      await tx.messageRecipientRelease.deleteMany({ where: { messageId } });
      await tx.messageSchedule.delete({ where: { messageId } });
      await recordActivity(tx, { userId: ownerUserId, type: 'MESSAGE_UNSCHEDULED', entityId: messageId });
      return true;
    });
    if (!done) throw await this.missing(ownerUserId, messageId);
    // Best-effort; a leftover job finds the message DRAFT and does nothing.
    await this.releaseQueue.sync(messageId, null);
  }

  // 404 for someone else's/missing/deleted message or a message with no
  // schedule; 409 when the owned message is past scheduling (RELEASED/CANCELLED).
  private async missing(ownerUserId: string, messageId: string) {
    const message = await this.prisma.message.findFirst({
      where: this.ownedMessage(ownerUserId, messageId),
      select: { status: true },
    });
    if (!message) return new NotFoundException(MESSAGE_NOT_FOUND);
    if (
      message.status === MessageStatus.RELEASED ||
      message.status === MessageStatus.CANCELLED
    ) {
      return new ConflictException(NOT_SCHEDULED);
    }
    return new NotFoundException(SCHEDULE_NOT_FOUND);
  }
}
