import type { StorageQuota } from '../media/storage-quota.service.js';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { Prisma } from '../generated/prisma/client.js';
import {
  NOT_READY,
  NOT_UPLOADED,
  SCAN_UNAVAILABLE,
  UPLOAD_FAILED,
  UPLOAD_MISMATCH,
  UPLOAD_REJECTED,
} from '../media/media.service.js';
import {
  FAKE_MALWARE,
  FakeMalwareScanner,
} from '../../test/fake-malware-scanner.js';
import type { MalwareScanner } from '../media/scanner/malware-scanner.service.js';
import type { MediaStorage } from '../media/storage/media-storage.service.js';
import { fileStart } from '../../test/fake-media-storage.js';
import type { MediaCleanup } from '../media/media-cleanup.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { MemoryVaultMediaService } from './memory-vault-media.service.js';
import { MEMORY_NOT_FOUND } from './memory-vault.service.js';

// DTO validation (VIDEO, SVG, size 0, storageKey/ownerUserId injection) is
// shared with message media and covered in media.service.spec.ts; the e2e
// test sends those bodies to the Memory Vault routes.

const MB = 1024 * 1024;
const safe = {
  id: 'a1',
  kind: 'PHOTO',
  status: 'PENDING_UPLOAD',
  originalFileName: 'family.jpg',
  mimeType: 'image/jpeg',
  sizeBytes: 100_000,
  uploadedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};
const storageKey = '/for-after/users/owner-a/memory-vault/v1/photo/a1.jpg';
const ref = {
  id: 'a1',
  storageKey,
  storageProvider: 'IMAGEKIT',
  providerFileId: 'file1',
  createdAt: new Date(),
};
const pendingRow = { ...safe, storageKey };

const ownedItem = { id: 'v1', ownerUserId: 'owner-a', deletedAt: null };
const ownedAsset = {
  id: 'a1',
  ownerUserId: 'owner-a',
  memoryVaultItemId: 'v1',
  deletedAt: null,
  memoryVaultItem: ownedItem,
};

const noMatch = () =>
  new Prisma.PrismaClientKnownRequestError('No record found', {
    code: 'P2025',
    clientVersion: 'test',
  });

const env: Record<string, string> = {
  MEDIA_UPLOAD_URL_TTL_SECONDS: '600',
  MEDIA_ACCESS_URL_TTL_SECONDS: '300',
};

const setup = () => {
  const memoryVaultItem = { count: vi.fn().mockResolvedValue(1) };
  const memoryVaultMediaAsset = {
    create: vi.fn().mockResolvedValue({ id: 'a1' }),
    findFirst: vi.fn().mockResolvedValue(pendingRow),
    findMany: vi.fn().mockResolvedValue([safe]),
    update: vi.fn().mockResolvedValue({ ...safe, status: 'READY' }),
  };
  const upload = { url: 'https://upload.test/files', fields: { token: 't' } };
  const storage = {
    createUpload: vi.fn().mockResolvedValue(upload),
    verifyUpload: vi.fn().mockResolvedValue({
      sizeBytes: 100_000,
      contentType: 'image/jpeg',
      isPrivate: true,
      providerFileId: 'file1',
    }),
    readStart: vi.fn().mockResolvedValue(fileStart('image/jpeg')),
    // The whole file, streamed to the scanner.
    openRead: vi.fn(
      async (
        _ref: unknown,
        _signal: AbortSignal,
      ): Promise<AsyncIterable<Uint8Array>> =>
        (async function* () {
          yield fileStart('image/jpeg');
        })(),
    ),
    createAccessUrl: vi.fn().mockResolvedValue('https://media.test/signed'),
    deleteObject: vi.fn().mockResolvedValue(undefined),
  };
  // Phase 12C: within quota unless a test says otherwise.
  const quota = { reserve: vi.fn().mockResolvedValue(undefined) };
  const cleanup = {
    purge: vi.fn().mockResolvedValue({ purged: 1, failed: 0 }),
  };
  const scanner = new FakeMalwareScanner();
  const tx = { memoryVaultItem, memoryVaultMediaAsset };
  const $transaction = vi.fn((fn: (t: typeof tx) => unknown) => fn(tx));
  return {
    memoryVaultItem,
    asset: memoryVaultMediaAsset,
    storage,
    scanner,
    cleanup,
    quota,
    upload,
    service: new MemoryVaultMediaService(
      { ...tx, $transaction } as unknown as PrismaService,
      storage as unknown as MediaStorage,
      scanner as unknown as MalwareScanner,
      cleanup as unknown as MediaCleanup,
      quota as unknown as StorageQuota,
      { get: (key: string) => env[key] } as ConfigService,
    ),
  };
};

const photo = {
  kind: 'PHOTO' as const,
  originalFileName: 'family.jpg',
  mimeType: 'image/jpeg',
  sizeBytes: 100_000,
};
const audio = {
  kind: 'AUDIO' as const,
  originalFileName: 'voice.mp3',
  mimeType: 'audio/mpeg',
  sizeBytes: 5 * MB,
};

describe('MemoryVaultMediaService.createUploadUrl', () => {
  it.each([
    [photo, 'photo', 'jpg'],
    [audio, 'audio', 'mp3'],
  ])(
    '%o: server-generated ImageKit path, PENDING row, safe response',
    async (dto, folder, ext) => {
      const { memoryVaultItem, asset, storage, upload, service } = setup();
      const res = await service.createUploadUrl('owner-a', 'v1', {
        ...dto,
        originalFileName: '../../evil.exe',
        ...({ ownerUserId: 'owner-b', storageKey: 'evil' } as object),
      });
      expect(memoryVaultItem.count.mock.calls[0][0].where).toEqual(ownedItem);
      const { data } = asset.create.mock.calls[0][0];
      expect(data.ownerUserId).toBe('owner-a');
      expect(data.memoryVaultItemId).toBe('v1');
      expect(data.storageKey).toBe(
        `/for-after/users/owner-a/memory-vault/v1/${folder}/${data.id}.${ext}`,
      );
      expect(data).not.toHaveProperty('status');
      expect(storage.createUpload).toHaveBeenCalledWith(
        data.storageKey,
        dto.mimeType,
        dto.sizeBytes,
        600,
      );
      expect(res).toEqual({
        mediaAssetId: data.id,
        upload,
        expiresAt: expect.any(Date),
      });
    },
  );

  it.each([
    ['PHOTO + audio MIME', { ...photo, mimeType: 'audio/mpeg' }],
    ['AUDIO + image MIME', { ...audio, mimeType: 'image/jpeg' }],
    ['PHOTO over the limit', { ...photo, sizeBytes: 20 * MB + 1 }],
    ['AUDIO over the limit', { ...audio, sizeBytes: 25 * MB + 1 }],
    // Video is for messages only.
    [
      'VIDEO',
      {
        kind: 'VIDEO' as const,
        originalFileName: 'v.mp4',
        mimeType: 'video/mp4',
        sizeBytes: MB,
      },
    ],
  ])('%s → 400 before any database or storage call', async (_, dto) => {
    const { memoryVaultItem, storage, service } = setup();
    await expect(service.createUploadUrl('owner-a', 'v1', dto)).rejects.toThrow(
      BadRequestException,
    );
    expect(memoryVaultItem.count).not.toHaveBeenCalled();
    expect(storage.createUpload).not.toHaveBeenCalled();
  });

  it('cross-user or deleted memory → 404, nothing created or signed', async () => {
    const { memoryVaultItem, asset, storage, service } = setup();
    memoryVaultItem.count.mockResolvedValue(0);
    await expect(
      service.createUploadUrl('owner-b', 'v1', photo),
    ).rejects.toThrow(MEMORY_NOT_FOUND);
    expect(memoryVaultItem.count.mock.calls[0][0].where.ownerUserId).toBe(
      'owner-b',
    );
    expect(asset.create).not.toHaveBeenCalled();
    expect(storage.createUpload).not.toHaveBeenCalled();
  });
});

describe('MemoryVaultMediaService.complete', () => {
  it('verifies with the provider, then marks READY with uploadedAt (owner-scoped, live parent)', async () => {
    const { asset, storage, service } = setup();
    const res = await service.complete('owner-a', 'v1', 'a1', 'file1');
    expect(asset.findFirst.mock.calls[0][0].where).toEqual(ownedAsset);
    expect(storage.verifyUpload).toHaveBeenCalledWith(storageKey, 'file1');
    expect(storage.readStart).toHaveBeenCalledTimes(1);
    const { where, data } = asset.update.mock.calls[0][0];
    expect(where).toEqual({ ...ownedAsset, status: 'PENDING_UPLOAD' });
    expect(data).toEqual({
      status: 'READY',
      uploadedAt: expect.any(Date),
      providerFileId: 'file1',
    });
    expect(res.status).toBe('READY');
  });

  it('no file at this path → 409, stays PENDING_UPLOAD', async () => {
    const { asset, storage, service } = setup();
    storage.verifyUpload.mockResolvedValue(null);
    await expect(
      service.complete('owner-a', 'v1', 'a1', 'file1'),
    ).rejects.toThrow(NOT_UPLOADED);
    expect(asset.update).not.toHaveBeenCalled();
  });

  it.each([
    ['size', { sizeBytes: 99_999, contentType: 'image/jpeg' }],
    ['MIME', { sizeBytes: 100_000, contentType: 'image/png' }],
  ])(
    '%s mismatch → 400, FAILED (never READY), file purged',
    async (_, head) => {
      const { asset, storage, cleanup, service } = setup();
      storage.verifyUpload.mockResolvedValue({
        ...head,
        providerFileId: 'file1',
      });
      asset.update.mockResolvedValue(ref);
      await expect(
        service.complete('owner-a', 'v1', 'a1', 'file1'),
      ).rejects.toThrow(UPLOAD_MISMATCH);
      expect(asset.update).toHaveBeenCalledTimes(1);
      expect(asset.update.mock.calls[0][0].data).toEqual({
        status: 'FAILED',
        providerFileId: 'file1',
      });
      expect(cleanup.purge).toHaveBeenCalledWith('memoryVaultMediaAsset', [
        ref,
      ]);
    },
  );

  // Phase 12B: Memory Vault media is malware-scanned like message media.
  it.each([
    ['PHOTO', 'image/jpeg'],
    ['AUDIO', 'audio/mpeg'],
  ])('clean %s is scanned, then READY', async (kind, mimeType) => {
    const { asset, storage, scanner, service } = setup();
    asset.findFirst.mockResolvedValue({ ...pendingRow, kind, mimeType });
    storage.verifyUpload.mockResolvedValue({
      sizeBytes: 100_000,
      contentType: mimeType,
      isPrivate: true,
      providerFileId: 'file1',
    });
    storage.readStart.mockResolvedValue(fileStart(mimeType));
    await service.complete('owner-a', 'v1', 'a1', 'file1');
    expect(scanner.scan).toHaveBeenCalledTimes(1);
    expect(asset.update.mock.calls[0][0].data.status).toBe('READY');
  });

  it('infected → 400 generic, FAILED (never READY), file purged', async () => {
    const { asset, storage, cleanup, service } = setup();
    storage.openRead.mockImplementation(async () =>
      (async function* () {
        yield new Uint8Array([
          ...fileStart('image/jpeg'),
          ...Buffer.from(FAKE_MALWARE),
        ]);
      })(),
    );
    asset.update.mockResolvedValue(ref);
    await expect(
      service.complete('owner-a', 'v1', 'a1', 'file1'),
    ).rejects.toThrow(UPLOAD_REJECTED);
    expect(asset.update).toHaveBeenCalledTimes(1);
    expect(asset.update.mock.calls[0][0].data.status).toBe('FAILED');
    expect(cleanup.purge).toHaveBeenCalledWith('memoryVaultMediaAsset', [ref]);
  });

  it('scanner outage → 503, stays PENDING_UPLOAD (fail closed)', async () => {
    const { asset, scanner, service } = setup();
    scanner.scan.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(
      service.complete('owner-a', 'v1', 'a1', 'file1'),
    ).rejects.toThrow(SCAN_UNAVAILABLE);
    expect(asset.update).not.toHaveBeenCalled();
  });

  it('READY again is idempotent: no provider call, no write, no storageKey', async () => {
    const { asset, storage, service } = setup();
    asset.findFirst.mockResolvedValue({ ...pendingRow, status: 'READY' });
    const res = await service.complete('owner-a', 'v1', 'a1', 'file1');
    expect(res).not.toHaveProperty('storageKey');
    expect(res.status).toBe('READY');
    expect(storage.verifyUpload).not.toHaveBeenCalled();
    expect(asset.update).not.toHaveBeenCalled();
  });

  it('FAILED → 409 (request a new upload URL)', async () => {
    const { asset, service } = setup();
    asset.findFirst.mockResolvedValue({ ...pendingRow, status: 'FAILED' });
    await expect(
      service.complete('owner-a', 'v1', 'a1', 'file1'),
    ).rejects.toThrow(UPLOAD_FAILED);
  });

  it('cross-user, deleted media or deleted parent memory → 404', async () => {
    const { asset, storage, service } = setup();
    asset.findFirst.mockResolvedValue(null);
    await expect(
      service.complete('owner-b', 'v1', 'a1', 'file1'),
    ).rejects.toThrow(NotFoundException);
    expect(storage.verifyUpload).not.toHaveBeenCalled();
  });

  it('deleted or completed between verification and update → 409, database errors pass through', async () => {
    const { asset, service } = setup();
    asset.update.mockRejectedValueOnce(noMatch());
    await expect(
      service.complete('owner-a', 'v1', 'a1', 'file1'),
    ).rejects.toThrow(NOT_READY);
    const boom = new Error('connection lost');
    asset.update.mockRejectedValueOnce(boom);
    await expect(service.complete('owner-a', 'v1', 'a1', 'file1')).rejects.toBe(
      boom,
    );
  });
});

describe('MemoryVaultMediaService.findAllForItem', () => {
  it('owned live memory → live media only; otherwise 404', async () => {
    const { memoryVaultItem, asset, service } = setup();
    expect(await service.findAllForItem('owner-a', 'v1')).toEqual([safe]);
    expect(asset.findMany.mock.calls[0][0].where).toEqual({
      memoryVaultItemId: 'v1',
      ownerUserId: 'owner-a',
      deletedAt: null,
    });
    expect(asset.findMany.mock.calls[0][0].select).not.toHaveProperty(
      'storageKey',
    );
    memoryVaultItem.count.mockResolvedValue(0);
    await expect(service.findAllForItem('owner-a', 'v1')).rejects.toThrow(
      MEMORY_NOT_FOUND,
    );
  });
});

describe('MemoryVaultMediaService.createAccessUrl', () => {
  it('READY → short-lived signed GET', async () => {
    const { asset, storage, service } = setup();
    asset.findFirst.mockResolvedValue({ status: 'READY', ...ref });
    const res = await service.createAccessUrl('owner-a', 'v1', 'a1');
    expect(asset.findFirst.mock.calls[0][0].where).toEqual(ownedAsset);
    expect(storage.createAccessUrl).toHaveBeenCalledWith(
      { status: 'READY', ...ref },
      300,
    );
    expect(res).toEqual({
      url: 'https://media.test/signed',
      expiresAt: expect.any(Date),
    });
  });

  it.each(['PENDING_UPLOAD', 'FAILED'])(
    '%s → 409, nothing signed',
    async (status) => {
      const { asset, storage, service } = setup();
      asset.findFirst.mockResolvedValue({ status, ...ref });
      await expect(
        service.createAccessUrl('owner-a', 'v1', 'a1'),
      ).rejects.toThrow(ConflictException);
      expect(storage.createAccessUrl).not.toHaveBeenCalled();
    },
  );

  it('cross-user or deleted parent memory → 404', async () => {
    const { asset, storage, service } = setup();
    asset.findFirst.mockResolvedValue(null);
    await expect(
      service.createAccessUrl('owner-b', 'v1', 'a1'),
    ).rejects.toThrow(NotFoundException);
    expect(storage.createAccessUrl).not.toHaveBeenCalled();
  });
});

describe('MemoryVaultMediaService.remove', () => {
  it('soft-deletes (owner-scoped), then purges the file', async () => {
    const { asset, cleanup, service } = setup();
    asset.update.mockResolvedValue(ref);
    await service.remove('owner-a', 'v1', 'a1');
    const { where, data } = asset.update.mock.calls[0][0];
    expect(where).toEqual(ownedAsset);
    expect(data).toEqual({ deletedAt: expect.any(Date) });
    expect(cleanup.purge).toHaveBeenCalledWith('memoryVaultMediaAsset', [ref]);
  });

  it('cross-user → 404, nothing purged', async () => {
    const { asset, cleanup, service } = setup();
    asset.update.mockRejectedValue(noMatch());
    await expect(service.remove('owner-b', 'v1', 'a1')).rejects.toThrow(
      NotFoundException,
    );
    expect(cleanup.purge).not.toHaveBeenCalled();
  });
});
