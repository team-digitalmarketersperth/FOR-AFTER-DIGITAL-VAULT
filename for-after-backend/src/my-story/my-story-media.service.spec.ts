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
import { MyStoryMediaService } from './my-story-media.service.js';
import {
  getPromptByKey,
  type MyStoryPrompt,
  PROMPT_NOT_FOUND,
} from './my-story.prompts.js';
import { RESPONSE_NOT_FOUND } from './my-story.service.js';
import {
  INVALID_STORY_MEDIA,
  StoryToMessageService,
} from './story-to-message.service.js';

const OWNER = 'owner-a';
const prompt = getPromptByKey('travel.journey')!;
const KEY = `/for-after/users/${OWNER}/my-story/r1/photo/a1.jpg`;
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
  const myStoryResponse = {
    // Default: a live answer exists.
    findUnique: vi.fn().mockResolvedValue({ id: 'r1', deletedAt: null }),
    upsert: vi.fn().mockResolvedValue({ id: 'r1' }),
  };
  const myStoryMediaAsset = {
    create: vi.fn().mockResolvedValue({ id: 'a1' }),
    findFirst: vi.fn().mockResolvedValue(pendingRow),
    findMany: vi.fn().mockResolvedValue([]),
    update: vi.fn().mockResolvedValue({ ...pendingRow, status: 'READY' }),
  };
  const tx = { myStoryResponse, myStoryMediaAsset };
  const $transaction = vi.fn((fn: (t: typeof tx) => unknown) => fn(tx));
  const quota = { reserve: vi.fn().mockResolvedValue(undefined) };
  const cleanup = {
    purge: vi.fn().mockResolvedValue({ purged: 1, failed: 0 }),
  };
  const service = new MyStoryMediaService(
    { ...tx, $transaction } as unknown as PrismaService,
    storage as unknown as MediaStorage,
    scanner as unknown as MalwareScanner,
    cleanup as unknown as MediaCleanup,
    quota as unknown as StorageQuota,
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
    myStoryResponse,
    myStoryMediaAsset,
    quota,
    cleanup,
    service,
    uploaded,
  };
};

describe('MyStoryMediaService (Phase 14B)', () => {
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
        const { data } = t.myStoryMediaAsset.create.mock.calls[0][0];
        expect(data.storageKey).toBe(
          `/for-after/users/${OWNER}/my-story/r1/${kind.toLowerCase()}/${res.mediaAssetId}.${ext}`,
        );
        expect(data).toMatchObject({
          ownerUserId: OWNER,
          myStoryResponseId: 'r1',
          kind,
        });
        expect(t.quota.reserve.mock.invocationCallOrder[0]).toBeLessThan(
          t.myStoryMediaAsset.create.mock.invocationCallOrder[0],
        );
        expect(t.storage.createUpload).toHaveBeenCalledTimes(1);
      },
    );

    it('no live answer yet → an empty private shell with the current wording', async () => {
      const t = setup();
      t.myStoryResponse.findUnique.mockResolvedValue(null);
      await t.service.createUploadUrl(OWNER, prompt, {
        kind: 'PHOTO',
        mimeType: 'image/jpeg',
        originalFileName: 'a.jpg',
        sizeBytes: 10,
      });
      const args = t.myStoryResponse.upsert.mock.calls[0][0];
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
      expect(t.myStoryMediaAsset.create).not.toHaveBeenCalled();
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
      expect(t.myStoryMediaAsset.create).not.toHaveBeenCalled();
    });

    it('a retired prompt with no live answer takes no uploads', async () => {
      const t = setup();
      t.myStoryResponse.findUnique.mockResolvedValue(null);
      const retired: MyStoryPrompt = {
        ...prompt,
        key: 'travel.old',
        retired: true,
      };
      await expect(
        t.service.createUploadUrl(OWNER, retired, {
          kind: 'PHOTO',
          mimeType: 'image/jpeg',
          originalFileName: 'a.jpg',
          sizeBytes: 10,
        }),
      ).rejects.toThrow(PROMPT_NOT_FOUND);
    });
  });

  describe('complete (provider check → magic bytes → malware scan → READY)', () => {
    it.each([
      ['PHOTO', 'image/jpeg'],
      ['AUDIO', 'audio/mpeg'],
      ['VIDEO', 'video/webm'],
    ])('clean %s → READY, owner-scoped', async (kind, mime) => {
      const t = setup();
      t.myStoryMediaAsset.findFirst.mockResolvedValue({
        ...pendingRow,
        kind,
        mimeType: mime,
        sizeBytes: fileStart(mime).length,
      });
      const fileId = t.uploaded(fileStart(mime), mime);
      await t.service.complete(OWNER, prompt, 'a1', fileId);
      expect(t.myStoryMediaAsset.findFirst.mock.calls[0][0].where).toEqual({
        id: 'a1',
        ownerUserId: OWNER,
        deletedAt: null,
        myStoryResponse: {
          ownerUserId: OWNER,
          promptKey: prompt.key,
          deletedAt: null,
        },
      });
      expect(t.scanner.scan).toHaveBeenCalledTimes(1);
      expect(t.myStoryMediaAsset.update.mock.calls[0][0].data.status).toBe(
        'READY',
      );
    });

    it('bytes that are not what they claim → FAILED, never scanned, file removed', async () => {
      const t = setup();
      t.myStoryMediaAsset.update.mockResolvedValue(ref);
      const fileId = t.uploaded(new TextEncoder().encode('<html>'));
      await expect(
        t.service.complete(OWNER, prompt, 'a1', fileId),
      ).rejects.toThrow(UPLOAD_MISMATCH);
      expect(t.scanner.scan).not.toHaveBeenCalled();
      expect(t.myStoryMediaAsset.update.mock.calls[0][0].data.status).toBe(
        'FAILED',
      );
      expect(t.cleanup.purge).toHaveBeenCalledWith('myStoryMediaAsset', [ref]);
    });

    it('infected → FAILED for good, generic 400, file removed', async () => {
      const t = setup();
      t.myStoryMediaAsset.update.mockResolvedValue(ref);
      const bytes = new Uint8Array([
        ...fileStart('image/jpeg'),
        ...Buffer.from(FAKE_MALWARE),
      ]);
      t.myStoryMediaAsset.findFirst.mockResolvedValue({
        ...pendingRow,
        sizeBytes: bytes.length,
      });
      const fileId = t.uploaded(bytes);
      await expect(
        t.service.complete(OWNER, prompt, 'a1', fileId),
      ).rejects.toThrow(UPLOAD_REJECTED);
      expect(t.myStoryMediaAsset.update.mock.calls[0][0].data.status).toBe(
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
      expect(t.myStoryMediaAsset.update).not.toHaveBeenCalled();
    });

    it('another Customer’s or a deleted file → 404, no provider call', async () => {
      const t = setup();
      t.myStoryMediaAsset.findFirst.mockResolvedValue(null);
      await expect(
        t.service.complete('owner-b', prompt, 'a1', 'file1'),
      ).rejects.toThrow(NotFoundException);
      expect(t.storage.verifyUpload).not.toHaveBeenCalled();
    });
  });

  it('signed access: READY only, owner-scoped; never for pending/FAILED', async () => {
    const t = setup();
    t.myStoryMediaAsset.findFirst.mockResolvedValue({
      ...ref,
      status: 'READY',
    });
    const { url } = await t.service.createAccessUrl(OWNER, prompt, 'a1');
    expect(url).toMatch(/^https:\/\/media\.test\/signed/);
    for (const status of ['PENDING_UPLOAD', 'FAILED']) {
      t.myStoryMediaAsset.findFirst.mockResolvedValue({ ...ref, status });
      await expect(
        t.service.createAccessUrl(OWNER, prompt, 'a1'),
      ).rejects.toThrow(NOT_READY);
    }
    t.myStoryMediaAsset.findFirst.mockResolvedValue(null);
    await expect(
      t.service.createAccessUrl('owner-b', prompt, 'a1'),
    ).rejects.toThrow(NotFoundException);
    expect(t.storage.createAccessUrl).toHaveBeenCalledTimes(1);
  });

  it('list: only this answer’s live files, owner-scoped (none → [])', async () => {
    const t = setup();
    expect(await t.service.findAll(OWNER, prompt)).toEqual([]);
    expect(t.myStoryMediaAsset.findMany.mock.calls[0][0].where).toEqual({
      ownerUserId: OWNER,
      deletedAt: null,
      myStoryResponse: {
        ownerUserId: OWNER,
        promptKey: prompt.key,
        deletedAt: null,
      },
    });
  });

  it('delete: soft delete first, then the provider file through MediaCleanup; unknown → 404', async () => {
    const t = setup();
    t.myStoryMediaAsset.update.mockResolvedValue(ref);
    await t.service.remove(OWNER, prompt, 'a1');
    expect(t.myStoryMediaAsset.update.mock.calls[0][0].data).toEqual({
      deletedAt: expect.any(Date),
    });
    expect(t.cleanup.purge).toHaveBeenCalledWith('myStoryMediaAsset', [ref]);
  });
});

describe('StoryToMessageService (Phase 14B)', () => {
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
    storageKey: `/for-after/users/${OWNER}/my-story/r1/x/${id}`,
    storageProvider: 'IMAGEKIT',
    providerFileId: `src-${id}`,
    createdAt: new Date(),
  });
  const setup2 = (
    files = [source(MEDIA[0], 'PHOTO'), source(MEDIA[1], 'VIDEO')],
  ) => {
    const myStoryResponse = {
      findFirst: vi.fn(
        async (args: {
          where: object;
          select: { mediaAssets: { where: { id: { in: string[] } } } };
        }): Promise<object | null> => ({
          textContent: 'My first trip was by train.',
          mediaAssets: files.filter((f) =>
            args.select.mediaAssets.where.id.in.includes(f.id),
          ),
        }),
      ),
    };
    const snapshot = { create: vi.fn(async () => ({ id: 'm1' })) };
    const service = new StoryToMessageService(
      { myStoryResponse } as unknown as PrismaService,
      snapshot as unknown as MessageSnapshotService,
    );
    return { myStoryResponse, snapshot, service };
  };
  const dto = (over: object = {}) => ({
    title: 'For Sofia',
    contentType: 'MIXED' as const,
    includeText: true,
    mediaAssetIds: MEDIA,
    recipientIds: ['r-sofia'],
    ...over,
  });

  it('copies the chosen text and files, in the picked order, never the linked memories', async () => {
    const t = setup2();
    await t.service.createMessage(
      OWNER,
      prompt,
      dto({ mediaAssetIds: [MEDIA[1], MEDIA[0]] }),
    );
    expect(t.myStoryResponse.findFirst.mock.calls[0][0].where).toEqual({
      ownerUserId: OWNER,
      promptKey: prompt.key,
      deletedAt: null,
    });
    const select = t.myStoryResponse.findFirst.mock.calls[0][0]
      .select as Record<string, unknown>;
    expect(select).not.toHaveProperty('memoryLinks');
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
      textContent: 'My first trip was by train.',
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

  it('missing, deleted or another Customer’s answer → 404, nothing created', async () => {
    const t = setup2();
    t.myStoryResponse.findFirst.mockResolvedValueOnce(null);
    await expect(
      t.service.createMessage('owner-b', prompt, dto()),
    ).rejects.toThrow(RESPONSE_NOT_FOUND);
    expect(t.snapshot.create).not.toHaveBeenCalled();
  });

  it('a file not READY on this answer (another answer’s, another Customer’s) → 400, nothing created', async () => {
    const t = setup2([source(MEDIA[0], 'PHOTO')]);
    await expect(t.service.createMessage(OWNER, prompt, dto())).rejects.toThrow(
      INVALID_STORY_MEDIA,
    );
    expect(t.snapshot.create).not.toHaveBeenCalled();
  });

  it('the same answer can make several messages', async () => {
    const t = setup2();
    await t.service.createMessage(OWNER, prompt, dto());
    await t.service.createMessage(OWNER, prompt, dto({ title: 'For Tom' }));
    expect(t.snapshot.create).toHaveBeenCalledTimes(2);
  });
});
