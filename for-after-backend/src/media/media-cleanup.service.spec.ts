import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../prisma/prisma.service.js';
import { GoneException } from '@nestjs/common';
import { MediaCleanup, UPLOAD_EXPIRED } from './media-cleanup.service.js';
import {
  MediaStorageThrottled,
  type MediaStorage,
} from './storage/media-storage.service.js';

const NOW = new Date('2026-10-07T12:00:00Z');
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);
const row = (over: object = {}) => ({
  id: 'a1',
  storageKey: '/for-after/users/u/messages/m/photo/a1.jpg',
  storageProvider: 'IMAGEKIT' as const,
  providerFileId: 'file1',
  createdAt: minutesAgo(120),
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
      deferred: 0,
    });
    // Settled: the known file, then whatever is at the path (a re-upload).
    expect(storage.deleteObject.mock.calls).toEqual([
      [row()],
      [row({ providerFileId: null })],
    ]);
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
    expect(result).toEqual({ purged: 1, failed: 1, deferred: 0 });
    expect(prisma.recipientPhoto.updateMany).toHaveBeenCalledTimes(1);
    const logged = warn.mock.calls.flat().join(' ');
    expect(logged).toContain('a1');
    expect(logged).not.toMatch(/secret|for-after/);
  });

  it('purge: an id-less upload is not looked up until its path has settled (token + upload in flight)', async () => {
    const { storage, cleanup } = setup();
    // Settles 10 min (token) + 60 min (upload in flight) after creation.
    const early = await cleanup.purge(
      'mediaAsset',
      [row({ providerFileId: null, createdAt: minutesAgo(69) })],
      NOW,
    );
    expect(early).toEqual({ purged: 0, failed: 0, deferred: 1 });
    expect(storage.deleteObject).not.toHaveBeenCalled();
    await cleanup.purge(
      'mediaAsset',
      [row({ providerFileId: null, createdAt: minutesAgo(70) })],
      NOW,
    );
    expect(storage.deleteObject).toHaveBeenCalledTimes(1);
  });

  it('token reuse: a file deleted early stays unmarked; after settling the path is checked again, then marked', async () => {
    const { prisma, storage, cleanup } = setup();
    // Deleted (or failed) 5 minutes after the upload URL was issued.
    const fresh = row({ createdAt: minutesAgo(5) });
    expect(await cleanup.purge('mediaAsset', [fresh], NOW)).toEqual({
      purged: 0,
      failed: 0,
      deferred: 1,
    });
    // The known file goes at once; no path lookup, no storageDeletedAt yet.
    expect(storage.deleteObject.mock.calls).toEqual([[fresh]]);
    expect(prisma.mediaAsset.updateMany).not.toHaveBeenCalled();

    // An hour later the old token re-uploaded a file at the same path: the
    // settled purge (reconcile) deletes by id (already gone) and by path.
    storage.deleteObject.mockClear();
    const later = new Date(NOW.getTime() + 70 * 60_000);
    expect(await cleanup.purge('mediaAsset', [fresh], later)).toEqual({
      purged: 1,
      failed: 0,
      deferred: 0,
    });
    expect(storage.deleteObject.mock.calls).toEqual([
      [fresh],
      [{ ...fresh, providerFileId: null }],
    ]);
    expect(prisma.mediaAsset.updateMany).toHaveBeenCalledWith({
      where: { id: 'a1', storageDeletedAt: null },
      data: { storageDeletedAt: later },
    });
  });

  it('cleanup retries: a failed path lookup leaves the row unmarked; the next run finishes it', async () => {
    const { prisma, storage, cleanup } = setup();
    storage.deleteObject
      .mockResolvedValueOnce(undefined) // by id
      .mockRejectedValueOnce(new Error('list API down')); // by path
    expect(await cleanup.purge('myStoryMediaAsset', [row()], NOW)).toEqual({
      purged: 0,
      failed: 1,
      deferred: 0,
    });
    expect(prisma.myStoryMediaAsset.updateMany).not.toHaveBeenCalled();
    expect(await cleanup.purge('myStoryMediaAsset', [row()], NOW)).toEqual({
      purged: 1,
      failed: 0,
      deferred: 0,
    });
    expect(prisma.myStoryMediaAsset.updateMany).toHaveBeenCalledTimes(1);
  });

  it('claimScan: holds only a live PENDING_UPLOAD row inside its completion window, by touching updatedAt', async () => {
    const { prisma, cleanup } = setup();
    // A tab backgrounded after the upload: confirmed 5 h later, still in the window.
    expect(
      await cleanup.claimScan('recipientPhoto', 'p1', minutesAgo(300), NOW),
    ).toBe(true);
    expect(prisma.recipientPhoto.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'p1',
        status: 'PENDING_UPLOAD',
        deletedAt: null,
        createdAt: { gt: minutesAgo(24 * 60) },
      },
      data: { updatedAt: NOW },
    });
    prisma.recipientPhoto.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(
      await cleanup.claimScan('recipientPhoto', 'p1', minutesAgo(300), NOW),
    ).toBe(false);
    // Past the window: an explicit 410, nothing claimed.
    prisma.recipientPhoto.updateMany.mockClear();
    await expect(
      cleanup.claimScan('recipientPhoto', 'p1', minutesAgo(24 * 60), NOW),
    ).rejects.toEqual(new GoneException(UPLOAD_EXPIRED));
    expect(prisma.recipientPhoto.updateMany).not.toHaveBeenCalled();
  });

  it('settled purge: no path lookup when the known file stayed at its path until settling', async () => {
    const { storage, cleanup } = setup();
    // READY, deleted 100 min after its upload URL (settles at 70 min).
    const late = row({ status: 'READY', deletedAt: minutesAgo(20) });
    expect(await cleanup.purge('mediaAsset', [late], NOW)).toEqual({
      purged: 1,
      failed: 0,
      deferred: 0,
    });
    expect(storage.deleteObject.mock.calls).toEqual([[late]]);
    // Deleted before settling, FAILED, or unknown: the path is checked too.
    for (const early of [
      row({ status: 'READY', deletedAt: minutesAgo(110) }),
      row({ status: 'FAILED', deletedAt: minutesAgo(20) }),
      row({ status: 'READY', deletedAt: null }),
      row(),
    ]) {
      storage.deleteObject.mockClear();
      await cleanup.purge('mediaAsset', [early], NOW);
      expect(storage.deleteObject.mock.calls).toEqual([
        [early],
        [{ ...early, providerFileId: null }],
      ]);
    }
  });

  it('purge: a throttled provider stops the batch; the rest wait unmarked for the next run', async () => {
    const { prisma, storage, cleanup } = setup();
    storage.deleteObject.mockRejectedValueOnce(
      new MediaStorageThrottled('Media storage is temporarily unavailable.'),
    );
    const rows = [row({ id: 'a1' }), row({ id: 'a2' }), row({ id: 'a3' })];
    expect(await cleanup.purge('mediaAsset', rows, NOW)).toEqual({
      purged: 0,
      failed: 1,
      deferred: 2,
    });
    expect(storage.deleteObject).toHaveBeenCalledTimes(1);
    expect(prisma.mediaAsset.updateMany).not.toHaveBeenCalled();
    // An ordinary failure does not stop the batch.
    storage.deleteObject.mockRejectedValueOnce(new Error('down'));
    expect(await cleanup.purge('mediaAsset', rows, NOW)).toEqual({
      purged: 2,
      failed: 1,
      deferred: 0,
    });
  });

  it('purge: a legacy B2 row is deleted when its owner asked (B2 keys are never reinterpreted)', async () => {
    const { storage, cleanup } = setup();
    const legacy = row({
      storageProvider: 'B2',
      providerFileId: null,
      storageKey: 'users/u/a.jpg',
    });
    await cleanup.purge('mediaAsset', [legacy], NOW);
    expect(storage.deleteObject.mock.calls).toEqual([[legacy]]);
  });

  it('reconcile: retires abandoned uploads no scan holds, then retries settled ImageKit leftovers only, bounded', async () => {
    const { prisma, storage, cleanup } = setup();
    prisma.memoryVaultMediaAsset.findMany.mockResolvedValue([
      row({ id: 'm1' }),
    ]);
    expect(await cleanup.reconcile(NOW)).toEqual({
      purged: 1,
      failed: 0,
      deferred: 0,
    });
    for (const table of Object.values(prisma)) {
      expect(table.updateMany.mock.calls[0][0]).toEqual({
        where: {
          status: 'PENDING_UPLOAD',
          deletedAt: null,
          // past the completion window (24 h) ...
          createdAt: { lte: minutesAgo(24 * 60) },
          // ... and no verification started in the last scan lease (2 + 10 min)
          updatedAt: { lt: minutesAgo(12) },
        },
        data: { deletedAt: NOW },
      });
      const query = table.findMany.mock.calls[0][0];
      expect(query.where).toEqual({
        storageProvider: 'IMAGEKIT',
        storageDeletedAt: null,
        createdAt: { lt: minutesAgo(70) },
        OR: [{ deletedAt: { not: null } }, { status: 'FAILED' }],
      });
      expect(query.take).toBe(100);
    }
    expect(storage.deleteObject).toHaveBeenCalledTimes(2);
  });

  it('reconcile: one table’s database error does not stop the others', async () => {
    const { prisma, cleanup } = setup();
    prisma.mediaAsset.updateMany.mockRejectedValueOnce(new Error('db down'));
    prisma.recipientPhoto.findMany.mockResolvedValue([row()]);
    expect(await cleanup.reconcile(NOW)).toEqual({
      purged: 1,
      failed: 0,
      deferred: 0,
    });
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
