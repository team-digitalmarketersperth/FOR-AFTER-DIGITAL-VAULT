import type { StorageQuota } from '../media/storage-quota.service.js';
import { Logger, NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  FAKE_MALWARE,
  FakeMalwareScanner,
} from '../../test/fake-malware-scanner.js';
import { FakeMediaStorage, fileStart } from '../../test/fake-media-storage.js';
import type { MediaCleanup } from '../media/media-cleanup.service.js';
import type { MalwareScanner } from '../media/scanner/malware-scanner.service.js';
import type { MediaStorage } from '../media/storage/media-storage.service.js';
import { MessageSnapshotService } from '../messages/message-snapshot.service.js';
import type { MessagesService } from '../messages/messages.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { CreateMessageFromMemoryDto } from './dto/create-message-from-memory.dto.js';
import {
  INVALID_MEMORY_MEDIA,
  MemoryToMessageService,
} from './memory-to-message.service.js';

const OWNER = 'owner-a';
const R1 = '11111111-1111-4111-8111-111111111111';
const PHOTO_ID = '22222222-2222-4222-8222-222222222222';
const AUDIO_ID = '33333333-3333-4333-8333-333333333333';
const photoKey = `/for-after/users/${OWNER}/memory-vault/v1/photo/${PHOTO_ID}.jpg`;
const audioKey = `/for-after/users/${OWNER}/memory-vault/v1/audio/${AUDIO_ID}.mp3`;
const source = (id: string, kind: string, mimeType: string, key: string) => ({
  id,
  kind,
  mimeType,
  sizeBytes: 6,
  originalFileName: `${kind.toLowerCase()}.bin`,
  storageKey: key,
  storageProvider: 'IMAGEKIT',
  providerFileId: `src-${id}`,
  createdAt: new Date(),
});
const photo = source(PHOTO_ID, 'PHOTO', 'image/jpeg', photoKey);
const audio = source(AUDIO_ID, 'AUDIO', 'audio/mpeg', audioKey);

const setup = () => {
  const storage = new FakeMediaStorage();
  // The memory's own files at the provider.
  for (const [key, mime] of [
    [photoKey, 'image/jpeg'],
    [audioKey, 'audio/mpeg'],
  ]) {
    storage.files.set(`src-${key}`, {
      key,
      sizeBytes: 6,
      contentType: mime,
      isPrivate: true,
      bytes: fileStart(mime),
    });
  }
  const scanner = new FakeMalwareScanner();
  // Like Prisma: only the requested files among this memory's live READY ones.
  let memoryFiles = [photo, audio];
  const memoryVaultItem = {
    findFirst: vi.fn(
      async (args: {
        where: { ownerUserId: string };
        select: { mediaAssets: { where: { id: { in: string[] } } } };
      }): Promise<object | null> => ({
        textContent: 'Original content',
        mediaAssets: memoryFiles.filter((m) =>
          args.select.mediaAssets.where.id.in.includes(m.id),
        ),
      }),
    ),
    update: vi.fn(),
    updateMany: vi.fn(),
  };
  const memoryVaultMediaAsset = { update: vi.fn(), updateMany: vi.fn() };
  const message = { create: vi.fn().mockResolvedValue({ id: 'm' }) };
  const mediaAsset = {
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    update: vi.fn(
      async ({
        where,
      }: {
        where: { id: string };
        data: { status: string; providerFileId: string | null };
      }) => ({
        id: where.id,
        storageKey: 'k',
        storageProvider: 'IMAGEKIT',
        providerFileId: null,
        createdAt: new Date(),
      }),
    ),
  };
  const messages = {
    assertOwnedRecipients: vi.fn().mockResolvedValue(undefined),
    findOwnedById: vi.fn(async (_o: string, id: string) => ({ id })),
  };
  // Phase 12C: within quota unless a test says otherwise.
  const quota = { reserve: vi.fn().mockResolvedValue(undefined) };
  const cleanup = {
    purge: vi.fn().mockResolvedValue({ purged: 1, failed: 0 }),
  };
  const db = { memoryVaultItem, memoryVaultMediaAsset, message, mediaAsset };
  const $transaction = vi.fn((fn: (tx: typeof db) => unknown) => fn(db));
  const prisma = { ...db, $transaction } as unknown as PrismaService;
  // The real snapshot service (Phase 14B shares it with My Story).
  const snapshot = new MessageSnapshotService(
    prisma,
    storage as unknown as MediaStorage,
    scanner as unknown as MalwareScanner,
    cleanup as unknown as MediaCleanup,
    messages as unknown as MessagesService,
    quota as unknown as StorageQuota,
    { get: () => undefined } as unknown as ConfigService,
  );
  const service = new MemoryToMessageService(prisma, snapshot);
  const created = () => message.create.mock.calls.at(-1)![0].data;
  const onlyPhotoOnMemory = () => (memoryFiles = [photo]);
  return {
    quota,
    $transaction,
    onlyPhotoOnMemory,
    storage,
    scanner,
    memoryVaultItem,
    memoryVaultMediaAsset,
    message,
    mediaAsset,
    messages,
    cleanup,
    service,
    created,
  };
};

const dto = (over: Partial<CreateMessageFromMemoryDto> = {}) =>
  ({
    title: 'For Sofia',
    contentType: 'MIXED',
    includeText: true,
    mediaAssetIds: [PHOTO_ID, AUDIO_ID],
    recipientIds: [R1],
    ...over,
  }) as CreateMessageFromMemoryDto;

describe('CreateMessageFromMemoryDto', () => {
  const errorsFor = async (body: object) =>
    (
      await validate(plainToInstance(CreateMessageFromMemoryDto, body), {
        whitelist: true,
        forbidNonWhitelisted: true,
      })
    ).map((e) => e.property);
  const ok = {
    title: 'x',
    contentType: 'TEXT',
    includeText: true,
    mediaAssetIds: [],
    recipientIds: [R1],
  };

  it('accepts an explicit request', async () => {
    expect(await errorsFor(ok)).toEqual([]);
  });

  it.each([
    ['contentType', { contentType: undefined }],
    ['contentType', { contentType: 'STORY' }],
    ['includeText', { includeText: undefined }],
    ['includeText', { includeText: 'yes' }],
    ['mediaAssetIds', { mediaAssetIds: undefined }],
    ['mediaAssetIds', { mediaAssetIds: ['not-a-uuid'] }],
    ['mediaAssetIds', { mediaAssetIds: [PHOTO_ID, PHOTO_ID.toUpperCase()] }],
    ['recipientIds', { recipientIds: [] }],
    ['title', { title: '  ' }],
    ['memoryVaultItemId', { memoryVaultItemId: 'x' }],
    ['ownerUserId', { ownerUserId: 'x' }],
  ])('rejects %s in %o', async (field, patch) => {
    expect(await errorsFor({ ...ok, ...patch })).toContain(field);
  });
});

describe('MemoryToMessageService', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('creates a DRAFT snapshot: explicit type, copied text, own recipients, new media rows at message paths', async () => {
    const t = setup();
    const res = await t.service.createMessage(OWNER, 'v1', dto());
    expect(t.memoryVaultItem.findFirst.mock.calls[0][0].where).toEqual({
      id: 'v1',
      ownerUserId: OWNER,
      deletedAt: null,
    });
    expect(
      t.memoryVaultItem.findFirst.mock.calls[0][0].select.mediaAssets.where,
    ).toEqual({
      id: { in: [PHOTO_ID, AUDIO_ID] },
      deletedAt: null,
      status: 'READY',
    });
    expect(t.messages.assertOwnedRecipients).toHaveBeenCalledWith(OWNER, [R1]);
    const data = t.created();
    expect(data).toMatchObject({
      ownerUserId: OWNER,
      title: 'For Sofia',
      contentType: 'MIXED',
      textContent: 'Original content',
      status: 'DRAFT',
      recipients: { create: [{ recipientId: R1 }] },
    });
    const rows = data.mediaAssets.create;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ kind: 'PHOTO', ownerUserId: OWNER });
    expect(rows[0].storageKey).toBe(
      `/for-after/users/${OWNER}/messages/${data.id}/photo/${rows[0].id}.jpg`,
    );
    expect(rows[1].storageKey).toMatch(/\/messages\/.+\/audio\/.+\.mp3$/);
    // New ids, never the memory's rows.
    expect(rows.map((r: { id: string }) => r.id)).not.toContain(PHOTO_ID);
    expect(res).toEqual({ id: data.id });
  });

  it('copies each file at the provider, then checks it like an upload before READY', async () => {
    const t = setup();
    await t.service.createMessage(OWNER, 'v1', dto());
    const rows = t.created().mediaAssets.create;
    expect(t.storage.copyObject).toHaveBeenCalledTimes(2);
    expect(t.storage.copyObject.mock.calls[0][0]).toMatchObject({
      storageKey: photoKey,
      providerFileId: `src-${PHOTO_ID}`,
    });
    expect(t.storage.copyObject.mock.calls[0][1]).toBe(rows[0].storageKey);
    // Provider check, magic bytes and malware scan all ran on the copy.
    expect(t.storage.verifyUpload).toHaveBeenCalledWith(
      rows[0].storageKey,
      expect.any(String),
    );
    expect(t.scanner.scan).toHaveBeenCalledTimes(2);
    const [first] = t.mediaAsset.updateMany.mock.calls.map((c) => c[0]);
    expect(first.where).toEqual({
      id: rows[0].id,
      status: 'PENDING_UPLOAD',
      deletedAt: null,
    });
    expect(first.data.status).toBe('READY');
    // Two provider files: the source and an independent copy.
    expect(first.data.providerFileId).not.toBe(`src-${PHOTO_ID}`);
    expect([...t.storage.files.values()].map((f) => f.key)).toEqual(
      expect.arrayContaining([photoKey, audioKey, rows[0].storageKey]),
    );
  });

  it('never changes the memory or its media', async () => {
    const t = setup();
    await t.service.createMessage(OWNER, 'v1', dto());
    expect(t.memoryVaultItem.update).not.toHaveBeenCalled();
    expect(t.memoryVaultItem.updateMany).not.toHaveBeenCalled();
    expect(t.memoryVaultMediaAsset.update).not.toHaveBeenCalled();
    expect(t.memoryVaultMediaAsset.updateMany).not.toHaveBeenCalled();
    expect(t.storage.deleteObject).not.toHaveBeenCalled();
  });

  const cases: [
    string,
    Partial<CreateMessageFromMemoryDto>,
    number,
    string | null,
  ][] = [
    [
      'TEXT, text only',
      { contentType: 'TEXT', mediaAssetIds: [] },
      0,
      'Original content',
    ],
    [
      'PHOTO, photo only',
      { contentType: 'PHOTO', includeText: false, mediaAssetIds: [PHOTO_ID] },
      1,
      null,
    ],
    [
      'AUDIO, audio only',
      { contentType: 'AUDIO', includeText: false, mediaAssetIds: [AUDIO_ID] },
      1,
      null,
    ],
    [
      'MIXED, text + photo',
      { mediaAssetIds: [PHOTO_ID] },
      1,
      'Original content',
    ],
    [
      'MIXED, text + audio',
      { mediaAssetIds: [AUDIO_ID] },
      1,
      'Original content',
    ],
    ['MIXED, photo + audio', { includeText: false }, 2, null],
  ];
  it.each(cases)('%s', async (_, over, files, text) => {
    const t = setup();
    await t.service.createMessage(OWNER, 'v1', dto(over));
    const data = t.created();
    expect(data.contentType).toBe(over.contentType ?? 'MIXED');
    expect(data.textContent).toBe(text);
    expect(data.mediaAssets.create).toHaveLength(files);
  });

  it('missing, deleted or another Customer’s memory → 404, nothing created', async () => {
    const t = setup();
    t.memoryVaultItem.findFirst.mockResolvedValueOnce(null);
    await expect(
      t.service.createMessage('owner-b', 'v1', dto()),
    ).rejects.toThrow(NotFoundException);
    expect(t.memoryVaultItem.findFirst.mock.calls[0][0].where.ownerUserId).toBe(
      'owner-b',
    );
    expect(t.message.create).not.toHaveBeenCalled();
    expect(t.storage.copyObject).not.toHaveBeenCalled();
  });

  it('a file not READY on this memory (other memory, other Customer, deleted) → 400, nothing created', async () => {
    const t = setup();
    // Only the photo is this memory's live READY file.
    t.onlyPhotoOnMemory();
    await expect(t.service.createMessage(OWNER, 'v1', dto())).rejects.toThrow(
      INVALID_MEMORY_MEDIA,
    );
    expect(t.message.create).not.toHaveBeenCalled();
    expect(t.storage.copyObject).not.toHaveBeenCalled();
  });

  it('invalid recipients → the Message system’s own 400, nothing created', async () => {
    const t = setup();
    t.messages.assertOwnedRecipients.mockRejectedValue(new Error('invalid'));
    await expect(t.service.createMessage(OWNER, 'v1', dto())).rejects.toThrow(
      'invalid',
    );
    expect(t.message.create).not.toHaveBeenCalled();
  });

  it('a provider copy failure leaves a safe DRAFT: that copy FAILED and cleaned up, the rest continue', async () => {
    const t = setup();
    t.storage.copyObject.mockRejectedValueOnce(new Error('provider down'));
    await t.service.createMessage(OWNER, 'v1', dto());
    const rows = t.created().mediaAssets.create;
    expect(t.mediaAsset.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: rows[0].id },
        data: { status: 'FAILED', providerFileId: null },
      }),
    );
    // Purge is given the copy's row (never the source); an id-less copy is
    // looked up at its own path by the reconciler later.
    expect(t.cleanup.purge).toHaveBeenCalledWith('mediaAsset', [
      expect.objectContaining({ id: rows[0].id }),
    ]);
    // The audio still copied and became READY.
    expect(t.mediaAsset.updateMany).toHaveBeenCalledTimes(1);
    expect(t.created().status).toBe('DRAFT');
  });

  it('an infected copy is FAILED and removed, never READY', async () => {
    const t = setup();
    t.storage.files.get(`src-${photoKey}`)!.bytes = new Uint8Array([
      ...fileStart('image/jpeg'),
      ...Buffer.from(FAKE_MALWARE),
    ]);
    await t.service.createMessage(
      OWNER,
      'v1',
      dto({ mediaAssetIds: [PHOTO_ID] }),
    );
    expect(t.mediaAsset.updateMany).not.toHaveBeenCalled();
    expect(t.mediaAsset.update.mock.calls[0][0].data.status).toBe('FAILED');
    expect(t.mediaAsset.update.mock.calls[0][0].data.providerFileId).toEqual(
      expect.any(String),
    );
    expect(t.cleanup.purge).toHaveBeenCalledTimes(1);
  });

  it('message deleted while copying: the copy is FAILED and removed, not READY', async () => {
    const t = setup();
    t.mediaAsset.updateMany.mockResolvedValue({ count: 0 });
    await t.service.createMessage(
      OWNER,
      'v1',
      dto({ mediaAssetIds: [PHOTO_ID] }),
    );
    expect(t.mediaAsset.update.mock.calls[0][0].data.status).toBe('FAILED');
    expect(t.cleanup.purge).toHaveBeenCalledTimes(1);
  });

  it('copies reserve quota in the same transaction as the draft (sum of the chosen files)', async () => {
    const t = setup();
    await t.service.createMessage(OWNER, 'v1', dto());
    expect(t.quota.reserve).toHaveBeenCalledWith(expect.anything(), OWNER, 12);
    expect(t.quota.reserve.mock.invocationCallOrder[0]).toBeLessThan(
      t.message.create.mock.invocationCallOrder[0],
    );
    // Text only: no new storage, no reservation.
    await t.service.createMessage(
      OWNER,
      'v1',
      dto({ contentType: 'TEXT', mediaAssetIds: [] }),
    );
    expect(t.quota.reserve).toHaveBeenCalledTimes(1);
  });

  it('over quota → 409, no draft and no copy', async () => {
    const t = setup();
    t.quota.reserve.mockRejectedValue(new Error('full'));
    await expect(t.service.createMessage(OWNER, 'v1', dto())).rejects.toThrow(
      'full',
    );
    expect(t.message.create).not.toHaveBeenCalled();
    expect(t.storage.copyObject).not.toHaveBeenCalled();
  });

  it('the same memory can make several independent messages', async () => {
    const t = setup();
    await t.service.createMessage(OWNER, 'v1', dto());
    await t.service.createMessage(OWNER, 'v1', dto());
    const [a, b] = t.message.create.mock.calls.map((c) => c[0].data);
    expect(a.id).not.toBe(b.id);
    expect(a.mediaAssets.create[0].storageKey).not.toBe(
      b.mediaAssets.create[0].storageKey,
    );
    expect(t.storage.copyObject).toHaveBeenCalledTimes(4);
  });
});
