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
import { checkComposition } from '../messages/message-composition.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { CreateMessageScheduleDto } from './dto/create-message-schedule.dto.js';
import { UpdateMessageScheduleDto } from './dto/update-message-schedule.dto.js';

// messageId and anything from Message never leave this API.
const scheduleSelect = {
  id: true,
  triggerType: true,
  scheduledFor: true,
  afterDeathDays: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.MessageScheduleSelect;

export type ScheduleResponse = Prisma.MessageScheduleGetPayload<{
  select: typeof scheduleSelect;
}>;
type ScheduleState = Pick<
  ScheduleResponse,
  'triggerType' | 'scheduledFor' | 'afterDeathDays'
>;

// Same message whether the message is missing, deleted or someone else's.
const MESSAGE_NOT_FOUND = 'Message not found.';
const SCHEDULE_NOT_FOUND = 'Schedule not found.';
export const ALREADY_SCHEDULED = 'Message already has a schedule.';
export const NOT_DRAFT = 'Only draft messages can be scheduled.';
export const NOT_SCHEDULED = 'Message is not scheduled.';
export const NO_RECIPIENTS = 'Assign at least one recipient before scheduling.';

const bad = (message: string) => new BadRequestException(message);

/**
 * Validates a complete schedule (after any PATCH merge). Each supported
 * trigger takes exactly its own fields; contradictions are rejected, never
 * silently dropped. The database CHECK constraint is the final backstop.
 */
export function checkSchedule(s: ScheduleState, now = new Date()): void {
  switch (s.triggerType) {
    case ReleaseTriggerType.FIXED_DATE:
      if (!s.scheduledFor) throw bad('FIXED_DATE requires scheduledFor.');
      if (s.afterDeathDays != null) {
        throw bad('FIXED_DATE does not take afterDeathDays.');
      }
      if (s.scheduledFor <= now)
        throw bad('scheduledFor must be in the future.');
      return;
    case ReleaseTriggerType.ON_DEATH:
      if (s.scheduledFor || s.afterDeathDays != null) {
        throw bad('ON_DEATH does not take scheduledFor or afterDeathDays.');
      }
      return;
    case ReleaseTriggerType.AFTER_DEATH:
      if (s.afterDeathDays == null) {
        throw bad('AFTER_DEATH requires afterDeathDays.');
      }
      if (s.scheduledFor) throw bad('AFTER_DEATH does not take scheduledFor.');
      return;
    default:
      throw bad('This release type is not available yet.');
  }
}

const toDate = (value: string | null | undefined) =>
  value == null ? null : new Date(value);

// PATCH: sent fields win (null clears); unsent fields are kept only while the
// trigger type stays the same, so no stale field survives a type change.
const merge = (
  stored: ScheduleState,
  dto: UpdateMessageScheduleDto,
): ScheduleState => {
  const triggerType = dto.triggerType ?? stored.triggerType;
  const keep = triggerType === stored.triggerType;
  return {
    triggerType,
    scheduledFor:
      dto.scheduledFor !== undefined
        ? toDate(dto.scheduledFor)
        : keep
          ? stored.scheduledFor
          : null,
    afterDeathDays:
      dto.afterDeathDays !== undefined
        ? dto.afterDeathDays
        : keep
          ? stored.afterDeathDays
          : null,
  };
};

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
    const state: ScheduleState = {
      triggerType: dto.triggerType,
      scheduledFor: toDate(dto.scheduledFor),
      afterDeathDays: dto.afterDeathDays ?? null,
    };
    checkSchedule(state);
    let created: ScheduleResponse | null;
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
        return tx.messageSchedule.create({
          data: { messageId, ...state },
          select: scheduleSelect,
        });
      });
    } catch (err) {
      // A concurrent create won the unique messageId.
      if (isUniqueViolation(err))
        throw new ConflictException(ALREADY_SCHEDULED);
      throw err;
    }
    if (created) {
      await this.releaseQueue.sync(messageId, created);
      return created;
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
    return schedule;
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
    const state = merge(stored, dto);
    checkSchedule(state);
    let updated: ScheduleResponse | null;
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
        return tx.messageSchedule.update({
          where: this.scheduledBy(ownerUserId, messageId),
          data: state,
          select: scheduleSelect,
        });
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
    await this.releaseQueue.sync(messageId, updated);
    return updated;
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
      await tx.messageSchedule.delete({ where: { messageId } });
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
