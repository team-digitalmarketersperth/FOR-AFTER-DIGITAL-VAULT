import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
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
} satisfies Prisma.RecipientSelect;

type RecipientRow = Prisma.RecipientGetPayload<{
  select: typeof recipientSelect;
}>;
export type RecipientResponse = Omit<RecipientRow, 'birthday'> & {
  birthday: string | null;
};

// Same message whether the row is missing, deleted or someone else's.
const NOT_FOUND = 'Recipient not found.';

const toResponse = (row: RecipientRow): RecipientResponse => ({
  ...row,
  birthday: row.birthday?.toISOString().slice(0, 10) ?? null,
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

  // ponytail: unpaginated; add take/cursor if customers reach hundreds of recipients.
  async findAllForOwner(ownerUserId: string): Promise<RecipientResponse[]> {
    const rows = await this.prisma.recipient.findMany({
      where: { ownerUserId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      select: recipientSelect,
    });
    return rows.map(toResponse);
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
