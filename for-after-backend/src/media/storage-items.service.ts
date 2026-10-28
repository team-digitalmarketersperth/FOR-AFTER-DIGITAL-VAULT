import { Injectable } from '@nestjs/common';
import { paginate } from '../audit/audit-log.service.js';
import { MediaKind, Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { StorageItemsQueryDto } from './dto/storage-items-query.dto.js';
import { ownedMedia, type StorageSource } from './storage-quota.service.js';

/** Why the Storage Manager offers no delete (the source feature's own rule). */
export type DeleteRestriction =
  'MESSAGE_SCHEDULED' | 'MESSAGE_RELEASED' | 'MESSAGE_LOCKED';

/**
 * One counted file, for management only. `sourceId` is what the source
 * feature's own routes use (message id, memory id, My Story / My Wishes
 * prompt key, Recipient id); deleting goes through that feature's endpoint.
 * Never: owner, storage key, provider id or URL, deletedAt.
 */
export type StorageItem = {
  id: string;
  type: MediaKind;
  sizeBytes: number;
  source: StorageSource;
  sourceId: string;
  displayName: string;
  createdAt: Date;
  canDelete: boolean;
  deleteRestriction: DeleteRestriction | null;
};

const ORDER: Record<StorageItemsQueryDto['sort'], Prisma.Sql> = {
  // id breaks ties, so pages never repeat or skip a file.
  size_desc: Prisma.sql`"sizeBytes" DESC, "createdAt" DESC, id ASC`,
  created_desc: Prisma.sql`"createdAt" DESC, id ASC`,
  created_asc: Prisma.sql`"createdAt" ASC, id ASC`,
};

// Only Message media can be locked: its parent rules (DRAFT only) decide.
const restriction = (
  source: StorageSource,
  messageStatus: string | null,
): DeleteRestriction | null => {
  if (source !== 'MESSAGE' || messageStatus === 'DRAFT') return null;
  if (messageStatus === 'SCHEDULED') return 'MESSAGE_SCHEDULED';
  if (messageStatus === 'RELEASED') return 'MESSAGE_RELEASED';
  return 'MESSAGE_LOCKED';
};

type Row = {
  id: string;
  kind: MediaKind;
  sizeBytes: number;
  createdAt: Date;
  source: StorageSource;
  sourceId: string;
  label: string;
  messageStatus: string | null;
};

/**
 * Storage Manager list (read only). Exactly the rows the quota counts as used
 * (READY, not deleted; uploads in progress are only the reserved total), so
 * the list and the totals agree. Filtering, sorting and paging happen in
 * PostgreSQL, every branch scoped to the owner.
 */
@Injectable()
export class StorageItemsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(ownerUserId: string, q: StorageItemsQueryDto) {
    const where = Prisma.sql`"deletedAt" IS NULL AND status = 'READY'
      ${q.type ? Prisma.sql`AND kind = ${q.type}` : Prisma.empty}
      ${q.source ? Prisma.sql`AND source = ${q.source}` : Prisma.empty}`;
    const [rows, [{ total }]] = await Promise.all([
      this.prisma.$queryRaw<Row[]>`
        SELECT f.id, f.kind, f."sizeBytes", f."createdAt", f.source,
          CASE f.source
            WHEN 'MY_STORY' THEN s."promptKey"
            WHEN 'MY_WISHES' THEN w."promptKey"
            ELSE f."parentId"::text END AS "sourceId",
          -- Safe context only: a title, the prompt wording or a name, never
          -- the Customer's own answer text.
          CASE f.source
            WHEN 'MESSAGE' THEN m.title
            WHEN 'MEMORY_VAULT' THEN v.title
            WHEN 'MY_STORY' THEN s."promptTextSnapshot"
            WHEN 'MY_WISHES' THEN w."promptTextSnapshot"
            ELSE concat_ws(' ', r."firstName", r."lastName") END AS label,
          m.status::text AS "messageStatus"
        FROM (SELECT * FROM (${ownedMedia(ownerUserId)}) owned WHERE ${where}) f
        LEFT JOIN "Message" m ON f.source = 'MESSAGE' AND m.id = f."parentId"
        LEFT JOIN "MemoryVaultItem" v ON f.source = 'MEMORY_VAULT' AND v.id = f."parentId"
        LEFT JOIN "MyStoryResponse" s ON f.source = 'MY_STORY' AND s.id = f."parentId"
        LEFT JOIN "MyWishResponse" w ON f.source = 'MY_WISHES' AND w.id = f."parentId"
        LEFT JOIN "Recipient" r ON f.source = 'RECIPIENT_PHOTO' AND r.id = f."parentId"
        ORDER BY ${ORDER[q.sort]}
        LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}`,
      this.prisma.$queryRaw<{ total: number }[]>`
        SELECT count(*)::int AS total
        FROM (${ownedMedia(ownerUserId)}) owned WHERE ${where}`,
    ]);
    const items: StorageItem[] = rows.map((r) => {
      const deleteRestriction = restriction(r.source, r.messageStatus);
      return {
        id: r.id,
        type: r.kind,
        sizeBytes: r.sizeBytes,
        source: r.source,
        sourceId: r.sourceId,
        displayName: r.label?.trim() || '',
        createdAt: r.createdAt,
        canDelete: !deleteRestriction,
        deleteRestriction,
      };
    });
    return { items, pagination: paginate(q.page, q.limit, total) };
  }
}
