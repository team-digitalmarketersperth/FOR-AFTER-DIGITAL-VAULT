import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../prisma/prisma.service.js';
import { MediaCleanup } from './media-cleanup.service.js';
import type { MediaStorage } from './storage/media-storage.service.js';

const NOW = new Date('2026-10-07T12:00:00Z');
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);
const row = (over: object = {}) => ({
  id: 'a1',
  storageKey: '/for-after/users/u/messages/m/photo/a1.jpg',
  storageProvider: 'IMAGEKIT' as const,
  providerFileId: 'file1',
  createdAt: minutesAgo(60),
  ...over,
});

const setup = (env: Record<string, string> = {}) => {
  const table = () => ({
    findMany: vi.fn().mockResolvedValue([]),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
  });
  const prisma = {
    mediaAsset: table(),
    memoryVaultMediaAsset: table(),
    recipientPhoto: table(),
    myStoryMediaAsset: table(),
    myWishMediaAsset: table(),
  };
  const storage = { deleteObject: vi.fn().mockResolvedValue(undefined) };
  const cleanup = new MediaCleanup(
    prisma as unknown as PrismaService,
    storage as unknown as MediaStorage,
    {
      get: (key: string) =>
        ({ MEDIA_UPLOAD_URL_TTL_SECONDS: '600', ...env })[key],
    } as unknown as ConfigService,
  );
  return { prisma, storage, cleanup };
};

describe('MediaCleanup', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('purge: deletes the file, then marks only a not-yet-marked row', async () => {
    const { prisma, storage, cleanup } = setup();
    expect(await cleanup.purge('mediaAsset', [row()], NOW)).toEqual({
      purged: 1,
      failed: 0,
    });
    expect(storage.deleteObject).toHaveBeenCalledWith(row());
    expect(prisma.mediaAsset.updateMany).toHaveBeenCalledWith({
      where: { id: 'a1', storageDeletedAt: null },
      data: { storageDeletedAt: NOW },
    });
    expect(storage.deleteObject.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.mediaAsset.updateMany.mock.invocationCallOrder[0],
    );
  });

  it('purge: a provider failure is logged by id only, left unmarked for retry, and never thrown', async () => {
    const { prisma, storage, cleanup } = setup();
    storage.deleteObject.mockRejectedValueOnce(
      new Error('ImageKit secret detail'),
    );
    const result = await cleanup.purge(
      'recipientPhoto',
      [row(), row({ id: 'a2' })],
      NOW,
    );
    expect(result).toEqual({ purged: 1, failed: 1 });
    expect(prisma.recipientPhoto.updateMany).toHaveBeenCalledTimes(1);
    const logged = warn.mock.calls.flat().join(' ');
    expect(logged).toContain('a1');
    expect(logged).not.toMatch(/secret|for-after/);
  });

  it('purge: an id-less upload whose token may still be in use is skipped (picked up later)', async () => {
    const { storage, cleanup } = setup();
    await cleanup.purge(
      'mediaAsset',
      [row({ providerFileId: null, createdAt: minutesAgo(5) })],
      NOW,
    );
    expect(storage.deleteObject).not.toHaveBeenCalled();
    await cleanup.purge(
      'mediaAsset',
      [row({ providerFileId: null, createdAt: minutesAgo(11) })],
      NOW,
    );
    expect(storage.deleteObject).toHaveBeenCalledTimes(1);
  });

  it('purge: a legacy B2 row is deleted when its owner asked (B2 keys are never reinterpreted)', async () => {
    const { storage, cleanup } = setup();
    const legacy = row({
      storageProvider: 'B2',
      providerFileId: null,
      storageKey: 'users/u/a.jpg',
    });
    await cleanup.purge('mediaAsset', [legacy], NOW);
    expect(storage.deleteObject).toHaveBeenCalledWith(legacy);
  });

  it('reconcile: retires day-old PENDING_UPLOAD rows, then retries ImageKit leftovers only, bounded', async () => {
    const { prisma, storage, cleanup } = setup();
    prisma.memoryVaultMediaAsset.findMany.mockResolvedValue([
      row({ id: 'm1' }),
    ]);
    expect(await cleanup.reconcile(NOW)).toEqual({ purged: 1, failed: 0 });
    for (const table of Object.values(prisma)) {
      expect(table.updateMany.mock.calls[0][0]).toEqual({
        where: {
          status: 'PENDING_UPLOAD',
          deletedAt: null,
          createdAt: { lt: minutesAgo(24 * 60) },
        },
        data: { deletedAt: NOW },
      });
      const query = table.findMany.mock.calls[0][0];
      expect(query.where).toEqual({
        storageProvider: 'IMAGEKIT',
        storageDeletedAt: null,
        createdAt: { lt: minutesAgo(10) },
        OR: [{ deletedAt: { not: null } }, { status: 'FAILED' }],
      });
      expect(query.take).toBe(100);
    }
    expect(storage.deleteObject).toHaveBeenCalledTimes(1);
  });

  it('reconcile: one table’s database error does not stop the others', async () => {
    const { prisma, cleanup } = setup();
    prisma.mediaAsset.updateMany.mockRejectedValueOnce(new Error('db down'));
    prisma.recipientPhoto.findMany.mockResolvedValue([row()]);
    expect(await cleanup.reconcile(NOW)).toEqual({ purged: 1, failed: 0 });
  });

  it('interval 0 turns the periodic run off; invalid values stop startup', () => {
    const { prisma, cleanup } = setup({ MEDIA_CLEANUP_INTERVAL_SECONDS: '0' });
    cleanup.onApplicationBootstrap();
    expect(prisma.mediaAsset.updateMany).not.toHaveBeenCalled();
    expect(() => setup({ MEDIA_CLEANUP_INTERVAL_SECONDS: '-1' })).toThrow(
      'MEDIA_CLEANUP_INTERVAL_SECONDS',
    );
  });
});
