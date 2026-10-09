import type { StorageQuota } from '../media/storage-quota.service.js';
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { Prisma } from '../generated/prisma/client.js';
import {
  FAKE_MALWARE,
  FakeMalwareScanner,
} from '../../test/fake-malware-scanner.js';
import { fileStart } from '../../test/fake-media-storage.js';
import type { MalwareScanner } from '../media/scanner/malware-scanner.service.js';
import type { MediaCleanup } from '../media/media-cleanup.service.js';
import type { MediaStorage } from '../media/storage/media-storage.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { RecipientPhotoService } from './recipient-photo.service.js';

const OWNER = '11111111-1111-4111-8111-111111111111';
const RECIPIENT = '22222222-2222-4222-8222-222222222222';
const PHOTO = '33333333-3333-4333-8333-333333333333';
const MB = 1024 * 1024;
const upload = (over: object = {}) => ({
  kind: 'PHOTO' as const,
  originalFileName: 'mum.jpg',
  mimeType: 'image/jpeg',
  sizeBytes: 2 * MB,
  ...over,
});
const pending = {
  id: PHOTO,
  kind: 'PHOTO',
  status: 'PENDING_UPLOAD',
  originalFileName: 'mum.jpg',
  mimeType: 'image/jpeg',
  sizeBytes: 2 * MB,
  storageKey: '/for-after/users/o/recipients/r/photo/p.jpg',
};
const ref = {
  id: PHOTO,
  storageKey: pending.storageKey,
  storageProvider: 'IMAGEKIT',
  providerFileId: 'file1',
  createdAt: new Date(),
};

const setup = () => {
  const recipientPhoto = {
    create: vi.fn().mockResolvedValue({ id: PHOTO }),
    findFirst: vi.fn().mockResolvedValue(pending),
    findMany: vi.fn().mockResolvedValue([]),
    findUniqueOrThrow: vi
      .fn()
      .mockResolvedValue({ ...pending, status: 'READY' }),
    update: vi.fn().mockResolvedValue(ref),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
  };
  const tx = {
    recipient: { count: vi.fn().mockResolvedValue(1) },
    recipientPhoto,
    $queryRaw: vi.fn().mockResolvedValue([{ id: RECIPIENT }]),
  };
  const prisma = {
    recipientPhoto,
    $transaction: vi.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const storage = {
    createUpload: vi.fn().mockResolvedValue({
      url: 'https://upload.test/files',
      fields: { token: 't' },
    }),
    verifyUpload: vi.fn().mockResolvedValue({
      sizeBytes: 2 * MB,
      contentType: 'image/jpeg',
      isPrivate: true,
      providerFileId: 'file1',
    }),
    readStart: vi.fn().mockResolvedValue(fileStart('image/jpeg')),
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
  const config = { get: () => undefined } as unknown as ConfigService;
  const service = new RecipientPhotoService(
    prisma as unknown as PrismaService,
    storage as unknown as MediaStorage,
    scanner as unknown as MalwareScanner,
    cleanup as unknown as MediaCleanup,
    quota as unknown as StorageQuota,
    config,
  );
  return {
    service,
    prisma,
    tx,
    recipientPhoto,
    storage,
    scanner,
    cleanup,
    quota,
  };
};

describe('RecipientPhotoService (Phase 09)', () => {
  beforeEach(() =>
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined),
  );
  afterEach(() => vi.restoreAllMocks());

  it('signs an upload for a server-made path of ids only (no name, contact or note)', async () => {
    const { service, storage, recipientPhoto } = setup();
    const res = await service.createUploadUrl(OWNER, RECIPIENT, upload());
    const key = recipientPhoto.create.mock.calls[0][0].data.storageKey;
    expect(key).toMatch(
      new RegExp(
        `^/for-after/users/${OWNER}/recipients/${RECIPIENT}/photo/[0-9a-f-]{36}\\.jpg$`,
      ),
    );
    expect(storage.createUpload).toHaveBeenCalledWith(
      key,
      'image/jpeg',
      2 * MB,
      600,
    );
    expect(res).toMatchObject({
      mediaAssetId: expect.any(String),
      upload: { url: 'https://upload.test/files' },
    });
  });

  it.each([
    [
      'audio',
      { kind: 'AUDIO', mimeType: 'audio/mpeg' },
      'must be a JPEG, PNG or WebP',
    ],
    ['SVG', { mimeType: 'image/svg+xml' }, 'not allowed'],
    [
      'over 5 MB',
      { sizeBytes: 5 * MB + 1 },
      'exceeds the PHOTO limit of 5242880',
    ],
  ])('refuses %s before touching the database', async (_, over, message) => {
    const { service, prisma } = setup();
    await expect(
      service.createUploadUrl(OWNER, RECIPIENT, upload(over) as never),
    ).rejects.toThrow(message);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('a foreign or deleted Recipient is 404 and nothing is signed', async () => {
    const { service, tx, storage } = setup();
    tx.recipient.count.mockResolvedValue(0);
    await expect(
      service.createUploadUrl(OWNER, RECIPIENT, upload()),
    ).rejects.toThrow('Recipient not found.');
    expect(tx.recipient.count).toHaveBeenCalledWith({
      where: { id: RECIPIENT, ownerUserId: OWNER, deletedAt: null },
    });
    expect(storage.createUpload).not.toHaveBeenCalled();
  });

  it('complete: no file at this path → 409; size mismatch → FAILED and the file purged', async () => {
    const a = setup();
    a.storage.verifyUpload.mockResolvedValue(null);
    await expect(
      a.service.complete(OWNER, RECIPIENT, PHOTO, 'file1'),
    ).rejects.toThrow('The file has not been uploaded yet.');
    const b = setup();
    b.storage.verifyUpload.mockResolvedValue({
      sizeBytes: 1,
      providerFileId: 'file1',
    });
    await expect(
      b.service.complete(OWNER, RECIPIENT, PHOTO, 'file1'),
    ).rejects.toThrow('does not match');
    expect(b.recipientPhoto.update.mock.calls[0][0]).toMatchObject({
      where: { id: PHOTO },
      data: { status: 'FAILED', providerFileId: 'file1' },
    });
    expect(b.cleanup.purge).toHaveBeenCalledWith('recipientPhoto', [ref]);
  });

  it('complete: an infected photo → FAILED and purged, never READY', async () => {
    const { service, storage, recipientPhoto, cleanup } = setup();
    storage.openRead.mockImplementation(async () =>
      (async function* () {
        yield new Uint8Array([
          ...fileStart('image/jpeg'),
          ...Buffer.from(FAKE_MALWARE),
        ]);
      })(),
    );
    await expect(
      service.complete(OWNER, RECIPIENT, PHOTO, 'file1'),
    ).rejects.toThrow('could not be accepted');
    expect(recipientPhoto.update.mock.calls[0][0].data.status).toBe('FAILED');
    expect(recipientPhoto.updateMany).not.toHaveBeenCalled();
    expect(cleanup.purge).toHaveBeenCalledWith('recipientPhoto', [ref]);
  });

  it('complete: locks the live Recipient, supersedes the old photo, then READY; old file purged after commit', async () => {
    const { service, tx, recipientPhoto, cleanup } = setup();
    const old = { ...ref, id: 'old', storageKey: '/for-after/x/old.png' };
    recipientPhoto.findMany.mockResolvedValue([old]);
    const res = await service.complete(OWNER, RECIPIENT, PHOTO, 'file1');
    expect(res.status).toBe('READY');
    expect(tx.$queryRaw).toHaveBeenCalled();
    const [supersede, ready] = recipientPhoto.updateMany.mock.calls.map(
      (c) => c[0],
    );
    expect(supersede).toMatchObject({
      where: { id: { in: ['old'] } },
      data: { deletedAt: expect.any(Date) },
    });
    expect(ready).toMatchObject({
      where: { id: PHOTO, status: 'PENDING_UPLOAD', deletedAt: null },
      data: { status: 'READY', providerFileId: 'file1' },
    });
    expect(cleanup.purge).toHaveBeenCalledWith('recipientPhoto', [old]);
  });

  it('complete: a Recipient deleted meanwhile gets no photo (404, nothing superseded)', async () => {
    const { service, tx, recipientPhoto } = setup();
    tx.$queryRaw.mockResolvedValue([]);
    await expect(
      service.complete(OWNER, RECIPIENT, PHOTO, 'file1'),
    ).rejects.toThrow('Recipient not found.');
    expect(recipientPhoto.updateMany).not.toHaveBeenCalled();
  });

  it('access: READY only, owner-scoped, a short-lived signed GET that is never stored', async () => {
    const { service, recipientPhoto, storage } = setup();
    await expect(
      service.createAccessUrl(OWNER, RECIPIENT, PHOTO),
    ).rejects.toThrow('Media is not ready.');
    recipientPhoto.findFirst.mockResolvedValue({ ...ref, status: 'READY' });
    const res = await service.createAccessUrl(OWNER, RECIPIENT, PHOTO);
    expect(res.url).toBe('https://media.test/signed');
    expect(storage.createAccessUrl).toHaveBeenCalledWith(
      { ...ref, status: 'READY' },
      300,
    );
    expect(recipientPhoto.findFirst.mock.calls.at(-1)![0].where).toMatchObject({
      ownerUserId: OWNER,
      recipientId: RECIPIENT,
      deletedAt: null,
      recipient: { id: RECIPIENT, ownerUserId: OWNER, deletedAt: null },
    });
    expect(recipientPhoto.update).not.toHaveBeenCalled();
  });

  it('remove: someone else’s photo is 404; otherwise soft delete, then purge', async () => {
    const a = setup();
    a.recipientPhoto.update.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('none', {
        code: 'P2025',
        clientVersion: 'test',
      }),
    );
    await expect(a.service.remove(OWNER, RECIPIENT, PHOTO)).rejects.toThrow(
      'Photo not found.',
    );
    expect(a.cleanup.purge).not.toHaveBeenCalled();
    const b = setup();
    await expect(
      b.service.remove(OWNER, RECIPIENT, PHOTO),
    ).resolves.toBeUndefined();
    expect(b.cleanup.purge).toHaveBeenCalledWith('recipientPhoto', [ref]);
  });
});
