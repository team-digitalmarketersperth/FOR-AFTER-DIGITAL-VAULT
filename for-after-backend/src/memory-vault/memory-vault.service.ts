import { Injectable, NotFoundException } from '@nestjs/common';
import { MemoryVaultCategory, Prisma } from '../generated/prisma/client.js';
import { isNoMatch } from '../media/media.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { CreateMemoryVaultItemDto } from './dto/create-memory-vault-item.dto.js';
import { UpdateMemoryVaultItemDto } from './dto/update-memory-vault-item.dto.js';

// ownerUserId and deletedAt never leave the API.
const memorySelect = {
  id: true,
  title: true,
  category: true,
  textContent: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.MemoryVaultItemSelect;

export type MemoryResponse = Prisma.MemoryVaultItemGetPayload<{
  select: typeof memorySelect;
}>;

// Same message whether the row is missing, deleted or someone else's.
export const MEMORY_NOT_FOUND = 'Memory not found.';

/**
 * Private Memory Vault items. Not Messages: no status, recipients, schedule
 * or release. Ownership is part of every query, never checked afterwards.
 */
@Injectable()
export class MemoryVaultService {
  constructor(private readonly prisma: PrismaService) {}

  private owned(ownerUserId: string, id: string) {
    return { id, ownerUserId, deletedAt: null };
  }

  create(
    ownerUserId: string,
    dto: CreateMemoryVaultItemDto,
  ): Promise<MemoryResponse> {
    return this.prisma.memoryVaultItem.create({
      data: {
        ownerUserId,
        title: dto.title,
        category: dto.category,
        textContent: dto.textContent,
      },
      select: memorySelect,
    });
  }

  // ponytail: unpaginated; add take/cursor if customers reach hundreds of memories.
  findAllForOwner(
    ownerUserId: string,
    category?: MemoryVaultCategory,
  ): Promise<MemoryResponse[]> {
    return this.prisma.memoryVaultItem.findMany({
      where: { ownerUserId, deletedAt: null, category },
      orderBy: { createdAt: 'desc' },
      select: memorySelect,
    });
  }

  async findOwnedById(
    ownerUserId: string,
    id: string,
  ): Promise<MemoryResponse> {
    const row = await this.prisma.memoryVaultItem.findFirst({
      where: this.owned(ownerUserId, id),
      select: memorySelect,
    });
    if (!row) throw new NotFoundException(MEMORY_NOT_FOUND);
    return row;
  }

  // Explicit field list, so nothing else from a request reaches the database.
  update(
    ownerUserId: string,
    id: string,
    dto: UpdateMemoryVaultItemDto,
  ): Promise<MemoryResponse> {
    return this.updateOwned(ownerUserId, id, {
      title: dto.title,
      category: dto.category,
      textContent: dto.textContent,
    });
  }

  // Soft delete. Its media becomes unreachable at once (every media query
  // requires a live parent); stored objects are left for future reconciliation.
  async remove(ownerUserId: string, id: string): Promise<void> {
    await this.updateOwned(ownerUserId, id, { deletedAt: new Date() });
  }

  // A single conditional UPDATE, so there is no gap between the ownership
  // check and the write. No matching row (P2025) becomes a plain 404.
  private async updateOwned(
    ownerUserId: string,
    id: string,
    data: Prisma.MemoryVaultItemUpdateInput,
  ): Promise<MemoryResponse> {
    try {
      return await this.prisma.memoryVaultItem.update({
        where: this.owned(ownerUserId, id),
        data,
        select: memorySelect,
      });
    } catch (err) {
      if (isNoMatch(err)) throw new NotFoundException(MEMORY_NOT_FOUND);
      throw err;
    }
  }
}
