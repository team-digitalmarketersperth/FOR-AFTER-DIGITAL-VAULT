import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { Prisma } from '../generated/prisma/client.js';
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
  storageKey: 'users/o/recipients/r/photo/p.jpg',
};

const setup = () => {
  const recipientPhoto = {
    create: vi.fn().mockResolvedValue({ id: PHOTO }),
    findFirst: vi.fn().mockResolvedValue(pending),
    findMany: vi.fn().mockResolvedValue([]),
    findUniqueOrThrow: vi
      .fn()
      .mockResolvedValue({ ...pending, status: 'READY' }),
    update: vi.fn().mockResolvedValue({ storageKey: pending.storageKey }),
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
    createUploadUrl: vi.fn().mockResolvedValue('https://signed.put/x'),
    createAccessUrl: vi.fn().mockResolvedValue('https://signed.get/x'),
    headObject: vi.fn().mockResolvedValue({
      sizeBytes: 2 * MB,
      contentType: 'image/jpeg',
    }),
    deleteObject: vi.fn().mockResolvedValue(undefined),
  };
  const config = { get: () => undefined } as unknown as ConfigService;
  const service = new RecipientPhotoService(
    prisma as unknown as PrismaService,
    storage as unknown as MediaStorage,
    config,
  );
  return { service, prisma, tx, recipientPhoto, storage };
};

describe('RecipientPhotoService (Phase 09)', () => {
  beforeEach(() =>
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined),
  );
  afterEach(() => vi.restoreAllMocks());

  it('signs a PUT for a server-made key of ids only (no name, contact or note)', async () => {
    const { service, storage, recipientPhoto } = setup();
    const res = await service.createUploadUrl(OWNER, RECIPIENT, upload());
    const key = recipientPhoto.create.mock.calls[0][0].data.storageKey;
    expect(key).toMatch(
      new RegExp(
        `^users/${OWNER}/recipients/${RECIPIENT}/photo/[0-9a-f-]{36}\\.jpg$`,
      ),
    );
    expect(storage.createUploadUrl).toHaveBeenCalledWith(
      key,
      'image/jpeg',
      600,
    );
    expect(res).toMatchObject({
      mediaAssetId: expect.any(String),
      requiredHeaders: { 'Content-Type': 'image/jpeg' },
    });
    expect(JSON.stringify(res)).not.toContain(key);
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
    expect(storage.createUploadUrl).not.toHaveBeenCalled();
  });

  it('complete: no object yet → 409; size mismatch → FAILED and the object removed', async () => {
    const a = setup();
    a.storage.headObject.mockResolvedValue(null);
    await expect(a.service.complete(OWNER, RECIPIENT, PHOTO)).rejects.toThrow(
      'The file has not been uploaded yet.',
    );
    const b = setup();
    b.storage.headObject.mockResolvedValue({ sizeBytes: 1 });
    await expect(b.service.complete(OWNER, RECIPIENT, PHOTO)).rejects.toThrow(
      'does not match',
    );
    expect(b.recipientPhoto.update).toHaveBeenCalledWith({
      where: { id: PHOTO },
      data: { status: 'FAILED' },
    });
    expect(b.storage.deleteObject).toHaveBeenCalledWith(pending.storageKey);
  });

  it('complete: locks the live Recipient, supersedes the old photo, then READY; old object removed after commit', async () => {
    const { service, tx, recipientPhoto, storage } = setup();
    recipientPhoto.findMany.mockResolvedValue([
      { id: 'old', storageKey: 'users/o/recipients/r/photo/old.png' },
    ]);
    const res = await service.complete(OWNER, RECIPIENT, PHOTO);
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
      data: { status: 'READY' },
    });
    expect(storage.deleteObject).toHaveBeenCalledWith(
      'users/o/recipients/r/photo/old.png',
    );
  });

  it('complete: an old object that cannot be deleted never undoes the new photo', async () => {
    const { service, recipientPhoto, storage } = setup();
    recipientPhoto.findMany.mockResolvedValue([{ id: 'old', storageKey: 'k' }]);
    storage.deleteObject.mockRejectedValue(new Error('storage down'));
    await expect(
      service.complete(OWNER, RECIPIENT, PHOTO),
    ).resolves.toMatchObject({ status: 'READY' });
  });

  it('complete: a Recipient deleted meanwhile gets no photo (404, nothing superseded)', async () => {
    const { service, tx, recipientPhoto } = setup();
    tx.$queryRaw.mockResolvedValue([]);
    await expect(service.complete(OWNER, RECIPIENT, PHOTO)).rejects.toThrow(
      'Recipient not found.',
    );
    expect(recipientPhoto.updateMany).not.toHaveBeenCalled();
  });

  it('access: READY only, owner-scoped, a short-lived signed GET that is never stored', async () => {
    const { service, recipientPhoto, storage } = setup();
    await expect(
      service.createAccessUrl(OWNER, RECIPIENT, PHOTO),
    ).rejects.toThrow('Media is not ready.');
    recipientPhoto.findFirst.mockResolvedValue({ ...pending, status: 'READY' });
    const res = await service.createAccessUrl(OWNER, RECIPIENT, PHOTO);
    expect(res.url).toBe('https://signed.get/x');
    expect(storage.createAccessUrl).toHaveBeenCalledWith(
      pending.storageKey,
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

  it('remove: someone else’s photo is 404; a storage failure after the soft delete is swallowed', async () => {
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
    const b = setup();
    b.storage.deleteObject.mockRejectedValue(new Error('storage down'));
    await expect(
      b.service.remove(OWNER, RECIPIENT, PHOTO),
    ).resolves.toBeUndefined();
  });
});
