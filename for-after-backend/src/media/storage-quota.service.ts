import { ConflictException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  billingPolicy,
  type BillingPolicy,
  entitlements,
  resolveAccess,
} from '../billing/billing-access.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

const GIB = 1024 ** 3;

export type StorageLevel = 'NORMAL' | 'WARNING' | 'HIGH' | 'FULL';

/** Where a counted file lives: one value per storage-bearing table. */
export const STORAGE_SOURCES = [
  'MESSAGE',
  'MEMORY_VAULT',
  'MY_STORY',
  'MY_WISHES',
  'RECIPIENT_PHOTO',
] as const;
export type StorageSource = (typeof STORAGE_SOURCES)[number];

export type StorageUsage = {
  usedBytes: number;
  reservedBytes: number;
  limitBytes: number;
  remainingBytes: number;
  percentage: number;
  level: StorageLevel;
  /** READY bytes per source (Storage Manager); sums to usedBytes. */
  breakdown: { source: StorageSource; bytes: number }[];
};

/**
 * The five owner-scoped media tables as one row set (id, kind, size, dates,
 * source, parent id). The single definition behind both the quota and the
 * Storage Manager list, so their totals can never drift apart.
 */
export const ownedMedia = (ownerUserId: string) => Prisma.sql`
  SELECT id, kind::text AS kind, status::text AS status, "sizeBytes", "createdAt", "deletedAt",
         'MESSAGE' AS source, "messageId" AS "parentId"
  FROM "MediaAsset" WHERE "ownerUserId" = ${ownerUserId}::uuid
  UNION ALL
  SELECT id, kind::text, status::text, "sizeBytes", "createdAt", "deletedAt",
         'MEMORY_VAULT', "memoryVaultItemId"
  FROM "MemoryVaultMediaAsset" WHERE "ownerUserId" = ${ownerUserId}::uuid
  UNION ALL
  SELECT id, kind::text, status::text, "sizeBytes", "createdAt", "deletedAt",
         'RECIPIENT_PHOTO', "recipientId"
  FROM "RecipientPhoto" WHERE "ownerUserId" = ${ownerUserId}::uuid
  UNION ALL
  SELECT id, kind::text, status::text, "sizeBytes", "createdAt", "deletedAt",
         'MY_STORY', "myStoryResponseId"
  FROM "MyStoryMediaAsset" WHERE "ownerUserId" = ${ownerUserId}::uuid
  UNION ALL
  SELECT id, kind::text, status::text, "sizeBytes", "createdAt", "deletedAt",
         'MY_WISHES', "myWishResponseId"
  FROM "MyWishMediaAsset" WHERE "ownerUserId" = ${ownerUserId}::uuid`;

// Generic on purpose: no other Customer's data, no plan or internal detail.
export const STORAGE_FULL =
  'Your storage is full. Delete files you no longer need to add new ones.';
export const NOT_ENOUGH_STORAGE =
  'This file is larger than your remaining storage.';

/** 80 / 90 / 100 % of the limit, in integer byte math. */
export const storageLevel = (counted: number, limit: number): StorageLevel =>
  counted >= limit
    ? 'FULL'
    : counted * 10 >= limit * 9
      ? 'HIGH'
      : counted * 10 >= limit * 8
        ? 'WARNING'
        : 'NORMAL';

type Client = PrismaService | Prisma.TransactionClient;

/**
 * Phase 12C storage quota, owned by the application (never read from the
 * provider). Approved policy (2026-10-08): one limit per Customer,
 * STORAGE_LIMIT_BYTES (default 5 GiB); since 2026-11-12 an enforced active
 * trial gets TRIAL_STORAGE_BYTES instead (billing-access entitlements()),
 * resolved from the account's own billing rows, never the request. Counted:
 * Message media, Memory Vault media, Recipient photos, My Story media
 * (Phase 14B) and My Wishes media (Phase 15B) that are READY, plus
 * uploads in progress (PENDING_UPLOAD reserves its declared size). FAILED and
 * deleted rows never count; a stale PENDING_UPLOAD stops counting when
 * MediaCleanup retires it.
 */
@Injectable()
export class StorageQuota {
  /** The configured limit; an account's own allowance comes from allowance(). */
  readonly limitBytes: number;
  // Same billingPolicy() as BillingService, read here so MediaModule needs no BillingModule and reserve() can resolve the allowance through its own transaction.
  private readonly policy: BillingPolicy;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    // Not media.service's positiveInt: that module imports this one.
    const limit = Number(config.get<string>('STORAGE_LIMIT_BYTES') ?? 5 * GIB);
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new Error('STORAGE_LIMIT_BYTES must be a positive whole number.');
    }
    this.limitBytes = limit;
    this.policy = billingPolicy((key) => config.get<string>(key));
  }

  /** The account's storage allowance from its billing state, read through `client` (inside reserve's lock). */
  async allowance(
    client: Client,
    ownerUserId: string,
    now = new Date(),
  ): Promise<number> {
    const access = await resolveAccess(client, ownerUserId, this.policy, now);
    return entitlements(access, this.limitBytes).storageBytes;
  }

  // One owner-scoped SUM over the five media tables, per status and source.
  // Integers throughout: sizeBytes is an INT, sums fit a JS number exactly.
  private async totals(client: Client, ownerUserId: string) {
    const rows = await client.$queryRaw<
      { status: string; source: StorageSource; bytes: bigint }[]
    >`
      SELECT status, source, COALESCE(SUM("sizeBytes"), 0)::bigint AS bytes
      FROM (${ownedMedia(ownerUserId)}) owned
      WHERE "deletedAt" IS NULL AND status IN ('READY', 'PENDING_UPLOAD')
      GROUP BY status, source`;
    const sum = (status: string, source?: StorageSource) =>
      rows
        .filter((r) => r.status === status && (!source || r.source === source))
        .reduce((total, r) => total + Number(r.bytes), 0);
    return {
      ready: sum('READY'),
      pending: sum('PENDING_UPLOAD'),
      breakdown: STORAGE_SOURCES.map((source) => ({
        source,
        bytes: sum('READY', source),
      })),
    };
  }

  async usage(ownerUserId: string): Promise<StorageUsage> {
    const [{ ready, pending, breakdown }, limit] = await Promise.all([
      this.totals(this.prisma, ownerUserId),
      this.allowance(this.prisma, ownerUserId),
    ]);
    const counted = ready + pending;
    return {
      breakdown,
      usedBytes: ready,
      reservedBytes: pending,
      limitBytes: limit,
      remainingBytes: Math.max(0, limit - counted),
      percentage: Math.min(100, Math.floor((counted * 100) / limit)),
      level: storageLevel(counted, limit),
    };
  }

  /**
   * Call inside the transaction that inserts the new PENDING_UPLOAD row(s),
   * before the insert and before any upload is signed. Locking the Customer's
   * User row serializes every reservation for that Customer, so two uploads
   * can never both fit the same remaining space. 409 when over the limit.
   */
  async reserve(
    tx: Prisma.TransactionClient,
    ownerUserId: string,
    bytes: number,
  ): Promise<void> {
    await tx.$queryRaw`SELECT 1 FROM "User" WHERE id = ${ownerUserId}::uuid FOR UPDATE`;
    const limit = await this.allowance(tx, ownerUserId);
    const { ready, pending } = await this.totals(tx, ownerUserId);
    const counted = ready + pending;
    if (counted >= limit) throw new ConflictException(STORAGE_FULL);
    if (counted + bytes > limit) {
      throw new ConflictException(NOT_ENOUGH_STORAGE);
    }
  }
}
