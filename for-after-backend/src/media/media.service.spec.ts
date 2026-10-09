import type { StorageQuota } from './storage-quota.service.js';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  FAKE_MALWARE,
  FakeMalwareScanner,
} from '../../test/fake-malware-scanner.js';
import { fileStart } from '../../test/fake-media-storage.js';
import { Prisma } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import {
  CompleteMediaUploadDto,
  CreateMediaUploadDto,
} from './dto/create-media-upload.dto.js';
import type { MediaCleanup } from './media-cleanup.service.js';
import {
  hasFileSignature,
  matchesUpload,
  MediaService,
  NOT_DRAFT,
  NOT_READY,
  NOT_UPLOADED,
  SCAN_UNAVAILABLE,
  UPLOAD_MISMATCH,
  UPLOAD_REJECTED,
} from './media.service.js';
import type { MalwareScanner } from './scanner/malware-scanner.service.js';
import type { MediaStorage } from './storage/media-storage.service.js';

const MB = 1024 * 1024;
const KEY = '/for-after/users/owner-a/messages/m1/photo/a1.jpg';
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
const pendingRow = { ...safe, storageKey: KEY, message: { status: 'DRAFT' } };
const ref = {
  id: 'a1',
  storageKey: KEY,
  storageProvider: 'IMAGEKIT',
  providerFileId: 'file1',
  createdAt: new Date(),
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
  // updateMany = the draft lock: count 1 = owned, live DRAFT message.
  const message = {
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    count: vi.fn().mockResolvedValue(1),
  };
  const mediaAsset = {
    create: vi.fn().mockResolvedValue({ id: 'a1' }),
    findFirst: vi.fn().mockResolvedValue(pendingRow),
    findMany: vi.fn().mockResolvedValue([safe]),
    update: vi.fn().mockResolvedValue({ ...safe, status: 'READY' }),
    count: vi.fn().mockResolvedValue(0),
  };
  const upload = { url: 'https://upload.test/files', fields: { token: 't' } };
  const storage = {
    createUpload: vi.fn().mockResolvedValue(upload),
    // The provider holds a private 100 kB JPEG at KEY.
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
  const config = { get: (key: string) => env[key] } as ConfigService;
  const tx = { message, mediaAsset };
  const $transaction = vi.fn((fn: (t: typeof tx) => unknown) => fn(tx));
  return {
    message,
    mediaAsset,
    storage,
    scanner,
    cleanup,
    quota,
    upload,
    $transaction,
    service: new MediaService(
      { ...tx, $transaction } as unknown as PrismaService,
      storage as unknown as MediaStorage,
      scanner as unknown as MalwareScanner,
      cleanup as unknown as MediaCleanup,
      quota as unknown as StorageQuota,
      config,
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
  originalFileName: 'voice.m4a',
  mimeType: 'audio/mp4',
  sizeBytes: 5 * MB,
};
const video = {
  kind: 'VIDEO' as const,
  originalFileName: 'hello.webm',
  mimeType: 'video/webm',
  sizeBytes: 30 * MB,
};
const ownedMessage = { id: 'm1', ownerUserId: 'owner-a', deletedAt: null };
const ownedAsset = {
  id: 'a1',
  ownerUserId: 'owner-a',
  messageId: 'm1',
  deletedAt: null,
  message: ownedMessage,
};

const errorsFor = async (dto: object, body: object) =>
  (
    await validate(plainToInstance(dto as never, body), {
      whitelist: true,
      forbidNonWhitelisted: true,
    })
  ).map((e) => e.property);

describe('CreateMediaUploadDto', () => {
  it.each([photo, audio, video])('accepts %o', async (body) => {
    expect(await errorsFor(CreateMediaUploadDto, body)).toEqual([]);
  });

  it.each([
    ['kind', { kind: 'DOCUMENT' }],
    ['kind', { kind: null }],
    ['mimeType', { mimeType: 'image/svg+xml' }],
    ['mimeType', { mimeType: 'image/*' }],
    ['mimeType', { mimeType: 'audio/ogg' }],
    ['mimeType', { mimeType: 'video/quicktime' }],
    ['sizeBytes', { sizeBytes: 0 }],
    ['sizeBytes', { sizeBytes: -1 }],
    ['sizeBytes', { sizeBytes: 1.5 }],
    ['sizeBytes', { sizeBytes: '100' }],
    ['originalFileName', { originalFileName: '   ' }],
    ['originalFileName', { originalFileName: 'x'.repeat(256) }],
    ['ownerUserId', { ownerUserId: 'owner-b' }],
    ['storageKey', { storageKey: 'users/owner-b/evil.jpg' }],
    ['status', { status: 'READY' }],
  ])('rejects %s in %o', async (field, patch) => {
    expect(
      await errorsFor(CreateMediaUploadDto, { ...photo, ...patch }),
    ).toContain(field);
  });
});

describe('CompleteMediaUploadDto', () => {
  it('accepts a provider file id', async () => {
    expect(
      await errorsFor(CompleteMediaUploadDto, {
        providerFileId: '598821f949c0a938d57563bd',
      }),
    ).toEqual([]);
  });

  it.each([
    [{}],
    [{ providerFileId: '' }],
    [{ providerFileId: '../other' }],
    [{ providerFileId: 'a'.repeat(101) }],
    [{ providerFileId: 'f1', storageKey: 'x' }],
  ])('rejects %o', async (body) => {
    expect(
      (await errorsFor(CompleteMediaUploadDto, body)).length,
    ).toBeGreaterThan(0);
  });
});

describe('MediaService.createUploadUrl', () => {
  it('PHOTO: server-generated ImageKit path, TTL from config, PENDING row, safe response', async () => {
    const { mediaAsset, storage, upload, service } = setup();
    const res = await service.createUploadUrl('owner-a', 'm1', {
      ...photo,
      originalFileName: '../../etc/passwd.exe',
      // Smuggled fields (the ValidationPipe rejects these first in HTTP).
      ...({ ownerUserId: 'owner-b', storageKey: 'evil' } as object),
    });
    const { data } = mediaAsset.create.mock.calls[0][0];
    expect(data.ownerUserId).toBe('owner-a');
    expect(data.messageId).toBe('m1');
    expect(data.storageKey).toBe(
      `/for-after/users/owner-a/messages/m1/photo/${data.id}.jpg`,
    );
    expect(data.storageKey).not.toContain('passwd');
    expect(data).not.toHaveProperty('status');
    expect(data).not.toHaveProperty('storageProvider'); // DB default IMAGEKIT
    expect(storage.createUpload).toHaveBeenCalledWith(
      data.storageKey,
      'image/jpeg',
      100_000,
      600,
    );
    expect(res).toEqual({
      mediaAssetId: data.id,
      upload,
      expiresAt: expect.any(Date),
    });
  });

  it.each([
    [audio, /\/audio\/[0-9a-f-]+\.m4a$/],
    [video, /\/video\/[0-9a-f-]+\.webm$/],
  ])('%o: kind folder, extension from the MIME type', async (dto, path) => {
    const { mediaAsset, service } = setup();
    await service.createUploadUrl('owner-a', 'm1', {
      ...dto,
      originalFileName: 'voice.jpg',
    });
    expect(mediaAsset.create.mock.calls[0][0].data.storageKey).toMatch(path);
  });

  it.each([
    ['PHOTO + audio MIME', { ...photo, mimeType: 'audio/mpeg' }],
    ['AUDIO + image MIME', { ...audio, mimeType: 'image/jpeg' }],
    ['VIDEO + audio MIME', { ...video, mimeType: 'audio/webm' }],
    ['PHOTO over 20 MB', { ...photo, sizeBytes: 20 * MB + 1 }],
    // ImageKit Free plan limits (provider limits).
    ['AUDIO over 25 MB', { ...audio, sizeBytes: 25 * MB + 1 }],
    ['VIDEO over 100 MB', { ...video, sizeBytes: 100 * MB + 1 }],
  ])('%s → 400 before any database or storage call', async (_, dto) => {
    const { message, storage, service } = setup();
    await expect(service.createUploadUrl('owner-a', 'm1', dto)).rejects.toThrow(
      BadRequestException,
    );
    expect(message.updateMany).not.toHaveBeenCalled();
    expect(storage.createUpload).not.toHaveBeenCalled();
  });

  it('exact limits are allowed', async () => {
    const { service } = setup();
    await service.createUploadUrl('owner-a', 'm1', {
      ...photo,
      sizeBytes: 20 * MB,
    });
    await service.createUploadUrl('owner-a', 'm1', {
      ...audio,
      sizeBytes: 25 * MB,
    });
    await service.createUploadUrl('owner-a', 'm1', {
      ...video,
      sizeBytes: 100 * MB,
    });
  });

  it('cross-user or deleted message → 404, owner-scoped, nothing signed', async () => {
    const { message, storage, mediaAsset, service } = setup();
    message.updateMany.mockResolvedValue({ count: 0 });
    message.count.mockResolvedValue(0);
    await expect(
      service.createUploadUrl('owner-b', 'm1', photo),
    ).rejects.toThrow(NotFoundException);
    expect(message.updateMany.mock.calls[0][0].where).toEqual({
      ...ownedMessage,
      ownerUserId: 'owner-b',
      status: 'DRAFT',
    });
    expect(storage.createUpload).not.toHaveBeenCalled();
    expect(mediaAsset.create).not.toHaveBeenCalled();
  });

  it('a non-DRAFT (SCHEDULED/RELEASED/CANCELLED) owned message → 409', async () => {
    const { message, mediaAsset, storage, service } = setup();
    message.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      service.createUploadUrl('owner-a', 'm1', photo),
    ).rejects.toThrow(NOT_DRAFT);
    expect(mediaAsset.create).not.toHaveBeenCalled();
    expect(storage.createUpload).not.toHaveBeenCalled();
  });

  it('insert and signing run under the draft lock in one transaction', async () => {
    const { message, mediaAsset, storage, $transaction, service } = setup();
    await service.createUploadUrl('owner-a', 'm1', photo);
    expect($transaction).toHaveBeenCalledTimes(1);
    expect(message.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      mediaAsset.create.mock.invocationCallOrder[0],
    );
    expect(storage.createUpload).toHaveBeenCalledTimes(1);
  });
});

describe('MediaService.createUploadUrl quota (Phase 12C)', () => {
  it('reserves the declared size inside the draft-lock transaction, before the row and the signature', async () => {
    const t = setup();
    await t.service.createUploadUrl('owner-a', 'm1', {
      kind: 'VIDEO',
      originalFileName: 'v.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 30 * MB,
    });
    expect(t.quota.reserve).toHaveBeenCalledWith(
      expect.objectContaining({ mediaAsset: t.mediaAsset }),
      'owner-a',
      30 * MB,
    );
    expect(t.quota.reserve.mock.invocationCallOrder[0]).toBeLessThan(
      t.mediaAsset.create.mock.invocationCallOrder[0],
    );
    expect(t.message.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      t.quota.reserve.mock.invocationCallOrder[0],
    );
  });

  it('over quota → the 409 from the quota, no row and nothing signed', async () => {
    const t = setup();
    t.quota.reserve.mockRejectedValue(new ConflictException('full'));
    await expect(
      t.service.createUploadUrl('owner-a', 'm1', {
        kind: 'PHOTO',
        originalFileName: 'a.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 1,
      }),
    ).rejects.toThrow(ConflictException);
    expect(t.mediaAsset.create).not.toHaveBeenCalled();
    expect(t.storage.createUpload).not.toHaveBeenCalled();
  });

  it('existing media stays viewable at quota: access URLs never check it', async () => {
    const t = setup();
    t.quota.reserve.mockRejectedValue(new ConflictException('full'));
    t.mediaAsset.findFirst.mockResolvedValue({ ...ref, status: 'READY' });
    await t.service.createAccessUrl('owner-a', 'm1', 'a1');
    expect(t.quota.reserve).not.toHaveBeenCalled();
  });
});

describe('MediaService.complete', () => {
  it('verifies with the provider, checks the signature, then READY under the draft lock', async () => {
    const { message, mediaAsset, storage, service } = setup();
    const res = await service.complete('owner-a', 'm1', 'a1', 'file1');
    expect(mediaAsset.findFirst.mock.calls[0][0].where).toEqual(ownedAsset);
    expect(storage.verifyUpload).toHaveBeenCalledWith(KEY, 'file1');
    expect(storage.readStart).toHaveBeenCalledWith(
      { storageKey: KEY, storageProvider: 'IMAGEKIT', providerFileId: 'file1' },
      16,
    );
    expect(message.updateMany.mock.calls[0][0].where).toEqual({
      ...ownedMessage,
      status: 'DRAFT',
    });
    const { where, data } = mediaAsset.update.mock.calls[0][0];
    expect(where).toEqual({ ...ownedAsset, status: 'PENDING_UPLOAD' });
    expect(data).toEqual({
      status: 'READY',
      uploadedAt: expect.any(Date),
      providerFileId: 'file1',
    });
    expect(res).not.toHaveProperty('storageKey');
    expect(res).not.toHaveProperty('providerFileId');
  });

  it('VIDEO becomes READY on verification (original delivery: no processing step)', async () => {
    const { mediaAsset, storage, service } = setup();
    mediaAsset.findFirst.mockResolvedValue({
      ...pendingRow,
      kind: 'VIDEO',
      mimeType: 'video/mp4',
      sizeBytes: 30 * MB,
    });
    storage.verifyUpload.mockResolvedValue({
      sizeBytes: 30 * MB,
      contentType: 'video/mp4',
      isPrivate: true,
      providerFileId: 'file1',
    });
    storage.readStart.mockResolvedValue(fileStart('video/mp4'));
    await service.complete('owner-a', 'm1', 'a1', 'file1');
    expect(mediaAsset.update.mock.calls[0][0].data.status).toBe('READY');
  });

  it('MIME parameters and case do not cause a false mismatch', async () => {
    const { storage, mediaAsset, service } = setup();
    storage.verifyUpload.mockResolvedValue({
      sizeBytes: 100_000,
      contentType: 'Image/JPEG; charset=binary',
      isPrivate: true,
    });
    await service.complete('owner-a', 'm1', 'a1', 'file1');
    expect(mediaAsset.update.mock.calls[0][0].data.status).toBe('READY');
  });

  it('no file at this asset’s path (missing, or another path) → 409, stays PENDING, nothing deleted', async () => {
    const { storage, mediaAsset, cleanup, service } = setup();
    storage.verifyUpload.mockResolvedValue(null);
    await expect(
      service.complete('owner-a', 'm1', 'a1', 'someone-elses-file'),
    ).rejects.toThrow(NOT_UPLOADED);
    expect(mediaAsset.update).not.toHaveBeenCalled();
    expect(cleanup.purge).not.toHaveBeenCalled();
  });

  it.each([
    ['size', { sizeBytes: 99_999, contentType: 'image/jpeg', isPrivate: true }],
    ['MIME', { sizeBytes: 100_000, contentType: 'text/html', isPrivate: true }],
    [
      'public file',
      { sizeBytes: 100_000, contentType: 'image/jpeg', isPrivate: false },
    ],
  ])('%s mismatch → FAILED (never READY), file purged', async (_, stored) => {
    const { storage, mediaAsset, cleanup, service } = setup();
    storage.verifyUpload.mockResolvedValue({
      ...stored,
      providerFileId: 'file1',
    });
    mediaAsset.update.mockResolvedValue(ref);
    await expect(
      service.complete('owner-a', 'm1', 'a1', 'file1'),
    ).rejects.toThrow(UPLOAD_MISMATCH);
    expect(mediaAsset.update).toHaveBeenCalledTimes(1);
    expect(mediaAsset.update.mock.calls[0][0].data).toEqual({
      status: 'FAILED',
      providerFileId: 'file1',
    });
    expect(cleanup.purge).toHaveBeenCalledWith('mediaAsset', [ref]);
  });

  it('a file whose bytes are not a JPEG (renamed HTML) → FAILED: magic-byte check', async () => {
    const { storage, mediaAsset, cleanup, service } = setup();
    storage.readStart.mockResolvedValue(
      new TextEncoder().encode('<html><script>'),
    );
    mediaAsset.update.mockResolvedValue(ref);
    await expect(
      service.complete('owner-a', 'm1', 'a1', 'file1'),
    ).rejects.toThrow(UPLOAD_MISMATCH);
    expect(mediaAsset.update.mock.calls[0][0].data.status).toBe('FAILED');
    expect(cleanup.purge).toHaveBeenCalledTimes(1);
  });

  it('READY is idempotent: no provider call, no write, same uploadedAt', async () => {
    const { mediaAsset, storage, service } = setup();
    const uploadedAt = new Date('2026-09-01T00:00:00Z');
    mediaAsset.findFirst.mockResolvedValue({
      ...pendingRow,
      status: 'READY',
      uploadedAt,
      message: { status: 'SCHEDULED' },
    });
    const res = await service.complete('owner-a', 'm1', 'a1', 'file1');
    expect(res).toMatchObject({ status: 'READY', uploadedAt });
    expect(res).not.toHaveProperty('storageKey');
    expect(res).not.toHaveProperty('message');
    expect(storage.verifyUpload).not.toHaveBeenCalled();
    expect(mediaAsset.update).not.toHaveBeenCalled();
  });

  it('pending asset on a SCHEDULED message → 409, no provider call', async () => {
    const { mediaAsset, storage, service } = setup();
    mediaAsset.findFirst.mockResolvedValue({
      ...pendingRow,
      message: { status: 'SCHEDULED' },
    });
    await expect(
      service.complete('owner-a', 'm1', 'a1', 'file1'),
    ).rejects.toThrow(NOT_DRAFT);
    expect(storage.verifyUpload).not.toHaveBeenCalled();
  });

  it('scheduled between verification and write: lock fails → 409, never READY', async () => {
    const { message, mediaAsset, service } = setup();
    message.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      service.complete('owner-a', 'm1', 'a1', 'file1'),
    ).rejects.toThrow(NOT_DRAFT);
    expect(mediaAsset.update).not.toHaveBeenCalled();
  });

  it('FAILED asset → 409 without a provider call', async () => {
    const { mediaAsset, storage, service } = setup();
    mediaAsset.findFirst.mockResolvedValue({ ...pendingRow, status: 'FAILED' });
    await expect(
      service.complete('owner-a', 'm1', 'a1', 'file1'),
    ).rejects.toThrow(ConflictException);
    expect(storage.verifyUpload).not.toHaveBeenCalled();
  });

  it('cross-user → 404', async () => {
    const { mediaAsset, storage, service } = setup();
    mediaAsset.findFirst.mockResolvedValue(null);
    await expect(
      service.complete('owner-b', 'm1', 'a1', 'file1'),
    ).rejects.toThrow(NotFoundException);
    expect(storage.verifyUpload).not.toHaveBeenCalled();
  });

  it('a provider outage is a 503, not a 404, and nothing is written', async () => {
    const { storage, mediaAsset, service } = setup();
    storage.verifyUpload.mockRejectedValue(new ServiceUnavailableException());
    await expect(
      service.complete('owner-a', 'm1', 'a1', 'file1'),
    ).rejects.toThrow(ServiceUnavailableException);
    expect(mediaAsset.update).not.toHaveBeenCalled();
  });
});

describe('MediaService list / access / delete', () => {
  it('lists only the owner’s live media of an owned message', async () => {
    const { message, mediaAsset, service } = setup();
    const res = await service.findAllForMessage('owner-a', 'm1');
    expect(message.count).toHaveBeenCalledWith({ where: ownedMessage });
    const { where, select } = mediaAsset.findMany.mock.calls[0][0];
    expect(where).toEqual({
      messageId: 'm1',
      ownerUserId: 'owner-a',
      deletedAt: null,
    });
    for (const hidden of [
      'storageKey',
      'storageProvider',
      'providerFileId',
      'ownerUserId',
      'deletedAt',
    ]) {
      expect(select).not.toHaveProperty(hidden);
    }
    expect(res).toEqual([safe]);
  });

  it('cross-user list → 404', async () => {
    const { message, mediaAsset, service } = setup();
    message.count.mockResolvedValue(0);
    await expect(service.findAllForMessage('owner-b', 'm1')).rejects.toThrow(
      NotFoundException,
    );
    expect(mediaAsset.findMany).not.toHaveBeenCalled();
  });

  it('access URL for READY signs the row’s file with the configured TTL', async () => {
    const { mediaAsset, storage, service } = setup();
    mediaAsset.findFirst.mockResolvedValue({ status: 'READY', ...ref });
    const res = await service.createAccessUrl('owner-a', 'm1', 'a1');
    expect(mediaAsset.findFirst.mock.calls[0][0].where).toEqual(ownedAsset);
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
    'access URL for %s → 409, nothing signed',
    async (status) => {
      const { mediaAsset, storage, service } = setup();
      mediaAsset.findFirst.mockResolvedValue({ status, ...ref });
      await expect(
        service.createAccessUrl('owner-a', 'm1', 'a1'),
      ).rejects.toThrow(NOT_READY);
      expect(storage.createAccessUrl).not.toHaveBeenCalled();
    },
  );

  it('cross-user access URL → 404', async () => {
    const { mediaAsset, storage, service } = setup();
    mediaAsset.findFirst.mockResolvedValue(null);
    await expect(
      service.createAccessUrl('owner-b', 'm1', 'a1'),
    ).rejects.toThrow(NotFoundException);
    expect(storage.createAccessUrl).not.toHaveBeenCalled();
  });

  it('delete: soft-deletes first (scoped, under the draft lock), then purges the file', async () => {
    const { message, mediaAsset, cleanup, service } = setup();
    mediaAsset.update.mockResolvedValue(ref);
    await service.remove('owner-a', 'm1', 'a1');
    expect(message.updateMany).toHaveBeenCalledTimes(1);
    const { where, data } = mediaAsset.update.mock.calls[0][0];
    expect(where).toEqual(ownedAsset);
    expect(data).toEqual({ deletedAt: expect.any(Date) });
    expect(cleanup.purge).toHaveBeenCalledWith('mediaAsset', [ref]);
    expect(mediaAsset.update.mock.invocationCallOrder[0]).toBeLessThan(
      cleanup.purge.mock.invocationCallOrder[0],
    );
  });

  it('delete on a SCHEDULED message → 409; cross-user → 404; file untouched', async () => {
    const { message, mediaAsset, cleanup, service } = setup();
    message.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.remove('owner-a', 'm1', 'a1')).rejects.toThrow(
      NOT_DRAFT,
    );
    message.count.mockResolvedValue(0);
    await expect(service.remove('owner-b', 'm1', 'a1')).rejects.toThrow(
      NotFoundException,
    );
    // Own draft, but not this asset (someone else's or already deleted).
    message.updateMany.mockResolvedValue({ count: 1 });
    mediaAsset.update.mockRejectedValue(noMatch());
    await expect(service.remove('owner-a', 'm1', 'a1')).rejects.toThrow(
      NotFoundException,
    );
    expect(cleanup.purge).not.toHaveBeenCalled();
  });

  it('unexpected database errors are not turned into 404s', async () => {
    const { mediaAsset, service } = setup();
    mediaAsset.update.mockRejectedValue(new Error('boom'));
    await expect(service.remove('owner-a', 'm1', 'a1')).rejects.toThrow('boom');
    mediaAsset.findFirst.mockRejectedValue(new Error('boom'));
    await expect(
      service.complete('owner-a', 'm1', 'a1', 'file1'),
    ).rejects.toThrow('boom');
    expect(mediaAsset.count).not.toHaveBeenCalled();
  });
});

describe('upload checks', () => {
  it.each([
    'image/jpeg',
    'image/png',
    'image/webp',
    'audio/mpeg',
    'audio/mp4',
    'audio/webm',
    'audio/wav',
    'video/mp4',
    'video/webm',
  ])('%s: its own signature passes, others fail', (mime) => {
    expect(hasFileSignature(mime, fileStart(mime))).toBe(true);
    const other = mime.startsWith('image') ? 'audio/mpeg' : 'image/png';
    expect(hasFileSignature(mime, fileStart(other))).toBe(false);
    expect(hasFileSignature(mime, new Uint8Array())).toBe(false);
  });

  it('a WAV is not a WebP (same RIFF header)', () => {
    expect(hasFileSignature('image/webp', fileStart('audio/wav'))).toBe(false);
  });

  it('MP3 without an ID3 tag (frame sync) passes', () => {
    expect(
      hasFileSignature('audio/mpeg', new Uint8Array([0xff, 0xfb, 0x90])),
    ).toBe(true);
  });

  it('provider MIME aliases are accepted; a different type is not', () => {
    const expected = { sizeBytes: 5, mimeType: 'audio/webm' };
    expect(
      matchesUpload({ sizeBytes: 5, contentType: 'video/webm' }, expected),
    ).toBe(true);
    expect(
      matchesUpload({ sizeBytes: 5, contentType: 'audio/mpeg' }, expected),
    ).toBe(false);
    expect(matchesUpload({ sizeBytes: 5 }, expected)).toBe(true);
    expect(matchesUpload({ sizeBytes: 5, isPrivate: false }, expected)).toBe(
      false,
    );
  });
});

// Phase 12B: provider check → magic bytes → malware scan → READY.
describe('MediaService.complete malware scan', () => {
  const kinds = [
    ['PHOTO', 'image/jpeg', 100_000],
    ['AUDIO', 'audio/mp4', 5 * MB],
    ['VIDEO', 'video/mp4', 30 * MB],
  ] as const;
  const as = (
    t: ReturnType<typeof setup>,
    [kind, mimeType, sizeBytes]: readonly [string, string, number],
    bytes: Uint8Array = fileStart(mimeType),
  ) => {
    t.mediaAsset.findFirst.mockResolvedValue({
      ...pendingRow,
      kind,
      mimeType,
      sizeBytes,
    });
    t.storage.verifyUpload.mockResolvedValue({
      sizeBytes,
      contentType: mimeType,
      isPrivate: true,
      providerFileId: 'file1',
    });
    t.storage.readStart.mockResolvedValue(fileStart(mimeType));
    t.storage.openRead.mockImplementation(async () =>
      (async function* () {
        yield bytes;
      })(),
    );
  };
  const infected = (mimeType: string) =>
    new Uint8Array([...fileStart(mimeType), ...Buffer.from(FAKE_MALWARE)]);

  it.each(kinds)('clean %s → READY after the scan', async (...k) => {
    const t = setup();
    as(t, k);
    await t.service.complete('owner-a', 'm1', 'a1', 'file1');
    expect(t.scanner.scan).toHaveBeenCalledTimes(1);
    expect(t.storage.openRead).toHaveBeenCalledWith(
      { storageKey: KEY, storageProvider: 'IMAGEKIT', providerFileId: 'file1' },
      expect.any(AbortSignal),
    );
    expect(t.mediaAsset.update.mock.calls[0][0].data.status).toBe('READY');
  });

  it.each(kinds)(
    'infected %s → 400 generic, FAILED (never READY), file purged',
    async (...k) => {
      const t = setup();
      as(t, k, infected(k[1]));
      t.mediaAsset.update.mockResolvedValue(ref);
      const err = await t.service
        .complete('owner-a', 'm1', 'a1', 'file1')
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as Error).message).toBe(UPLOAD_REJECTED);
      expect(t.mediaAsset.update).toHaveBeenCalledTimes(1);
      expect(t.mediaAsset.update.mock.calls[0][0]).toMatchObject({
        where: { id: 'a1' },
        data: { status: 'FAILED', providerFileId: 'file1' },
      });
      expect(t.cleanup.purge).toHaveBeenCalledWith('mediaAsset', [ref]);
    },
  );

  it('an infected file cannot be retried into READY (FAILED is final)', async () => {
    const t = setup();
    t.mediaAsset.findFirst.mockResolvedValue({
      ...pendingRow,
      status: 'FAILED',
    });
    await expect(
      t.service.complete('owner-a', 'm1', 'a1', 'file1'),
    ).rejects.toThrow(ConflictException);
    expect(t.scanner.scan).not.toHaveBeenCalled();
  });

  it.each([
    ['scanner unavailable', () => Promise.reject(new Error('ECONNREFUSED'))],
    ['malformed verdict', () => Promise.resolve('stream: ??' as never)],
  ])(
    '%s → 503 generic, stays PENDING_UPLOAD (fail closed)',
    async (_, impl) => {
      const t = setup();
      t.scanner.scan.mockImplementation(impl);
      const err = await t.service
        .complete('owner-a', 'm1', 'a1', 'file1')
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ServiceUnavailableException);
      expect((err as Error).message).toBe(SCAN_UNAVAILABLE);
      expect(t.mediaAsset.update).not.toHaveBeenCalled();
      expect(t.cleanup.purge).not.toHaveBeenCalled();
    },
  );

  it('a provider download failure fails closed too', async () => {
    const t = setup();
    t.storage.openRead.mockRejectedValue(new ServiceUnavailableException());
    await expect(
      t.service.complete('owner-a', 'm1', 'a1', 'file1'),
    ).rejects.toThrow(SCAN_UNAVAILABLE);
    expect(t.mediaAsset.update).not.toHaveBeenCalled();
  });

  it('scanner timeout aborts the scan → 503, never READY', async () => {
    env.MEDIA_MALWARE_SCAN_TIMEOUT_MS = '20';
    try {
      const t = setup();
      // Never answers; only the timeout signal ends it.
      t.scanner.scan.mockImplementation(
        (_file: unknown, signal?: AbortSignal) =>
          new Promise((_, reject) =>
            signal!.addEventListener('abort', () => reject(signal!.reason)),
          ),
      );
      await expect(
        t.service.complete('owner-a', 'm1', 'a1', 'file1'),
      ).rejects.toThrow(SCAN_UNAVAILABLE);
      expect(t.mediaAsset.update).not.toHaveBeenCalled();
    } finally {
      delete env.MEDIA_MALWARE_SCAN_TIMEOUT_MS;
    }
  });

  it('a stream larger than the verified size is cut off → 503', async () => {
    const t = setup();
    // Provider said 100 kB; the download keeps going.
    t.storage.openRead.mockImplementation(async () =>
      (async function* () {
        for (let i = 0; i < 3; i++) yield new Uint8Array(50_000);
      })(),
    );
    await expect(
      t.service.complete('owner-a', 'm1', 'a1', 'file1'),
    ).rejects.toThrow(SCAN_UNAVAILABLE);
    expect(t.mediaAsset.update).not.toHaveBeenCalled();
  });

  it('a magic-byte failure is never scanned or treated as clean', async () => {
    const t = setup();
    t.storage.readStart.mockResolvedValue(new TextEncoder().encode('MZ'));
    t.mediaAsset.update.mockResolvedValue(ref);
    await expect(
      t.service.complete('owner-a', 'm1', 'a1', 'file1'),
    ).rejects.toThrow(UPLOAD_MISMATCH);
    expect(t.storage.openRead).not.toHaveBeenCalled();
    expect(t.scanner.scan).not.toHaveBeenCalled();
    expect(t.mediaAsset.update.mock.calls[0][0].data.status).toBe('FAILED');
  });

  it('a size mismatch is rejected before any download or scan', async () => {
    const t = setup();
    t.storage.verifyUpload.mockResolvedValue({
      sizeBytes: 999_999_999,
      contentType: 'image/jpeg',
      isPrivate: true,
    });
    t.mediaAsset.update.mockResolvedValue(ref);
    await expect(
      t.service.complete('owner-a', 'm1', 'a1', 'file1'),
    ).rejects.toThrow(UPLOAD_MISMATCH);
    expect(t.storage.openRead).not.toHaveBeenCalled();
  });

  it('a FAILED (infected) asset gets no signed access URL', async () => {
    const t = setup();
    t.mediaAsset.findFirst.mockResolvedValue({ ...ref, status: 'FAILED' });
    await expect(
      t.service.createAccessUrl('owner-a', 'm1', 'a1'),
    ).rejects.toThrow(NOT_READY);
    expect(t.storage.createAccessUrl).not.toHaveBeenCalled();
  });
});

describe('MediaService config', () => {
  it('refuses to start with an invalid limit', () => {
    expect(
      () =>
        new MediaService(
          {} as PrismaService,
          {} as MediaStorage,
          {} as MalwareScanner,
          {} as MediaCleanup,
          {} as StorageQuota,
          { get: () => 'abc' } as unknown as ConfigService,
        ),
    ).toThrow('must be a positive whole number');
  });
});
