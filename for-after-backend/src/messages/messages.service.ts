import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { paginate } from '../audit/audit-log.service.js';
import {
  MessageContentType,
  MessageStatus,
  Prisma,
} from '../generated/prisma/client.js';
import { MediaCleanup } from '../media/media-cleanup.service.js';
import { storedRefSelect } from '../media/media.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { CreateMessageDto } from './dto/create-message.dto.js';
import { UpdateMessageDto } from './dto/update-message.dto.js';

// Recipients deleted after assignment are hidden.
const recipientsSelect = {
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
} satisfies Prisma.Message$recipientsArgs;

// ownerUserId, deletedAt and join-table ids never leave the API.
const messageSelect = {
  id: true,
  title: true,
  contentType: true,
  textContent: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  recipients: recipientsSelect,
} satisfies Prisma.MessageSelect;

// The list shows only what the Messages page renders: no full text (a short
// preview instead), no media and no signed URLs. Details: GET /messages/:id.
const summarySelect = {
  id: true,
  title: true,
  contentType: true,
  status: true,
  updatedAt: true,
  textContent: true,
  recipients: recipientsSelect,
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

type SummaryRow = Prisma.MessageGetPayload<{ select: typeof summarySelect }>;
export type MessageSummary = Omit<SummaryRow, 'textContent' | 'recipients'> & {
  textPreview: string | null;
  recipients: MessageResponse['recipients'];
};
export type MessagePage = {
  items: MessageSummary[];
  pagination: ReturnType<typeof paginate>;
};

export const TEXT_PREVIEW_MAX = 200;

// First TEXT_PREVIEW_MAX characters (code points, so no emoji is split) + '…'.
export const textPreview = (text: string | null): string | null => {
  // Code units >= code points, so short strings need no splitting.
  if (!text || text.length <= TEXT_PREVIEW_MAX) return text;
  const chars = Array.from(text);
  return chars.length <= TEXT_PREVIEW_MAX
    ? text
    : `${chars.slice(0, TEXT_PREVIEW_MAX).join('').trimEnd()}…`;
};

const toResponse = ({ recipients, ...row }: MessageRow): MessageResponse => ({
  ...row,
  recipients: recipients.map((r) => r.recipient),
});

const assign = (recipientIds: string[]) =>
  recipientIds.map((recipientId) => ({ recipientId }));

@Injectable()
export class MessagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cleanup: MediaCleanup,
  ) {}

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

  /**
   * One page of the owner's live messages as summaries, newest first (id
   * breaks ties, so pages never overlap or skip). The count uses the same
   * owner filter. A page past the end is empty.
   */
  // ponytail: full text is still read from PostgreSQL to cut the preview; select a substring if lists get heavy.
  async findPageForOwner(
    ownerUserId: string,
    page: number,
    limit: number,
  ): Promise<MessagePage> {
    const where = { ownerUserId, deletedAt: null };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.message.count({ where }),
      this.prisma.message.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        select: summarySelect,
      }),
    ]);
    return {
      items: rows.map(({ textContent, recipients, ...row }) => ({
        ...row,
        textPreview: textPreview(textContent),
        recipients: recipients.map((r) => r.recipient),
      })),
      pagination: paginate(page, limit, total),
    };
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

  /**
   * Soft delete; assignments stay attached to the deleted row. Its live media
   * (any status) are soft-deleted in the same UPDATE, so the database is
   * authoritative at once: every media route already refuses a deleted
   * message. Files are removed after commit, best effort; a provider failure
   * never restores access and is retried by the media cleanup reconciler
   * (logged by id only). Media only change under this same DRAFT row lock, so
   * none can be added once this commits.
   */
  async remove(ownerUserId: string, id: string): Promise<void> {
    const deletedAt = new Date();
    const { mediaAssets } = await this.updateOwnedDraft(
      ownerUserId,
      id,
      {
        deletedAt,
        mediaAssets: {
          updateMany: { where: { deletedAt: null }, data: { deletedAt } },
        },
      },
      // Read after the write: exactly the assets this delete just hid.
      { mediaAssets: { where: { deletedAt }, select: storedRefSelect } },
    );
    await this.cleanup.purge('mediaAsset', mediaAssets);
  }

  // Never trust UUID secrecy: every requested id must be a live recipient of
  // this owner. The DTO already rejected duplicates, so counts are comparable.
  // Also used by Memory Vault's create-message (Phase 13B).
  async assertOwnedRecipients(
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
  private async updateOwnedDraft<
    S extends Prisma.MessageSelect = typeof messageSelect,
  >(
    ownerUserId: string,
    id: string,
    data: Prisma.MessageUpdateInput,
    select: S = messageSelect as S,
  ): Promise<Prisma.MessageGetPayload<{ select: S }>> {
    try {
      return (await this.prisma.message.update({
        where: { ...this.owned(ownerUserId, id), status: MessageStatus.DRAFT },
        data,
        select,
      })) as Prisma.MessageGetPayload<{ select: S }>;
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
