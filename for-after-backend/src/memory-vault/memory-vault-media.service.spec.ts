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
  UPLOAD_FAILED,
  UPLOAD_MISMATCH,
} from '../media/media.service.js';
import type { MediaStorage } from '../media/storage/media-storage.service.js';
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
const storageKey = 'users/owner-a/memory-vault/v1/a1.jpg';
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
  MEDIA_PHOTO_MAX_BYTES: String(20 * MB),
  MEDIA_AUDIO_MAX_BYTES: String(100 * MB),
};

const setup = () => {
  const memoryVaultItem = { count: vi.fn().mockResolvedValue(1) };
  const memoryVaultMediaAsset = {
    create: vi.fn().mockResolvedValue({ id: 'a1' }),
    findFirst: vi.fn().mockResolvedValue(pendingRow),
    findMany: vi.fn().mockResolvedValue([safe]),
    update: vi.fn().mockResolvedValue({ ...safe, status: 'READY' }),
  };
  const storage = {
    createUploadUrl: vi.fn().mockResolvedValue('https://signed.example/put'),
    createAccessUrl: vi.fn().mockResolvedValue('https://signed.example/get'),
    headObject: vi
      .fn()
      .mockResolvedValue({ sizeBytes: 100_000, contentType: 'image/jpeg' }),
    deleteObject: vi.fn().mockResolvedValue(undefined),
  };
  const tx = { memoryVaultItem, memoryVaultMediaAsset };
  const $transaction = vi.fn((fn: (t: typeof tx) => unknown) => fn(tx));
  return {
    memoryVaultItem,
    asset: memoryVaultMediaAsset,
    storage,
    service: new MemoryVaultMediaService(
      { ...tx, $transaction } as unknown as PrismaService,
      storage as unknown as MediaStorage,
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
    [photo, 'jpg'],
    [audio, 'mp3'],
  ])(
    '%o: server-generated key, PENDING row, safe response',
    async (dto, ext) => {
      const { memoryVaultItem, asset, storage, service } = setup();
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
        `users/owner-a/memory-vault/v1/${data.id}.${ext}`,
      );
      expect(data).not.toHaveProperty('status');
      expect(storage.createUploadUrl).toHaveBeenCalledWith(
        data.storageKey,
        dto.mimeType,
        600,
      );
      expect(res).toEqual({
        mediaAssetId: data.id,
        uploadUrl: 'https://signed.example/put',
        expiresAt: expect.any(Date),
        requiredHeaders: { 'Content-Type': dto.mimeType },
      });
      expect(JSON.stringify(res)).not.toMatch(/storageKey|owner|users\//);
    },
  );

  it.each([
    ['PHOTO + audio MIME', { ...photo, mimeType: 'audio/mpeg' }],
    ['AUDIO + image MIME', { ...audio, mimeType: 'image/jpeg' }],
    ['PHOTO over the limit', { ...photo, sizeBytes: 20 * MB + 1 }],
    ['AUDIO over the limit', { ...audio, sizeBytes: 100 * MB + 1 }],
  ])('%s → 400 before any database or storage call', async (_, dto) => {
    const { memoryVaultItem, storage, service } = setup();
    await expect(service.createUploadUrl('owner-a', 'v1', dto)).rejects.toThrow(
      BadRequestException,
    );
    expect(memoryVaultItem.count).not.toHaveBeenCalled();
    expect(storage.createUploadUrl).not.toHaveBeenCalled();
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
    expect(storage.createUploadUrl).not.toHaveBeenCalled();
  });
});

describe('MemoryVaultMediaService.complete', () => {
  it('HEADs storage, then marks READY with uploadedAt (owner-scoped, live parent)', async () => {
    const { asset, storage, service } = setup();
    const res = await service.complete('owner-a', 'v1', 'a1');
    expect(asset.findFirst.mock.calls[0][0].where).toEqual(ownedAsset);
    expect(storage.headObject).toHaveBeenCalledWith(storageKey);
    const { where, data } = asset.update.mock.calls[0][0];
    expect(where).toEqual({ ...ownedAsset, status: 'PENDING_UPLOAD' });
    expect(data).toEqual({ status: 'READY', uploadedAt: expect.any(Date) });
    expect(res.status).toBe('READY');
  });

  it('missing object → 409, stays PENDING_UPLOAD', async () => {
    const { asset, storage, service } = setup();
    storage.headObject.mockResolvedValue(null);
    await expect(service.complete('owner-a', 'v1', 'a1')).rejects.toThrow(
      NOT_UPLOADED,
    );
    expect(asset.update).not.toHaveBeenCalled();
  });

  it.each([
    ['size', { sizeBytes: 99_999, contentType: 'image/jpeg' }],
    ['MIME', { sizeBytes: 100_000, contentType: 'image/png' }],
  ])(
    '%s mismatch → 400, FAILED (never READY), object removed',
    async (_, head) => {
      const { asset, storage, service } = setup();
      storage.headObject.mockResolvedValue(head);
      await expect(service.complete('owner-a', 'v1', 'a1')).rejects.toThrow(
        UPLOAD_MISMATCH,
      );
      expect(asset.update).toHaveBeenCalledTimes(1);
      expect(asset.update.mock.calls[0][0].data).toEqual({ status: 'FAILED' });
      expect(storage.deleteObject).toHaveBeenCalledWith(storageKey);
    },
  );

  it('READY again is idempotent: no HEAD, no write, no storageKey', async () => {
    const { asset, storage, service } = setup();
    asset.findFirst.mockResolvedValue({ ...pendingRow, status: 'READY' });
    const res = await service.complete('owner-a', 'v1', 'a1');
    expect(res).not.toHaveProperty('storageKey');
    expect(res.status).toBe('READY');
    expect(storage.headObject).not.toHaveBeenCalled();
    expect(asset.update).not.toHaveBeenCalled();
  });

  it('FAILED → 409 (request a new upload URL)', async () => {
    const { asset, service } = setup();
    asset.findFirst.mockResolvedValue({ ...pendingRow, status: 'FAILED' });
    await expect(service.complete('owner-a', 'v1', 'a1')).rejects.toThrow(
      UPLOAD_FAILED,
    );
  });

  it('cross-user, deleted media or deleted parent memory → 404', async () => {
    const { asset, storage, service } = setup();
    asset.findFirst.mockResolvedValue(null);
    await expect(service.complete('owner-b', 'v1', 'a1')).rejects.toThrow(
      NotFoundException,
    );
    expect(storage.headObject).not.toHaveBeenCalled();
  });

  it('deleted or completed between HEAD and update → 409, database errors pass through', async () => {
    const { asset, service } = setup();
    asset.update.mockRejectedValueOnce(noMatch());
    await expect(service.complete('owner-a', 'v1', 'a1')).rejects.toThrow(
      NOT_READY,
    );
    const boom = new Error('connection lost');
    asset.update.mockRejectedValueOnce(boom);
    await expect(service.complete('owner-a', 'v1', 'a1')).rejects.toBe(boom);
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
    asset.findFirst.mockResolvedValue({ status: 'READY', storageKey });
    const res = await service.createAccessUrl('owner-a', 'v1', 'a1');
    expect(asset.findFirst.mock.calls[0][0].where).toEqual(ownedAsset);
    expect(storage.createAccessUrl).toHaveBeenCalledWith(storageKey, 300);
    expect(res).toEqual({
      url: 'https://signed.example/get',
      expiresAt: expect.any(Date),
    });
  });

  it.each(['PENDING_UPLOAD', 'FAILED'])(
    '%s → 409, nothing signed',
    async (status) => {
      const { asset, storage, service } = setup();
      asset.findFirst.mockResolvedValue({ status, storageKey });
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
  it('soft-deletes (owner-scoped), then deletes the object', async () => {
    const { asset, storage, service } = setup();
    asset.update.mockResolvedValue({ storageKey });
    await service.remove('owner-a', 'v1', 'a1');
    const { where, data } = asset.update.mock.calls[0][0];
    expect(where).toEqual(ownedAsset);
    expect(data).toEqual({ deletedAt: expect.any(Date) });
    expect(storage.deleteObject).toHaveBeenCalledWith(storageKey);
  });

  it('storage failure still succeeds and never restores access', async () => {
    const { asset, storage, service } = setup();
    asset.update.mockResolvedValue({ storageKey });
    storage.deleteObject.mockRejectedValue(new Error('storage down'));
    await expect(
      service.remove('owner-a', 'v1', 'a1'),
    ).resolves.toBeUndefined();
    expect(asset.update).toHaveBeenCalledTimes(1);
  });

  it('cross-user → 404, nothing deleted from storage', async () => {
    const { asset, storage, service } = setup();
    asset.update.mockRejectedValue(noMatch());
    await expect(service.remove('owner-b', 'v1', 'a1')).rejects.toThrow(
      NotFoundException,
    );
    expect(storage.deleteObject).not.toHaveBeenCalled();
  });
});
