import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Prisma } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { CreateMediaUploadDto } from './dto/create-media-upload.dto.js';
import {
  MediaService,
  NOT_DRAFT,
  NOT_READY,
  NOT_UPLOADED,
  UPLOAD_MISMATCH,
} from './media.service.js';
import type { MediaStorage } from './storage/media-storage.service.js';

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
const pendingRow = {
  ...safe,
  storageKey: 'users/owner-a/messages/m1/a1.jpg',
  message: { status: 'DRAFT' },
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
  const storage = {
    createUploadUrl: vi.fn().mockResolvedValue('https://signed.example/put'),
    createAccessUrl: vi.fn().mockResolvedValue('https://signed.example/get'),
    headObject: vi
      .fn()
      .mockResolvedValue({ sizeBytes: 100_000, contentType: 'image/jpeg' }),
    deleteObject: vi.fn().mockResolvedValue(undefined),
  };
  const config = { get: (key: string) => env[key] } as ConfigService;
  const tx = { message, mediaAsset };
  const $transaction = vi.fn((fn: (t: typeof tx) => unknown) => fn(tx));
  return {
    message,
    mediaAsset,
    storage,
    $transaction,
    service: new MediaService(
      { ...tx, $transaction } as unknown as PrismaService,
      storage as unknown as MediaStorage,
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
const ownedMessage = { id: 'm1', ownerUserId: 'owner-a', deletedAt: null };
const ownedAsset = {
  id: 'a1',
  ownerUserId: 'owner-a',
  messageId: 'm1',
  deletedAt: null,
  message: ownedMessage,
};

const errorsFor = async (body: object) =>
  (
    await validate(plainToInstance(CreateMediaUploadDto, body), {
      whitelist: true,
      forbidNonWhitelisted: true,
    })
  ).map((e) => e.property);

describe('CreateMediaUploadDto', () => {
  it.each([photo, audio])('accepts %o', async (body) => {
    expect(await errorsFor(body)).toEqual([]);
  });

  it.each([
    ['kind', { kind: 'VIDEO', mimeType: 'video/mp4' }],
    ['kind', { kind: null }],
    ['mimeType', { mimeType: 'image/svg+xml' }],
    ['mimeType', { mimeType: 'image/*' }],
    ['mimeType', { mimeType: 'audio/ogg' }],
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
    expect(await errorsFor({ ...photo, ...patch })).toContain(field);
  });
});

describe('MediaService.createUploadUrl', () => {
  it('PHOTO: server-generated key, TTL from config, PENDING row, safe response', async () => {
    const { mediaAsset, storage, service } = setup();
    const res = await service.createUploadUrl('owner-a', 'm1', {
      ...photo,
      originalFileName: '../../etc/passwd.exe',
      // Smuggled fields (the ValidationPipe rejects these first in HTTP).
      ...({ ownerUserId: 'owner-b', storageKey: 'evil' } as object),
    });
    const { data } = mediaAsset.create.mock.calls[0][0];
    expect(data.ownerUserId).toBe('owner-a');
    expect(data.messageId).toBe('m1');
    expect(data.storageKey).toBe(`users/owner-a/messages/m1/${data.id}.jpg`);
    expect(data.storageKey).not.toContain('passwd');
    expect(data).not.toHaveProperty('status');
    expect(storage.createUploadUrl).toHaveBeenCalledWith(
      data.storageKey,
      'image/jpeg',
      600,
    );
    expect(res).toEqual({
      mediaAssetId: data.id,
      uploadUrl: 'https://signed.example/put',
      expiresAt: expect.any(Date),
      requiredHeaders: { 'Content-Type': 'image/jpeg' },
    });
    expect(JSON.stringify(res)).not.toMatch(/storageKey|owner|users\//);
  });

  it('AUDIO: extension comes from the MIME type, not the filename', async () => {
    const { mediaAsset, service } = setup();
    await service.createUploadUrl('owner-a', 'm1', {
      ...audio,
      originalFileName: 'voice.jpg',
    });
    expect(mediaAsset.create.mock.calls[0][0].data.storageKey).toMatch(
      /\.m4a$/,
    );
  });

  it.each([
    ['PHOTO + audio MIME', { ...photo, mimeType: 'audio/mpeg' }],
    ['AUDIO + image MIME', { ...audio, mimeType: 'image/jpeg' }],
    ['PHOTO over 20 MB', { ...photo, sizeBytes: 20 * MB + 1 }],
    ['AUDIO over 100 MB', { ...audio, sizeBytes: 100 * MB + 1 }],
  ])('%s → 400 before any database or storage call', async (_, dto) => {
    const { message, storage, service } = setup();
    await expect(service.createUploadUrl('owner-a', 'm1', dto)).rejects.toThrow(
      BadRequestException,
    );
    expect(message.updateMany).not.toHaveBeenCalled();
    expect(storage.createUploadUrl).not.toHaveBeenCalled();
  });

  it('exact limits are allowed', async () => {
    const { service } = setup();
    await service.createUploadUrl('owner-a', 'm1', {
      ...photo,
      sizeBytes: 20 * MB,
    });
    await service.createUploadUrl('owner-a', 'm1', {
      ...audio,
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
    expect(storage.createUploadUrl).not.toHaveBeenCalled();
    expect(mediaAsset.create).not.toHaveBeenCalled();
  });

  it('a non-DRAFT (SCHEDULED/RELEASED/CANCELLED) owned message → 409', async () => {
    // The lock only matches DRAFT; the owned message exists (count 1).
    const { message, mediaAsset, storage, service } = setup();
    message.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      service.createUploadUrl('owner-a', 'm1', photo),
    ).rejects.toThrow(NOT_DRAFT);
    expect(mediaAsset.create).not.toHaveBeenCalled();
    expect(storage.createUploadUrl).not.toHaveBeenCalled();
  });

  it('insert and signing run under the draft lock in one transaction', async () => {
    const { message, mediaAsset, storage, $transaction, service } = setup();
    await service.createUploadUrl('owner-a', 'm1', photo);
    expect($transaction).toHaveBeenCalledTimes(1);
    expect(message.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      mediaAsset.create.mock.invocationCallOrder[0],
    );
    expect(storage.createUploadUrl).toHaveBeenCalledTimes(1);
  });
});

describe('MediaService.complete', () => {
  it('HEADs storage, then marks READY with uploadedAt under the draft lock', async () => {
    const { message, mediaAsset, storage, service } = setup();
    const res = await service.complete('owner-a', 'm1', 'a1');
    expect(mediaAsset.findFirst.mock.calls[0][0].where).toEqual(ownedAsset);
    expect(storage.headObject).toHaveBeenCalledWith(pendingRow.storageKey);
    expect(message.updateMany.mock.calls[0][0].where).toEqual({
      ...ownedMessage,
      status: 'DRAFT',
    });
    const { where, data } = mediaAsset.update.mock.calls[0][0];
    expect(where).toEqual({ ...ownedAsset, status: 'PENDING_UPLOAD' });
    expect(data).toEqual({ status: 'READY', uploadedAt: expect.any(Date) });
    expect(res).not.toHaveProperty('storageKey');
  });

  it('content type parameters and case do not cause a false mismatch', async () => {
    const { storage, mediaAsset, service } = setup();
    storage.headObject.mockResolvedValue({
      sizeBytes: 100_000,
      contentType: 'Image/JPEG; charset=binary',
    });
    await service.complete('owner-a', 'm1', 'a1');
    expect(mediaAsset.update.mock.calls[0][0].data.status).toBe('READY');
  });

  it('missing object → 409 and stays PENDING_UPLOAD', async () => {
    const { storage, mediaAsset, service } = setup();
    storage.headObject.mockResolvedValue(null);
    await expect(service.complete('owner-a', 'm1', 'a1')).rejects.toThrow(
      NOT_UPLOADED,
    );
    expect(mediaAsset.update).not.toHaveBeenCalled();
  });

  it.each([
    ['size', { sizeBytes: 99_999, contentType: 'image/jpeg' }],
    ['MIME', { sizeBytes: 100_000, contentType: 'text/html' }],
  ])('%s mismatch → FAILED (never READY), object removed', async (_, head) => {
    const { storage, mediaAsset, service } = setup();
    storage.headObject.mockResolvedValue(head);
    await expect(service.complete('owner-a', 'm1', 'a1')).rejects.toThrow(
      UPLOAD_MISMATCH,
    );
    expect(mediaAsset.update).toHaveBeenCalledTimes(1);
    expect(mediaAsset.update.mock.calls[0][0].data).toEqual({
      status: 'FAILED',
    });
    expect(storage.deleteObject).toHaveBeenCalledWith(pendingRow.storageKey);
  });

  it('READY is idempotent: no HEAD, no write, same uploadedAt', async () => {
    const { mediaAsset, storage, service } = setup();
    const uploadedAt = new Date('2026-09-01T00:00:00Z');
    mediaAsset.findFirst.mockResolvedValue({
      ...pendingRow,
      status: 'READY',
      uploadedAt,
      message: { status: 'SCHEDULED' },
    });
    const res = await service.complete('owner-a', 'm1', 'a1');
    expect(res).toMatchObject({ status: 'READY', uploadedAt });
    expect(res).not.toHaveProperty('storageKey');
    expect(res).not.toHaveProperty('message');
    expect(storage.headObject).not.toHaveBeenCalled();
    expect(mediaAsset.update).not.toHaveBeenCalled();
  });

  it('pending asset on a SCHEDULED message → 409, no HEAD', async () => {
    const { mediaAsset, storage, service } = setup();
    mediaAsset.findFirst.mockResolvedValue({
      ...pendingRow,
      message: { status: 'SCHEDULED' },
    });
    await expect(service.complete('owner-a', 'm1', 'a1')).rejects.toThrow(
      NOT_DRAFT,
    );
    expect(storage.headObject).not.toHaveBeenCalled();
  });

  it('scheduled between HEAD and write: lock fails → 409, never READY', async () => {
    const { message, mediaAsset, service } = setup();
    message.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.complete('owner-a', 'm1', 'a1')).rejects.toThrow(
      NOT_DRAFT,
    );
    expect(mediaAsset.update).not.toHaveBeenCalled();
  });

  it('FAILED asset → 409 without HEAD', async () => {
    const { mediaAsset, storage, service } = setup();
    mediaAsset.findFirst.mockResolvedValue({ ...pendingRow, status: 'FAILED' });
    await expect(service.complete('owner-a', 'm1', 'a1')).rejects.toThrow(
      ConflictException,
    );
    expect(storage.headObject).not.toHaveBeenCalled();
  });

  it('cross-user → 404', async () => {
    const { mediaAsset, storage, service } = setup();
    mediaAsset.findFirst.mockResolvedValue(null);
    await expect(service.complete('owner-b', 'm1', 'a1')).rejects.toThrow(
      NotFoundException,
    );
    expect(storage.headObject).not.toHaveBeenCalled();
  });

  it('a storage outage is a 503, not a 404, and nothing is written', async () => {
    const { storage, mediaAsset, service } = setup();
    storage.headObject.mockRejectedValue(new ServiceUnavailableException());
    await expect(service.complete('owner-a', 'm1', 'a1')).rejects.toThrow(
      ServiceUnavailableException,
    );
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
    for (const hidden of ['storageKey', 'ownerUserId', 'deletedAt']) {
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

  it('access URL for READY uses the configured TTL', async () => {
    const { mediaAsset, storage, service } = setup();
    mediaAsset.findFirst.mockResolvedValue({
      status: 'READY',
      storageKey: pendingRow.storageKey,
    });
    const res = await service.createAccessUrl('owner-a', 'm1', 'a1');
    expect(mediaAsset.findFirst.mock.calls[0][0].where).toEqual(ownedAsset);
    expect(storage.createAccessUrl).toHaveBeenCalledWith(
      pendingRow.storageKey,
      300,
    );
    expect(res).toEqual({
      url: 'https://signed.example/get',
      expiresAt: expect.any(Date),
    });
  });

  it.each(['PENDING_UPLOAD', 'FAILED'])(
    'access URL for %s → 409, nothing signed',
    async (status) => {
      const { mediaAsset, storage, service } = setup();
      mediaAsset.findFirst.mockResolvedValue({ status, storageKey: 'k' });
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

  it('delete: soft-deletes first (scoped, under the draft lock), then removes the object', async () => {
    const { message, mediaAsset, storage, service } = setup();
    mediaAsset.update.mockResolvedValue({ storageKey: 'the-key' });
    await service.remove('owner-a', 'm1', 'a1');
    expect(message.updateMany).toHaveBeenCalledTimes(1);
    const { where, data } = mediaAsset.update.mock.calls[0][0];
    expect(where).toEqual(ownedAsset);
    expect(data).toEqual({ deletedAt: expect.any(Date) });
    expect(storage.deleteObject).toHaveBeenCalledWith('the-key');
    expect(mediaAsset.update.mock.invocationCallOrder[0]).toBeLessThan(
      storage.deleteObject.mock.invocationCallOrder[0],
    );
  });

  it('delete: a storage failure does not restore access or fail the request', async () => {
    const { mediaAsset, storage, service } = setup();
    mediaAsset.update.mockResolvedValue({ storageKey: 'the-key' });
    storage.deleteObject.mockRejectedValue(new ServiceUnavailableException());
    await expect(
      service.remove('owner-a', 'm1', 'a1'),
    ).resolves.toBeUndefined();
    expect(mediaAsset.update).toHaveBeenCalledTimes(1);
  });

  it('delete on a SCHEDULED message → 409; cross-user → 404; object untouched', async () => {
    const { message, mediaAsset, storage, service } = setup();
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
    expect(storage.deleteObject).not.toHaveBeenCalled();
  });

  it('unexpected database errors are not turned into 404s', async () => {
    const { mediaAsset, service } = setup();
    mediaAsset.update.mockRejectedValue(new Error('boom'));
    await expect(service.remove('owner-a', 'm1', 'a1')).rejects.toThrow('boom');
    mediaAsset.findFirst.mockRejectedValue(new Error('boom'));
    await expect(service.complete('owner-a', 'm1', 'a1')).rejects.toThrow(
      'boom',
    );
    expect(mediaAsset.count).not.toHaveBeenCalled();
  });
});

describe('MediaService config', () => {
  it('refuses to start with an invalid limit', () => {
    expect(
      () =>
        new MediaService(
          {} as PrismaService,
          {} as MediaStorage,
          { get: () => 'abc' } as unknown as ConfigService,
        ),
    ).toThrow('must be a positive whole number');
  });
});
