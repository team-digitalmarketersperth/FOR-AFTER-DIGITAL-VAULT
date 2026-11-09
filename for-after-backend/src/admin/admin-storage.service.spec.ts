import { BadRequestException, NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants.js';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AdminGuard } from '../auth/guards/admin.guard.js';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard.js';
import { Prisma } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { AdminStorageController } from './admin.controller.js';
import { AdminStorageService, toStorageAsset } from './admin-storage.service.js';
import { StorageAssetQueryDto } from './dto/admin.dto.js';

const NOW = new Date('2026-10-31T12:00:00.000Z');
const ID = '7d6f1d8e-3c55-4a3a-9f1e-2b9a8f0e4c11';
const OWNER = '11111111-1111-4111-8111-111111111111';
const row = (over: object = {}) => ({
  id: ID,
  source: 'MEMORY_VAULT',
  kind: 'PHOTO',
  ownerUserId: OWNER,
  status: 'READY',
  sizeBytes: 2048,
  provider: 'IMAGEKIT',
  createdAt: NOW,
  updatedAt: NOW,
  uploadedAt: NOW,
  deletedAt: null,
  storageDeletedAt: null,
  deletion: 'active',
  ...over,
});
const q = (body: object) => plainToInstance(StorageAssetQueryDto, { page: 1, limit: 25, ...body });
// The tagged-template call as PostgreSQL gets it: text with $n and the bound values.
const sqlOf = (call: unknown[]) => {
  const [strings, ...values] = call as [TemplateStringsArray, ...unknown[]];
  const sql = Prisma.sql(strings, ...values);
  return { text: sql.text, values: sql.values };
};

const setup = (groups: object[] = [], rows: object[] = [row()]) => {
  const $queryRaw = vi.fn(async (strings: TemplateStringsArray, ..._v: unknown[]) => {
    const text = strings.join('?');
    if (text.includes('GROUP BY')) return groups;
    if (text.includes('count(*)')) return [{ total: rows.length }];
    return rows;
  });
  // Reads only: the service gets no model delegates, so any write would throw.
  return { service: new AdminStorageService({ $queryRaw } as unknown as PrismaService), $queryRaw };
};

describe('AdminStorageService', () => {
  it('admin role + MFA guards on the controller', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, AdminStorageController)).toEqual([SessionAuthGuard, AdminGuard]);
  });

  it('DTO: metadata only; verified vs declared size; no file names, keys, provider ids or links', () => {
    const ready = toStorageAsset(row({ storageKey: 'users/x/a.png', providerFileId: 'f1', originalFileName: 'grandma.png' }) as never);
    expect(ready).toEqual({
      reference: ID,
      source: 'MEMORY_VAULT',
      kind: 'PHOTO',
      accountId: OWNER,
      sizeBytes: 2048,
      sizeVerified: true,
      uploadState: 'ready',
      deletion: 'active',
      legacyStorage: false,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      verifiedAt: NOW.toISOString(),
      deletedAt: null,
      storageDeletedAt: null,
    });
    expect(JSON.stringify(ready)).not.toMatch(/users\/x|grandma|"f1"|storageKey|providerFileId|mime|url/i);
    // An upload in progress has a client-declared size, not a verified one; no scan result is implied.
    const pending = toStorageAsset(row({ status: 'PENDING_UPLOAD', uploadedAt: null }) as never);
    expect(pending).toMatchObject({ uploadState: 'pending', sizeVerified: false, verifiedAt: null });
    expect(pending).not.toHaveProperty('scan');
    // FAILED (type mismatch or threat; the reason is not stored) is not labelled malware.
    expect(toStorageAsset(row({ status: 'FAILED', deletion: 'pending' }) as never)).toMatchObject({
      uploadState: 'failed',
      sizeVerified: false,
      deletion: 'pending',
    });
    // Evidence: no account reference.
    expect(toStorageAsset(row({ source: 'DEATH_EVIDENCE', kind: null, ownerUserId: null }) as never).accountId).toBeNull();
    expect(toStorageAsset(row({ provider: 'B2' }) as never).legacyStorage).toBe(true);
  });

  it('summary: quota definitions per source; reservations apart from verified bytes; deletions by state', async () => {
    const { service } = setup([
      { source: 'MESSAGE', status: 'READY', deletion: 'active', live: true, n: 2, bytes: 3000n },
      { source: 'MESSAGE', status: 'PENDING_UPLOAD', deletion: 'active', live: true, n: 1, bytes: 500n },
      // Soft-deleted READY: not storage, removal pending.
      { source: 'MESSAGE', status: 'READY', deletion: 'pending', live: false, n: 1, bytes: 9999n },
      { source: 'MESSAGE', status: 'FAILED', deletion: 'pending', live: true, n: 1, bytes: 40n },
      { source: 'MESSAGE', status: 'READY', deletion: 'confirmed', live: false, n: 3, bytes: 70n },
      { source: 'DEATH_EVIDENCE', status: 'READY', deletion: 'active', live: true, n: 1, bytes: 100n },
    ]);
    const s = await service.summary();
    expect(s.MESSAGE).toEqual({
      pending: 1,
      ready: 2,
      failed: 1,
      verifiedBytes: 3000,
      reservedBytes: 500,
      deletionPending: 2,
      deletionConfirmed: 3,
      total: 8,
    });
    expect(s.DEATH_EVIDENCE.verifiedBytes).toBe(100);
    expect(s.MY_WISHES.total).toBe(0);
  });

  it('list: filters as parameters, allowlisted sort with an id tie-breaker, bounded page', async () => {
    const { service, $queryRaw } = setup();
    const res = await service.list(
      q({ source: 'MY_STORY', uploadState: 'pending', deletion: 'active', kind: 'AUDIO', accountId: OWNER, page: 3, limit: 10, sort: 'updatedAt', dir: 'asc' }),
      NOW,
    );
    expect(res.items).toHaveLength(1);
    const list = sqlOf($queryRaw.mock.calls.find((c) => (c[0] as TemplateStringsArray).join('').includes('ORDER BY'))!);
    expect(list.text).toMatch(/"updatedAt" ASC, id ASC/);
    expect(list.values).toEqual(expect.arrayContaining(['MY_STORY', 'PENDING_UPLOAD', 'active', 'AUDIO', OWNER, 10, 20]));
    // Defaults: newest first.
    await service.list(q({}), NOW);
    expect(sqlOf($queryRaw.mock.calls.at(-3)!).text).toMatch(/"createdAt" DESC, id DESC/);
  });

  it('date range: from before to, at most 366 days', async () => {
    const { service } = setup();
    await expect(service.list(q({ from: '2026-10-02T00:00:00Z', to: '2026-10-01T00:00:00Z' }), NOW)).rejects.toThrow(BadRequestException);
    await expect(service.list(q({ from: '2025-01-01T00:00:00Z', to: '2026-10-01T00:00:00Z' }), NOW)).rejects.toThrow(/366 days/);
    await expect(service.list(q({ from: '2026-10-01T00:00:00Z' }), NOW)).resolves.toBeDefined();
  });

  it('a failed summary is null (Unavailable), never zeros; the list still answers', async () => {
    const { service, $queryRaw } = setup();
    $queryRaw.mockImplementationOnce(async () => [row()]).mockImplementationOnce(async () => [{ total: 1 }]).mockRejectedValueOnce(new Error('db'));
    const res = await service.list(q({}), NOW);
    expect(res.summary).toBeNull();
    expect(res.items).toHaveLength(1);
  });

  it('detail: one record by reference; 404 otherwise', async () => {
    await expect(setup([], [row()]).service.get(ID)).resolves.toMatchObject({ reference: ID });
    await expect(setup([], []).service.get(ID)).rejects.toThrow(NotFoundException);
  });

  it('query validation: enums and UUIDs only', async () => {
    const bad = [{ source: 'S3' }, { uploadState: 'infected' }, { deletion: 'orphan' }, { kind: 'PDF' }, { reference: 'x' }, { accountId: 'a@b.c' }, { sort: 'sizeBytes' }, { limit: 101 }];
    for (const body of bad) expect(await validate(q(body))).not.toHaveLength(0);
    expect(await validate(q({ source: 'DEATH_EVIDENCE', uploadState: 'failed', deletion: 'confirmed' }))).toHaveLength(0);
  });
});
