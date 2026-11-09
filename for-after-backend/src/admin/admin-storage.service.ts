import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { paginate } from '../audit/audit-log.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { StorageAssetQueryDto } from './dto/admin.dto.js';

/**
 * Storage & scans (docs/admin.md §21): read-only metadata over the six media
 * tables. One row = one stored file (storageKey is unique per table and every
 * row has exactly one parent; "message from a memory" makes its own copy), so
 * rows are counted once. Bytes follow StorageQuota: READY = verified against
 * the provider on complete; PENDING_UPLOAD = client-declared reservation.
 * No scan result, reason or time is stored per file, so none is derived here.
 * Never selects storageKey, providerFileId, file names, MIME types or titles.
 */
export const STORAGE_SOURCES = ['MESSAGE', 'MEMORY_VAULT', 'MY_STORY', 'MY_WISHES', 'RECIPIENT_PHOTO', 'DEATH_EVIDENCE'] as const;
export type StorageSourceKey = (typeof STORAGE_SOURCES)[number];
export const UPLOAD_STATES = ['pending', 'ready', 'failed'] as const;
export const DELETION_STATES = ['active', 'pending', 'confirmed'] as const;
export const MEDIA_KINDS = ['PHOTO', 'AUDIO', 'VIDEO'] as const;

// Constant SQL only (no input reaches these fragments).
const TABLES: [StorageSourceKey, string, string, string][] = [
  ['MESSAGE', '"MediaAsset"', 'kind::text', '"ownerUserId"'],
  ['MEMORY_VAULT', '"MemoryVaultMediaAsset"', 'kind::text', '"ownerUserId"'],
  ['MY_STORY', '"MyStoryMediaAsset"', 'kind::text', '"ownerUserId"'],
  ['MY_WISHES', '"MyWishMediaAsset"', 'kind::text', '"ownerUserId"'],
  ['RECIPIENT_PHOTO', '"RecipientPhoto"', 'kind::text', '"ownerUserId"'],
  // Evidence: no kind column, and no account shown (case privacy, §21).
  ['DEATH_EVIDENCE', '"DeathVerificationEvidence"', 'NULL::text', 'NULL::uuid'],
];
const ALL_MEDIA = Prisma.raw(
  `(${TABLES.map(
    ([source, table, kind, owner]) =>
      `SELECT id, '${source}' AS source, ${kind} AS kind, ${owner} AS "ownerUserId", status::text AS status,
              "sizeBytes", "storageProvider"::text AS provider, "createdAt", "updatedAt", "uploadedAt",
              "deletedAt", "storageDeletedAt",
              CASE WHEN "storageDeletedAt" IS NOT NULL THEN 'confirmed'
                   WHEN "deletedAt" IS NOT NULL OR status = 'FAILED' THEN 'pending'
                   ELSE 'active' END AS deletion
       FROM ${table}`,
  ).join('\nUNION ALL\n')}) media`,
);

type Row = {
  id: string;
  source: StorageSourceKey;
  kind: string | null;
  ownerUserId: string | null;
  status: 'PENDING_UPLOAD' | 'READY' | 'FAILED';
  sizeBytes: number;
  provider: 'IMAGEKIT' | 'B2';
  createdAt: Date;
  updatedAt: Date;
  uploadedAt: Date | null;
  deletedAt: Date | null;
  storageDeletedAt: Date | null;
  deletion: (typeof DELETION_STATES)[number];
};

const STATE = { PENDING_UPLOAD: 'pending', READY: 'ready', FAILED: 'failed' } as const;
const STATUS = { pending: 'PENDING_UPLOAD', ready: 'READY', failed: 'FAILED' } as const;
const iso = (d: Date | null) => d?.toISOString() ?? null;

/** The response DTO: operational metadata only. */
export const toStorageAsset = (r: Row) => ({
  reference: r.id,
  source: r.source,
  kind: r.kind,
  accountId: r.ownerUserId,
  sizeBytes: r.sizeBytes,
  // Only a completed upload's size was compared with the stored object.
  sizeVerified: r.status === 'READY',
  uploadState: STATE[r.status],
  deletion: r.deletion,
  // Legacy B2 files are never removed automatically (MediaCleanup).
  legacyStorage: r.provider === 'B2',
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
  verifiedAt: iso(r.uploadedAt),
  deletedAt: iso(r.deletedAt),
  storageDeletedAt: iso(r.storageDeletedAt),
});

const SOURCE_TOTALS = () => ({
  pending: 0,
  ready: 0,
  failed: 0,
  verifiedBytes: 0,
  reservedBytes: 0,
  deletionPending: 0,
  deletionConfirmed: 0,
  total: 0,
});
export type SourceTotals = ReturnType<typeof SOURCE_TOTALS>;

const DAY = 24 * 60 * 60 * 1000;
export const MAX_RANGE_DAYS = 366;

@Injectable()
export class AdminStorageService {
  private readonly logger = new Logger(AdminStorageService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Per source: live (not soft-deleted) rows by upload state, verified and
   * reserved bytes (StorageQuota's definitions, summed over all owners), and
   * rows by deletion state. Rows, not provider objects.
   */
  async summary() {
    const groups = await this.prisma.$queryRaw<
      { source: StorageSourceKey; status: Row['status']; deletion: Row['deletion']; live: boolean; n: number; bytes: bigint }[]
    >`SELECT source, status, deletion, ("deletedAt" IS NULL) AS live, count(*)::int AS n,
             COALESCE(SUM("sizeBytes"), 0)::bigint AS bytes
      FROM ${ALL_MEDIA} GROUP BY source, status, deletion, live`;
    const bySource = Object.fromEntries(STORAGE_SOURCES.map((s) => [s, SOURCE_TOTALS()])) as Record<StorageSourceKey, SourceTotals>;
    for (const g of groups) {
      const t = bySource[g.source];
      t.total += g.n;
      if (g.deletion === 'pending') t.deletionPending += g.n;
      if (g.deletion === 'confirmed') t.deletionConfirmed += g.n;
      if (!g.live) continue;
      t[STATE[g.status]] += g.n;
      if (g.status === 'READY') t.verifiedBytes += Number(g.bytes);
      if (g.status === 'PENDING_UPLOAD') t.reservedBytes += Number(g.bytes);
    }
    return bySource;
  }

  async list(q: StorageAssetQueryDto, now = new Date()) {
    if (q.from && q.to) {
      const span = new Date(q.to).getTime() - new Date(q.from).getTime();
      if (span < 0) throw new BadRequestException('from must be before to');
      if (span > MAX_RANGE_DAYS * DAY) throw new BadRequestException(`The time range can be at most ${MAX_RANGE_DAYS} days.`);
    }
    const where = [
      q.source && Prisma.sql`source = ${q.source}`,
      q.uploadState && Prisma.sql`status = ${STATUS[q.uploadState]}`,
      q.deletion && Prisma.sql`deletion = ${q.deletion}`,
      q.kind && Prisma.sql`kind = ${q.kind}`,
      q.reference && Prisma.sql`id = ${q.reference}::uuid`,
      q.accountId && Prisma.sql`"ownerUserId" = ${q.accountId}::uuid`,
      q.from && Prisma.sql`"createdAt" >= ${new Date(q.from)}`,
      q.to && Prisma.sql`"createdAt" <= ${new Date(q.to)}`,
    ].filter((c): c is Prisma.Sql => !!c);
    const whereSql = where.length ? Prisma.sql`WHERE ${Prisma.join(where, ' AND ')}` : Prisma.empty;
    // Allowlisted column and direction; id breaks ties.
    const column = Prisma.raw(q.sort === 'updatedAt' ? '"updatedAt"' : '"createdAt"');
    const dir = Prisma.raw(q.dir === 'asc' ? 'ASC' : 'DESC');
    const [items, [{ total }], summary] = await Promise.all([
      this.prisma.$queryRaw<Row[]>`SELECT * FROM ${ALL_MEDIA} ${whereSql}
        ORDER BY ${column} ${dir}, id ${dir} LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}`,
      this.prisma.$queryRaw<{ total: number }[]>`SELECT count(*)::int AS total FROM ${ALL_MEDIA} ${whereSql}`,
      // Independent: a failed summary is null (shown "Unavailable"), never zeros.
      this.summary().catch((err: unknown) => {
        this.logger.error(`admin_storage_summary_unavailable (${err instanceof Error ? err.name : 'UNKNOWN'})`);
        return null;
      }),
    ]);
    return {
      evaluatedAt: now.toISOString(),
      summary,
      items: items.map(toStorageAsset),
      pagination: paginate(q.page, q.limit, total),
    };
  }

  async get(reference: string) {
    const [found] = await this.prisma.$queryRaw<Row[]>`SELECT * FROM ${ALL_MEDIA} WHERE id = ${reference}::uuid LIMIT 1`;
    if (!found) throw new NotFoundException('Stored file record not found.');
    return toStorageAsset(found);
  }
}
