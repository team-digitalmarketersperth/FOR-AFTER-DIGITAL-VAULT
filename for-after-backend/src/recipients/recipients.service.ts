import { Injectable, NotFoundException } from '@nestjs/common';
import { paginate } from '../audit/audit-log.service.js';
import { MediaAssetStatus, Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { CreateRecipientDto } from './dto/create-recipient.dto.js';
import { UpdateRecipientDto } from './dto/update-recipient.dto.js';

// ownerUserId and deletedAt never leave the API.
const recipientSelect = {
  id: true,
  firstName: true,
  lastName: true,
  relationship: true,
  email: true,
  mobile: true,
  birthday: true,
  privateNote: true,
  createdAt: true,
  updatedAt: true,
  // Phase 09: the current photo's id only (or none). Its signed URL is asked
  // for separately, when an avatar is actually shown.
  photos: {
    where: { status: MediaAssetStatus.READY, deletedAt: null },
    select: { id: true },
    take: 1,
  },
} satisfies Prisma.RecipientSelect;

type RecipientRow = Prisma.RecipientGetPayload<{
  select: typeof recipientSelect;
}>;
export type RecipientResponse = Omit<RecipientRow, 'birthday' | 'photos'> & {
  birthday: string | null;
  photoId: string | null;
};
export type RecipientPage = {
  items: RecipientResponse[];
  pagination: ReturnType<typeof paginate>;
};

// Same message whether the row is missing, deleted or someone else's.
const NOT_FOUND = 'Recipient not found.';

const toResponse = ({ photos, ...row }: RecipientRow): RecipientResponse => ({
  ...row,
  birthday: row.birthday?.toISOString().slice(0, 10) ?? null,
  photoId: photos[0]?.id ?? null,
});

// Explicit field list, so nothing else from a request can reach the database.
const toData = (dto: UpdateRecipientDto) => ({
  firstName: dto.firstName,
  lastName: dto.lastName,
  relationship: dto.relationship,
  email: dto.email,
  mobile: dto.mobile,
  birthday: dto.birthday == null ? dto.birthday : new Date(dto.birthday),
  privateNote: dto.privateNote,
});

@Injectable()
export class RecipientsService {
  constructor(private readonly prisma: PrismaService) {}

  // Every read and write goes through this filter: ownership is part of the
  // query itself, never checked after fetching by id alone.
  private owned(ownerUserId: string, id: string) {
    return { id, ownerUserId, deletedAt: null };
  }

  async create(
    ownerUserId: string,
    dto: CreateRecipientDto,
  ): Promise<RecipientResponse> {
    const row = await this.prisma.recipient.create({
      data: { ...toData(dto), firstName: dto.firstName, ownerUserId },
      select: recipientSelect,
    });
    return toResponse(row);
  }

  /**
   * One page of the owner's live recipients, newest first (id breaks ties, so
   * pages never overlap or skip). The count uses the same owner filter: no
   * other Customer's rows are ever counted. A page past the end is empty.
   */
  async findAllForOwner(
    ownerUserId: string,
    page: number,
    limit: number,
  ): Promise<RecipientPage> {
    const where = { ownerUserId, deletedAt: null };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.recipient.count({ where }),
      this.prisma.recipient.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        select: recipientSelect,
      }),
    ]);
    return {
      items: rows.map(toResponse),
      pagination: paginate(page, limit, total),
    };
  }

  async findOwnedById(
    ownerUserId: string,
    id: string,
  ): Promise<RecipientResponse> {
    const row = await this.prisma.recipient.findFirst({
      where: this.owned(ownerUserId, id),
      select: recipientSelect,
    });
    if (!row) throw new NotFoundException(NOT_FOUND);
    return toResponse(row);
  }

  async update(
    ownerUserId: string,
    id: string,
    dto: UpdateRecipientDto,
  ): Promise<RecipientResponse> {
    return toResponse(await this.updateOwned(ownerUserId, id, toData(dto)));
  }

  // Soft delete: future messages will reference recipients.
  async remove(ownerUserId: string, id: string): Promise<void> {
    await this.updateOwned(ownerUserId, id, { deletedAt: new Date() });
  }

  // A single conditional UPDATE, so there is no gap between the ownership
  // check and the write. No matching row (P2025) becomes a plain 404.
  private async updateOwned(
    ownerUserId: string,
    id: string,
    data: Prisma.RecipientUpdateInput,
  ): Promise<RecipientRow> {
    try {
      return await this.prisma.recipient.update({
        where: this.owned(ownerUserId, id),
        data,
        select: recipientSelect,
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2025'
      ) {
        throw new NotFoundException(NOT_FOUND);
      }
      throw err;
    }
  }
}
