import { Injectable, NotFoundException } from '@nestjs/common';
import { paginate } from '../audit/audit-log.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { MediaCleanup } from '../media/media-cleanup.service.js';
import { isNoMatch, storedRefSelect } from '../media/media.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  CreateMemoryVaultItemDto,
  MemoryVaultQueryDto,
  normalizeTag,
} from './dto/create-memory-vault-item.dto.js';
import { UpdateMemoryVaultItemDto } from './dto/update-memory-vault-item.dto.js';

const tagSelect = {
  id: true,
  name: true,
} satisfies Prisma.MemoryVaultTagSelect;

// ownerUserId and deletedAt never leave the API; tags are { id, name } only.
const memorySelect = {
  id: true,
  title: true,
  category: true,
  textContent: true,
  createdAt: true,
  updatedAt: true,
  tags: {
    select: { tag: { select: tagSelect } },
    orderBy: { tag: { normalizedName: 'asc' } },
  },
} satisfies Prisma.MemoryVaultItemSelect;

type MemoryRow = Prisma.MemoryVaultItemGetPayload<{
  select: typeof memorySelect;
}>;
export type MemoryTag = Prisma.MemoryVaultTagGetPayload<{
  select: typeof tagSelect;
}>;
export type MemoryResponse = Omit<MemoryRow, 'tags'> & { tags: MemoryTag[] };
export type MemoryPage = {
  items: MemoryResponse[];
  pagination: ReturnType<typeof paginate>;
};

const toResponse = ({ tags, ...row }: MemoryRow): MemoryResponse => ({
  ...row,
  tags: tags.map((t) => t.tag),
});

// Same message whether the row is missing, deleted or someone else's.
export const MEMORY_NOT_FOUND = 'Memory not found.';

/**
 * Private Memory Vault items. Not Messages: no status, recipients, schedule
 * or release. Ownership is part of every query, never checked afterwards.
 */
@Injectable()
export class MemoryVaultService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cleanup: MediaCleanup,
  ) {}

  private owned(ownerUserId: string, id: string) {
    return { id, ownerUserId, deletedAt: null };
  }

  /**
   * The owner's tags for these names, created when new (first spelling kept).
   * Only ever looks at this owner's tags, so another Customer's tag can never
   * be attached. skipDuplicates absorbs a concurrent create of the same name.
   */
  private async tagLinks(
    tx: Prisma.TransactionClient,
    ownerUserId: string,
    names: string[],
  ) {
    const byKey = new Map<string, string>();
    for (const name of names) {
      const key = normalizeTag(name);
      if (!byKey.has(key)) byKey.set(key, name);
    }
    if (!byKey.size) return [];
    await tx.memoryVaultTag.createMany({
      data: [...byKey].map(([normalizedName, name]) => ({
        ownerUserId,
        name,
        normalizedName,
      })),
      skipDuplicates: true,
    });
    const tags = await tx.memoryVaultTag.findMany({
      where: { ownerUserId, normalizedName: { in: [...byKey.keys()] } },
      select: { id: true },
    });
    return tags.map((t) => ({ tagId: t.id }));
  }

  async create(
    ownerUserId: string,
    dto: CreateMemoryVaultItemDto,
  ): Promise<MemoryResponse> {
    const row = await this.prisma.$transaction(async (tx) =>
      tx.memoryVaultItem.create({
        data: {
          ownerUserId,
          title: dto.title,
          category: dto.category,
          textContent: dto.textContent,
          tags: {
            create: await this.tagLinks(tx, ownerUserId, dto.tags ?? []),
          },
        },
        select: memorySelect,
      }),
    );
    return toResponse(row);
  }

  /**
   * One page of the owner's live memories, newest first (id breaks ties, so
   * pages never overlap or skip). Category, tag and search all narrow the
   * same WHERE, which the count uses too: totals never include other
   * Customers, deleted items or other filters' rows. A page past the end is
   * empty. Search: title or text, case-insensitive substring.
   */
  // ponytail: ILIKE substring scan per owner; add pg_trgm/full-text if vaults grow to thousands.
  async findPageForOwner(
    ownerUserId: string,
    q: MemoryVaultQueryDto,
  ): Promise<MemoryPage> {
    const tag = q.tag ? normalizeTag(q.tag) : undefined;
    // Prisma's contains does not escape LIKE wildcards: "%" or "_" typed in
    // the box must match themselves, not everything.
    const search = q.search?.replace(/[\\%_]/g, '\\$&');
    const where: Prisma.MemoryVaultItemWhereInput = {
      ownerUserId,
      deletedAt: null,
      category: q.category,
      tags: tag
        ? { some: { tag: { ownerUserId, normalizedName: tag } } }
        : undefined,
      OR: search
        ? (['title', 'textContent'] as const).map((field) => ({
            [field]: { contains: search, mode: 'insensitive' as const },
          }))
        : undefined,
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.memoryVaultItem.count({ where }),
      this.prisma.memoryVaultItem.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (q.page - 1) * q.limit,
        take: q.limit,
        select: memorySelect,
      }),
    ]);
    return {
      items: rows.map(toResponse),
      pagination: paginate(q.page, q.limit, total),
    };
  }

  // The owner's tags, for the filter and suggestions; unused ones included.
  // ponytail: unpaginated; a Customer's tag list is small.
  findTags(ownerUserId: string): Promise<MemoryTag[]> {
    return this.prisma.memoryVaultTag.findMany({
      where: { ownerUserId },
      orderBy: { normalizedName: 'asc' },
      select: tagSelect,
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
    return toResponse(row);
  }

  /**
   * Explicit field list, so nothing else from a request reaches the database.
   * One conditional UPDATE (no gap between the ownership check and the
   * write); tags present = the tag set is replaced in the same transaction.
   * No matching row (P2025) rolls back and becomes a plain 404.
   */
  async update(
    ownerUserId: string,
    id: string,
    dto: UpdateMemoryVaultItemDto,
  ): Promise<MemoryResponse> {
    try {
      const row = await this.prisma.$transaction(async (tx) =>
        tx.memoryVaultItem.update({
          where: this.owned(ownerUserId, id),
          data: {
            title: dto.title,
            category: dto.category,
            textContent: dto.textContent,
            tags: dto.tags && {
              deleteMany: {},
              create: await this.tagLinks(tx, ownerUserId, dto.tags),
            },
          },
          select: memorySelect,
        }),
      );
      return toResponse(row);
    } catch (err) {
      if (isNoMatch(err)) throw new NotFoundException(MEMORY_NOT_FOUND);
      throw err;
    }
  }

  // Soft delete, with its live media soft-deleted in the same UPDATE (Phase
  // 12, like a message); their files are then removed, best effort. Tags stay.
  async remove(ownerUserId: string, id: string): Promise<void> {
    const deletedAt = new Date();
    let deleted;
    try {
      deleted = await this.prisma.memoryVaultItem.update({
        where: this.owned(ownerUserId, id),
        data: {
          deletedAt,
          mediaAssets: {
            updateMany: { where: { deletedAt: null }, data: { deletedAt } },
          },
        },
        // Read after the write: exactly the media this delete just hid.
        select: {
          mediaAssets: { where: { deletedAt }, select: storedRefSelect },
        },
      });
    } catch (err) {
      if (isNoMatch(err)) throw new NotFoundException(MEMORY_NOT_FOUND);
      throw err;
    }
    await this.cleanup.purge('memoryVaultMediaAsset', deleted.mediaAssets);
  }
}
