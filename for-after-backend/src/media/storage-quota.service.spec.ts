import { ConflictException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../prisma/prisma.service.js';
import {
  NOT_ENOUGH_STORAGE,
  STORAGE_FULL,
  StorageQuota,
  storageLevel,
} from './storage-quota.service.js';

const GIB = 1024 ** 3;
const LIMIT = 1000;

// $queryRaw answers the lock (no rows) and the per-status SUM.
const setup = (ready: number, pending: number, limit?: number) => {
  const sums = [
    { status: 'READY', bytes: BigInt(ready) },
    { status: 'PENDING_UPLOAD', bytes: BigInt(pending) },
  ];
  const $queryRaw = vi.fn(async (sql: TemplateStringsArray) =>
    sql.join('').includes('FOR UPDATE') ? [] : sums,
  );
  const prisma = { $queryRaw };
  const quota = new StorageQuota(
    prisma as unknown as PrismaService,
    {
      get: (key: string) =>
        key === 'STORAGE_LIMIT_BYTES' && limit !== undefined
          ? String(limit)
          : undefined,
    } as unknown as ConfigService,
  );
  return { quota, prisma, $queryRaw };
};

describe('storageLevel (80 / 90 / 100 %)', () => {
  it.each([
    [0, 'NORMAL'],
    [799, 'NORMAL'],
    [800, 'WARNING'], // exactly 80 %
    [899, 'WARNING'],
    [900, 'HIGH'], // exactly 90 %
    [999, 'HIGH'],
    [1000, 'FULL'], // exactly 100 %
    [1500, 'FULL'],
  ])('%i of 1000 bytes → %s', (counted, level) => {
    expect(storageLevel(counted, LIMIT)).toBe(level);
  });

  it('integer math at a real limit: one byte under 80 % of 5 GiB is NORMAL', () => {
    const limit = 5 * GIB;
    expect(storageLevel(limit * 0.8 - 1, limit)).toBe('NORMAL');
    expect(storageLevel(limit * 0.8, limit)).toBe('WARNING');
    expect(storageLevel(limit - 1, limit)).toBe('HIGH');
    expect(storageLevel(limit, limit)).toBe('FULL');
  });
});

describe('StorageQuota', () => {
  it('defaults to 5 GiB and refuses an invalid limit at startup', () => {
    expect(setup(0, 0).quota.limitBytes).toBe(5 * GIB);
    expect(setup(0, 0, 2048).quota.limitBytes).toBe(2048);
    for (const bad of ['0', '-1', '1.5', 'abc'])
      expect(
        () =>
          new StorageQuota(
            {} as PrismaService,
            {
              get: () => bad,
            } as unknown as ConfigService,
          ),
      ).toThrow('STORAGE_LIMIT_BYTES');
  });

  it('usage: READY is used, PENDING_UPLOAD is reserved; both count toward the limit', async () => {
    const { quota } = setup(600, 150, LIMIT);
    expect(await quota.usage('owner-a')).toEqual({
      usedBytes: 600,
      reservedBytes: 150,
      limitBytes: LIMIT,
      remainingBytes: 250,
      percentage: 75,
      level: 'NORMAL',
    });
  });

  it('usage over the limit (e.g. after the limit was lowered) never goes negative', async () => {
    const { quota } = setup(1200, 0, LIMIT);
    expect(await quota.usage('owner-a')).toMatchObject({
      remainingBytes: 0,
      percentage: 100,
      level: 'FULL',
    });
  });

  it('the SUM is owner-scoped, live only, READY + PENDING_UPLOAD only, over all five media tables', async () => {
    const { quota, $queryRaw } = setup(0, 0, LIMIT);
    await quota.usage('owner-a');
    const [sql, ...params] = $queryRaw.mock.calls[0] as unknown as [
      TemplateStringsArray,
      ...unknown[],
    ];
    const text = sql.join('?');
    for (const table of [
      'MediaAsset',
      'MemoryVaultMediaAsset',
      'RecipientPhoto',
      'MyStoryMediaAsset',
      'MyWishMediaAsset',
    ])
      expect(text).toContain(`FROM "${table}" WHERE "ownerUserId" = ?::uuid`);
    expect(text).toContain(
      `"deletedAt" IS NULL AND status IN ('READY', 'PENDING_UPLOAD')`,
    );
    expect(params).toEqual(Array(5).fill('owner-a'));
  });

  describe('reserve', () => {
    const tx = (s: ReturnType<typeof setup>) =>
      s.prisma as unknown as Parameters<StorageQuota['reserve']>[0];

    it('locks the Customer row first, then sums inside the same transaction', async () => {
      const s = setup(100, 0, LIMIT);
      await s.quota.reserve(tx(s), 'owner-a', 10);
      const [lock, sum] = s.$queryRaw.mock.calls as unknown as [
        TemplateStringsArray,
        ...unknown[],
      ][];
      expect(lock[0].join('')).toContain('FROM "User" WHERE id = ');
      expect(lock[0].join('')).toContain('FOR UPDATE');
      expect(lock[1]).toBe('owner-a');
      expect(sum[0].join('')).toContain('SUM("sizeBytes")');
    });

    it.each([
      ['well under', 100, 0, 10],
      ['fills it exactly', 600, 300, 100],
    ])('%s → allowed', async (_, ready, pending, bytes) => {
      const s = setup(ready, pending, LIMIT);
      await expect(s.quota.reserve(tx(s), 'owner-a', bytes)).resolves.toBe(
        undefined,
      );
    });

    it('one byte over → this file is larger than what is left', async () => {
      const s = setup(600, 300, LIMIT);
      await expect(s.quota.reserve(tx(s), 'owner-a', 101)).rejects.toThrow(
        new ConflictException(NOT_ENOUGH_STORAGE),
      );
    });

    it('a big file is refused even below 80 %', async () => {
      const s = setup(100, 0, LIMIT);
      await expect(s.quota.reserve(tx(s), 'owner-a', 901)).rejects.toThrow(
        NOT_ENOUGH_STORAGE,
      );
    });

    it.each([
      ['READY at the limit', 1000, 0],
      ['in-progress uploads fill it', 400, 600],
      ['over the limit', 1100, 0],
    ])('%s → storage full, even for 1 byte', async (_, ready, pending) => {
      const s = setup(ready, pending, LIMIT);
      await expect(s.quota.reserve(tx(s), 'owner-a', 1)).rejects.toThrow(
        new ConflictException(STORAGE_FULL),
      );
    });
  });
});
