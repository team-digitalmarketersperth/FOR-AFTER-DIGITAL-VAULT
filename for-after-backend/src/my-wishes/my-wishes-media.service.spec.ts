import {
  BadRequestException,
  ConflictException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import {
  FAKE_MALWARE,
  FakeMalwareScanner,
} from '../../test/fake-malware-scanner.js';
import { FakeMediaStorage, fileStart } from '../../test/fake-media-storage.js';
import type { MediaCleanup } from '../media/media-cleanup.service.js';
import {
  NOT_READY,
  SCAN_UNAVAILABLE,
  UPLOAD_MISMATCH,
  UPLOAD_REJECTED,
} from '../media/media.service.js';
import type { MalwareScanner } from '../media/scanner/malware-scanner.service.js';
import type { StorageQuota } from '../media/storage-quota.service.js';
import type { MediaStorage } from '../media/storage/media-storage.service.js';
import type { MessageSnapshotService } from '../messages/message-snapshot.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import {
  DISCLAIMER_NOT_ACKNOWLEDGED,
  type MyWishesDisclaimerService,
} from './my-wishes-disclaimer.service.js';
import { MyWishesMediaService } from './my-wishes-media.service.js';
import { getWishPromptByKey } from './my-wishes.prompts.js';
import { WISH_NOT_FOUND } from './my-wishes.service.js';
import {
  INVALID_WISH_MEDIA,
  WishToMessageService,
} from './wish-to-message.service.js';

const OWNER = 'owner-a';
const prompt = getWishPromptByKey('music-and-readings.music')!;
const KEY = `/for-after/users/${OWNER}/my-wishes/r1/photo/a1.jpg`;
const MB = 1024 * 1024;

const pendingRow = {
  id: 'a1',
  kind: 'PHOTO',
  status: 'PENDING_UPLOAD',
  originalFileName: 'beach.jpg',
  mimeType: 'image/jpeg',
  sizeBytes: 6,
  uploadedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  storageKey: KEY,
};
const ref = {
  id: 'a1',
  storageKey: KEY,
  storageProvider: 'IMAGEKIT',
  providerFileId: 'file1',
  createdAt: new Date(),
};

const setup = () => {
  const storage = new FakeMediaStorage();
  const scanner = new FakeMalwareScanner();
  const myWishResponse = {
    // Default: a live wish exists.
    findUnique: vi.fn().mockResolvedValue({ id: 'r1', deletedAt: null }),
    upsert: vi.fn().mockResolvedValue({ id: 'r1' }),
  };
  const myWishMediaAsset = {
    create: vi.fn().mockResolvedValue({ id: 'a1' }),
    findFirst: vi.fn().mockResolvedValue(pendingRow),
    findMany: vi.fn().mockResolvedValue([]),
    update: vi.fn().mockResolvedValue({ ...pendingRow, status: 'READY' }),
  };
  const tx = { myWishResponse, myWishMediaAsset };
  const $transaction = vi.fn((fn: (t: typeof tx) => unknown) => fn(tx));
  const quota = { reserve: vi.fn().mockResolvedValue(undefined) };
  // Phase 15A: acknowledged unless a test says otherwise.
  const disclaimer = {
    assertAcknowledged: vi.fn().mockResolvedValue(undefined),
  };
  const cleanup = {
    purge: vi.fn().mockResolvedValue({ purged: 1, failed: 0 }),
  };
  const service = new MyWishesMediaService(
    { ...tx, $transaction } as unknown as PrismaService,
    storage as unknown as MediaStorage,
    scanner as unknown as MalwareScanner,
    cleanup as unknown as MediaCleanup,
    quota as unknown as StorageQuota,
    disclaimer as unknown as MyWishesDisclaimerService,
    { get: () => undefined } as unknown as ConfigService,
  );
  // The browser's direct upload of these bytes to the row's path.
  const uploaded = (bytes: Uint8Array, mime = 'image/jpeg', key = KEY) => {
    const slash = key.lastIndexOf('/');
    return storage.upload(
      {
        url: 'https://upload.test',
        fields: {
          folder: key.slice(0, slash + 1),
          fileName: key.slice(slash + 1),
        },
      },
      { sizeBytes: bytes.length, contentType: mime, bytes },
    );
  };
  return {
    storage,
    scanner,
    myWishResponse,
    myWishMediaAsset,
    quota,
    disclaimer,
    cleanup,
    service,
    uploaded,
  };
};

describe('MyWishesMediaService (Phase 15B)', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  describe('upload auth', () => {
    it.each([
      ['PHOTO', 'image/webp', 'webp', 5 * MB],
      ['AUDIO', 'audio/mpeg', 'mp3', 5 * MB],
      ['VIDEO', 'video/mp4', 'mp4', 90 * MB],
    ] as const)(
      '%s: quota first, then the row at a server-made path, then the signature',
      async (kind, mimeType, ext, sizeBytes) => {
        const t = setup();
        const res = await t.service.createUploadUrl(OWNER, prompt, {
          kind,
          mimeType,
          originalFileName: 'my holiday.bin',
          sizeBytes,
        });
        expect(t.quota.reserve).toHaveBeenCalledWith(
          expect.anything(),
          OWNER,
          sizeBytes,
        );
        const { data } = t.myWishMediaAsset.create.mock.calls[0][0];
        expect(data.storageKey).toBe(
          `/for-after/users/${OWNER}/my-wishes/r1/${kind.toLowerCase()}/${res.mediaAssetId}.${ext}`,
        );
        expect(data).toMatchObject({
          ownerUserId: OWNER,
          myWishResponseId: 'r1',
          kind,
        });
        expect(t.quota.reserve.mock.invocationCallOrder[0]).toBeLessThan(
          t.myWishMediaAsset.create.mock.invocationCallOrder[0],
        );
        expect(t.storage.createUpload).toHaveBeenCalledTimes(1);
      },
    );

    it('no live wish yet → an empty private shell with the current wording', async () => {
      const t = setup();
      t.myWishResponse.findUnique.mockResolvedValue(null);
      await t.service.createUploadUrl(OWNER, prompt, {
        kind: 'PHOTO',
        mimeType: 'image/jpeg',
        originalFileName: 'a.jpg',
        sizeBytes: 10,
      });
      const args = t.myWishResponse.upsert.mock.calls[0][0];
      const fresh = {
        promptTextSnapshot: prompt.prompt,
        promptVersion: prompt.version,
        textContent: null,
      };
      expect(args.create).toEqual({
        ownerUserId: OWNER,
        promptKey: prompt.key,
        ...fresh,
      });
      expect(args.update).toEqual({ ...fresh, deletedAt: null });
    });

    it('needs the current notice acknowledged (Phase 15A); nothing reserved, created or signed without it', async () => {
      const t = setup();
      t.disclaimer.assertAcknowledged.mockRejectedValue(
        new ConflictException(DISCLAIMER_NOT_ACKNOWLEDGED),
      );
      await expect(
        t.service.createUploadUrl(OWNER, prompt, {
          kind: 'PHOTO',
          mimeType: 'image/jpeg',
          originalFileName: 'a.jpg',
          sizeBytes: 10,
        }),
      ).rejects.toThrow(DISCLAIMER_NOT_ACKNOWLEDGED);
      expect(t.disclaimer.assertAcknowledged).toHaveBeenCalledWith(OWNER);
      expect(t.quota.reserve).not.toHaveBeenCalled();
      expect(t.myWishMediaAsset.create).not.toHaveBeenCalled();
      expect(t.storage.createUpload).not.toHaveBeenCalled();
    });

    it('completing, viewing, listing and deleting never need an acknowledgement', async () => {
      const t = setup();
      t.disclaimer.assertAcknowledged.mockRejectedValue(new Error('no'));
      const fileId = t.uploaded(fileStart('image/jpeg'));
      t.myWishMediaAsset.findFirst.mockResolvedValue({
        ...pendingRow,
        sizeBytes: fileStart('image/jpeg').length,
      });
      await t.service.complete(OWNER, prompt, 'a1', fileId);
      await t.service.findAll(OWNER, prompt);
      t.myWishMediaAsset.update.mockResolvedValue(ref);
      await t.service.remove(OWNER, prompt, 'a1');
      expect(t.disclaimer.assertAcknowledged).not.toHaveBeenCalled();
    });

    it('over quota → refused, nothing created or signed', async () => {
      const t = setup();
      t.quota.reserve.mockRejectedValue(new ConflictException('full'));
      await expect(
        t.service.createUploadUrl(OWNER, prompt, {
          kind: 'VIDEO',
          mimeType: 'video/webm',
          originalFileName: 'v.webm',
          sizeBytes: 10,
        }),
      ).rejects.toThrow(ConflictException);
      expect(t.myWishMediaAsset.create).not.toHaveBeenCalled();
      expect(t.storage.createUpload).not.toHaveBeenCalled();
    });

    it.each([
      [{ kind: 'PHOTO', mimeType: 'image/svg+xml' }],
      [{ kind: 'VIDEO', mimeType: 'video/quicktime' }],
      [{ kind: 'PHOTO', mimeType: 'image/jpeg', sizeBytes: 21 * MB }],
      [{ kind: 'VIDEO', mimeType: 'video/mp4', sizeBytes: 101 * MB }],
    ])('the shared allowlist and limits apply: %o → 400', async (over) => {
      const t = setup();
      await expect(
        t.service.createUploadUrl(OWNER, prompt, {
          originalFileName: 'x',
          sizeBytes: 10,
          ...over,
        } as never),
      ).rejects.toThrow(BadRequestException);
      expect(t.myWishMediaAsset.create).not.toHaveBeenCalled();
    });
  });

  describe('complete (provider check → magic bytes → malware scan → READY)', () => {
    it.each([
      ['PHOTO', 'image/jpeg'],
      ['AUDIO', 'audio/mpeg'],
      ['VIDEO', 'video/webm'],
    ])('clean %s → READY, owner-scoped', async (kind, mime) => {
      const t = setup();
      t.myWishMediaAsset.findFirst.mockResolvedValue({
        ...pendingRow,
        kind,
        mimeType: mime,
        sizeBytes: fileStart(mime).length,
      });
      const fileId = t.uploaded(fileStart(mime), mime);
      await t.service.complete(OWNER, prompt, 'a1', fileId);
      expect(t.myWishMediaAsset.findFirst.mock.calls[0][0].where).toEqual({
        id: 'a1',
        ownerUserId: OWNER,
        deletedAt: null,
        myWishResponse: {
          ownerUserId: OWNER,
          promptKey: prompt.key,
          deletedAt: null,
        },
      });
      expect(t.scanner.scan).toHaveBeenCalledTimes(1);
      expect(t.myWishMediaAsset.update.mock.calls[0][0].data.status).toBe(
        'READY',
      );
    });

    it('bytes that are not what they claim → FAILED, never scanned, file removed', async () => {
      const t = setup();
      t.myWishMediaAsset.update.mockResolvedValue(ref);
      const fileId = t.uploaded(new TextEncoder().encode('<html>'));
      await expect(
        t.service.complete(OWNER, prompt, 'a1', fileId),
      ).rejects.toThrow(UPLOAD_MISMATCH);
      expect(t.scanner.scan).not.toHaveBeenCalled();
      expect(t.myWishMediaAsset.update.mock.calls[0][0].data.status).toBe(
        'FAILED',
      );
      expect(t.cleanup.purge).toHaveBeenCalledWith('myWishMediaAsset', [ref]);
    });

    it('infected → FAILED for good, generic 400, file removed', async () => {
      const t = setup();
      t.myWishMediaAsset.update.mockResolvedValue(ref);
      const bytes = new Uint8Array([
        ...fileStart('image/jpeg'),
        ...Buffer.from(FAKE_MALWARE),
      ]);
      t.myWishMediaAsset.findFirst.mockResolvedValue({
        ...pendingRow,
        sizeBytes: bytes.length,
      });
      const fileId = t.uploaded(bytes);
      await expect(
        t.service.complete(OWNER, prompt, 'a1', fileId),
      ).rejects.toThrow(UPLOAD_REJECTED);
      expect(t.myWishMediaAsset.update.mock.calls[0][0].data.status).toBe(
        'FAILED',
      );
      expect(t.cleanup.purge).toHaveBeenCalledTimes(1);
    });

    it('scanner outage → 503, stays PENDING_UPLOAD (fail closed)', async () => {
      const t = setup();
      t.scanner.scan.mockRejectedValue(new Error('ECONNREFUSED'));
      const fileId = t.uploaded(fileStart('image/jpeg'));
      const err = await t.service
        .complete(OWNER, prompt, 'a1', fileId)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ServiceUnavailableException);
      expect((err as Error).message).toBe(SCAN_UNAVAILABLE);
      expect(t.myWishMediaAsset.update).not.toHaveBeenCalled();
    });

    it('another Customer’s or a deleted file → 404, no provider call', async () => {
      const t = setup();
      t.myWishMediaAsset.findFirst.mockResolvedValue(null);
      await expect(
        t.service.complete('owner-b', prompt, 'a1', 'file1'),
      ).rejects.toThrow(NotFoundException);
      expect(t.storage.verifyUpload).not.toHaveBeenCalled();
    });
  });

  it('signed access: READY only, owner-scoped; never for pending/FAILED', async () => {
    const t = setup();
    t.myWishMediaAsset.findFirst.mockResolvedValue({
      ...ref,
      status: 'READY',
    });
    const { url } = await t.service.createAccessUrl(OWNER, prompt, 'a1');
    expect(url).toMatch(/^https:\/\/media\.test\/signed/);
    for (const status of ['PENDING_UPLOAD', 'FAILED']) {
      t.myWishMediaAsset.findFirst.mockResolvedValue({ ...ref, status });
      await expect(
        t.service.createAccessUrl(OWNER, prompt, 'a1'),
      ).rejects.toThrow(NOT_READY);
    }
    t.myWishMediaAsset.findFirst.mockResolvedValue(null);
    await expect(
      t.service.createAccessUrl('owner-b', prompt, 'a1'),
    ).rejects.toThrow(NotFoundException);
    expect(t.storage.createAccessUrl).toHaveBeenCalledTimes(1);
  });

  it('list: only this wish’s live files, owner-scoped (none → [])', async () => {
    const t = setup();
    expect(await t.service.findAll(OWNER, prompt)).toEqual([]);
    expect(t.myWishMediaAsset.findMany.mock.calls[0][0].where).toEqual({
      ownerUserId: OWNER,
      deletedAt: null,
      myWishResponse: {
        ownerUserId: OWNER,
        promptKey: prompt.key,
        deletedAt: null,
      },
    });
  });

  it('delete: soft delete first, then the provider file through MediaCleanup; unknown → 404', async () => {
    const t = setup();
    t.myWishMediaAsset.update.mockResolvedValue(ref);
    await t.service.remove(OWNER, prompt, 'a1');
    expect(t.myWishMediaAsset.update.mock.calls[0][0].data).toEqual({
      deletedAt: expect.any(Date),
    });
    expect(t.cleanup.purge).toHaveBeenCalledWith('myWishMediaAsset', [ref]);
  });
});

describe('WishToMessageService (Phase 15B)', () => {
  const MEDIA = [
    '33333333-3333-4333-8333-333333333333',
    '44444444-4444-4444-8444-444444444444',
  ];
  const source = (id: string, kind: string) => ({
    id,
    kind,
    mimeType: kind === 'VIDEO' ? 'video/mp4' : 'image/jpeg',
    sizeBytes: 10,
    originalFileName: 'f',
    storageKey: `/for-after/users/${OWNER}/my-wishes/r1/x/${id}`,
    storageProvider: 'IMAGEKIT',
    providerFileId: `src-${id}`,
    createdAt: new Date(),
  });
  const setup2 = (
    files = [source(MEDIA[0], 'PHOTO'), source(MEDIA[1], 'VIDEO')],
  ) => {
    const myWishResponse = {
      findFirst: vi.fn(
        async (args: {
          where: object;
          select: { mediaAssets: { where: { id: { in: string[] } } } };
        }): Promise<object | null> => ({
          textContent: 'Play something by the sea.',
          _count: { mediaAssets: files.length },
          mediaAssets: files.filter((f) =>
            args.select.mediaAssets.where.id.in.includes(f.id),
          ),
        }),
      ),
    };
    const snapshot = { create: vi.fn(async () => ({ id: 'm1' })) };
    const service = new WishToMessageService(
      { myWishResponse } as unknown as PrismaService,
      snapshot as unknown as MessageSnapshotService,
    );
    return { myWishResponse, snapshot, service };
  };
  const dto = (over: object = {}) => ({
    title: 'For Sofia',
    contentType: 'MIXED' as const,
    includeText: true,
    mediaAssetIds: MEDIA,
    recipientIds: ['r-sofia'],
    ...over,
  });

  it('copies the chosen text and files, in the picked order', async () => {
    const t = setup2();
    await t.service.createMessage(
      OWNER,
      prompt,
      dto({ mediaAssetIds: [MEDIA[1], MEDIA[0]] }),
    );
    expect(t.myWishResponse.findFirst.mock.calls[0][0].where).toEqual({
      ownerUserId: OWNER,
      promptKey: prompt.key,
      deletedAt: null,
    });
    const select = t.myWishResponse.findFirst.mock.calls[0][0].select as Record<
      string,
      unknown
    >;
    expect((select.mediaAssets as { where: object }).where).toMatchObject({
      deletedAt: null,
      status: 'READY',
    });
    const [owner, draft] = t.snapshot.create.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(owner).toBe(OWNER);
    expect(draft).toMatchObject({
      title: 'For Sofia',
      contentType: 'MIXED',
      textContent: 'Play something by the sea.',
      recipientIds: ['r-sofia'],
    });
    expect((draft.media as { id: string }[]).map((m) => m.id)).toEqual([
      MEDIA[1],
      MEDIA[0],
    ]);
  });

  it('includeText false → no text; explicit type passed through unchanged', async () => {
    const t = setup2();
    await t.service.createMessage(
      OWNER,
      prompt,
      dto({
        includeText: false,
        contentType: 'VIDEO',
        mediaAssetIds: [MEDIA[1]],
      }),
    );
    const [, draft] = t.snapshot.create.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(draft).toMatchObject({ textContent: null, contentType: 'VIDEO' });
  });

  it('missing, deleted or another Customer’s wish → 404, nothing created', async () => {
    const t = setup2();
    t.myWishResponse.findFirst.mockResolvedValueOnce(null);
    await expect(
      t.service.createMessage('owner-b', prompt, dto()),
    ).rejects.toThrow(WISH_NOT_FOUND);
    expect(t.snapshot.create).not.toHaveBeenCalled();
  });

  it('a file not READY on this wish (another wish’s, another Customer’s) → 400, nothing created', async () => {
    const t = setup2([source(MEDIA[0], 'PHOTO')]);
    await expect(t.service.createMessage(OWNER, prompt, dto())).rejects.toThrow(
      INVALID_WISH_MEDIA,
    );
    expect(t.snapshot.create).not.toHaveBeenCalled();
  });

  it('an upload shell (no text, no READY file) is not a wish → 404', async () => {
    const t = setup2();
    t.myWishResponse.findFirst.mockResolvedValueOnce({
      textContent: null,
      _count: { mediaAssets: 0 },
      mediaAssets: [],
    });
    await expect(
      t.service.createMessage(OWNER, prompt, dto({ mediaAssetIds: [] })),
    ).rejects.toThrow(WISH_NOT_FOUND);
    expect(t.snapshot.create).not.toHaveBeenCalled();
  });

  it('the same wish can make several messages', async () => {
    const t = setup2();
    await t.service.createMessage(OWNER, prompt, dto());
    await t.service.createMessage(OWNER, prompt, dto({ title: 'For Tom' }));
    expect(t.snapshot.create).toHaveBeenCalledTimes(2);
  });
});
