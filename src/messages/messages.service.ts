import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  MessageContentType,
  MessageStatus,
  Prisma,
} from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { CreateMessageDto } from './dto/create-message.dto.js';
import { UpdateMessageDto } from './dto/update-message.dto.js';

// ownerUserId, deletedAt and join-table ids never leave the API. Recipients
// deleted after assignment are hidden from the list.
const messageSelect = {
  id: true,
  title: true,
  contentType: true,
  textContent: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  recipients: {
    where: { recipient: { deletedAt: null } },
    orderBy: { createdAt: 'asc' },
    select: {
      recipient: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          relationship: true,
        },
      },
    },
  },
} satisfies Prisma.MessageSelect;

type MessageRow = Prisma.MessageGetPayload<{ select: typeof messageSelect }>;
export type MessageResponse = Omit<MessageRow, 'recipients'> & {
  recipients: MessageRow['recipients'][number]['recipient'][];
};

// Same message whether the row is missing, deleted or someone else's.
const NOT_FOUND = 'Message not found.';
// Same message whether a recipient is missing, deleted or someone else's.
export const INVALID_RECIPIENTS = 'One or more recipients are invalid.';
export const NOT_DRAFT = 'Only draft messages can be changed or deleted.';

const toResponse = ({ recipients, ...row }: MessageRow): MessageResponse => ({
  ...row,
  recipients: recipients.map((r) => r.recipient),
});

const assign = (recipientIds: string[]) =>
  recipientIds.map((recipientId) => ({ recipientId }));

@Injectable()
export class MessagesService {
  constructor(private readonly prisma: PrismaService) {}

  // Every read and write goes through this filter: ownership is part of the
  // query itself, never checked after fetching by id alone.
  private owned(ownerUserId: string, id: string) {
    return { id, ownerUserId, deletedAt: null };
  }

  // Message and its assignments are one nested write, which Prisma runs in a
  // single transaction: both commit or neither does.
  async create(
    ownerUserId: string,
    dto: CreateMessageDto,
  ): Promise<MessageResponse> {
    await this.assertOwnedRecipients(ownerUserId, dto.recipientIds);
    const row = await this.prisma.message.create({
      data: {
        ownerUserId,
        title: dto.title,
        textContent: dto.textContent ?? null,
        contentType: dto.contentType ?? MessageContentType.TEXT,
        status: MessageStatus.DRAFT,
        recipients: { create: assign(dto.recipientIds) },
      },
      select: messageSelect,
    });
    return toResponse(row);
  }

  // ponytail: unpaginated and returns full text; add take/cursor and a summary select if lists grow.
  async findAllForOwner(ownerUserId: string): Promise<MessageResponse[]> {
    const rows = await this.prisma.message.findMany({
      where: { ownerUserId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      select: messageSelect,
    });
    return rows.map(toResponse);
  }

  async findOwnedById(
    ownerUserId: string,
    id: string,
  ): Promise<MessageResponse> {
    const row = await this.prisma.message.findFirst({
      where: this.owned(ownerUserId, id),
      select: messageSelect,
    });
    if (!row) throw new NotFoundException(NOT_FOUND);
    return toResponse(row);
  }

  // One nested write: the draft check, field changes and the full replacement
  // of assignments commit together, or nothing changes.
  async update(
    ownerUserId: string,
    id: string,
    dto: UpdateMessageDto,
  ): Promise<MessageResponse> {
    if (dto.recipientIds) {
      await this.assertOwnedRecipients(ownerUserId, dto.recipientIds);
    }
    const row = await this.updateOwnedDraft(ownerUserId, id, {
      // undefined = unchanged, null = clear.
      title: dto.title,
      contentType: dto.contentType,
      textContent: dto.textContent,
      recipients: dto.recipientIds && {
        deleteMany: {},
        create: assign(dto.recipientIds),
      },
    });
    return toResponse(row);
  }

  // Soft delete; assignments stay attached to the deleted row.
  async remove(ownerUserId: string, id: string): Promise<void> {
    await this.updateOwnedDraft(ownerUserId, id, { deletedAt: new Date() });
  }

  // Never trust UUID secrecy: every requested id must be a live recipient of
  // this owner. The DTO already rejected duplicates, so counts are comparable.
  private async assertOwnedRecipients(
    ownerUserId: string,
    ids: string[],
  ): Promise<void> {
    const owned = await this.prisma.recipient.count({
      where: { id: { in: ids }, ownerUserId, deletedAt: null },
    });
    if (owned !== ids.length) {
      throw new BadRequestException(INVALID_RECIPIENTS);
    }
  }

  // A single conditional UPDATE (owned, live, DRAFT). No match (P2025) is
  // 409 if the owned message exists in another status, otherwise 404.
  private async updateOwnedDraft(
    ownerUserId: string,
    id: string,
    data: Prisma.MessageUpdateInput,
  ): Promise<MessageRow> {
    try {
      return await this.prisma.message.update({
        where: { ...this.owned(ownerUserId, id), status: MessageStatus.DRAFT },
        data,
        select: messageSelect,
      });
    } catch (err) {
      if (
        !(err instanceof Prisma.PrismaClientKnownRequestError) ||
        err.code !== 'P2025'
      ) {
        throw err;
      }
      const exists = await this.prisma.message.count({
        where: this.owned(ownerUserId, id),
      });
      throw exists
        ? new ConflictException(NOT_DRAFT)
        : new NotFoundException(NOT_FOUND);
    }
  }
}
