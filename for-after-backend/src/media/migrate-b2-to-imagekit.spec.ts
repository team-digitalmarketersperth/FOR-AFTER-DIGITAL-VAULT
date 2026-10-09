import { Logger } from '@nestjs/common';
import { FakeMalwareScanner } from '../../test/fake-malware-scanner.js';
import { FakeMediaStorage, fileStart } from '../../test/fake-media-storage.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import {
  migrateB2ToImageKit,
  type MigrationIo,
} from './migrate-b2-to-imagekit.js';
import type { MalwareScanner } from './scanner/malware-scanner.service.js';
import type { MediaStorage } from './storage/media-storage.service.js';

const photo = {
  id: 'p1',
  ownerUserId: 'u1',
  messageId: 'm1',
  kind: 'PHOTO',
  storageKey: 'users/u1/messages/m1/p1.jpg',
  mimeType: 'image/jpeg',
  sizeBytes: 6,
  originalFileName: 'a.jpg',
};
const voice = {
  id: 'r1',
  ownerUserId: 'u1',
  recipientId: 'x1',
  kind: 'PHOTO',
  storageKey: 'users/u1/recipients/x1/photo/r1.png',
  mimeType: 'image/png',
  sizeBytes: 10,
  originalFileName: 'b.png',
};

const setup = () => {
  const table = (rows: object[]) => ({
    findMany: vi.fn().mockResolvedValue(rows),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
  });
  const prisma = {
    mediaAsset: table([photo]),
    memoryVaultMediaAsset: table([]),
    recipientPhoto: table([voice]),
  };
  const storage = new FakeMediaStorage();
  const scanner = new FakeMalwareScanner();
  // B2 bytes per legacy key (the fake's access URL carries no key, so the
  // download looks at the last requested ref).
  const b2 = new Map<string, Uint8Array>([
    [photo.storageKey, fileStart('image/jpeg')],
    [voice.storageKey, fileStart('image/png')],
  ]);
  let lastRef = '';
  storage.createAccessUrl.mockImplementation(async (ref) => {
    lastRef = ref.storageKey;
    return 'https://b2.test/signed';
  });
  const download = vi.fn(async () => b2.get(lastRef)!);
  const io: MigrationIo = {
    download,
    upload: vi.fn(async (target, file) =>
      storage.upload(target, {
        sizeBytes: file.bytes.length,
        contentType: file.mimeType,
        bytes: file.bytes,
      }),
    ),
  };
  const run = (apply: boolean) =>
    migrateB2ToImageKit(
      prisma as unknown as PrismaService,
      storage as unknown as MediaStorage,
      scanner as unknown as MalwareScanner,
      1000,
      apply,
      io,
      new Logger('test'),
    );
  return { prisma, storage, scanner, download, run, b2 };
};

describe('migrateB2ToImageKit', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('dry run: lists candidates (live READY B2 rows only) and changes nothing', async () => {
    const { prisma, storage, download, run } = setup();
    expect(await run(false)).toEqual({ candidates: 2, migrated: 0, failed: 0 });
    expect(prisma.mediaAsset.findMany).toHaveBeenCalledWith({
      where: { storageProvider: 'B2', status: 'READY', deletedAt: null },
    });
    expect(download).not.toHaveBeenCalled();
    expect(storage.createUpload).not.toHaveBeenCalled();
    expect(prisma.mediaAsset.updateMany).not.toHaveBeenCalled();
  });

  it('apply: copies, verifies, then switches each row to its new ImageKit path; B2 is never deleted', async () => {
    const { prisma, storage, run } = setup();
    expect(await run(true)).toEqual({ candidates: 2, migrated: 2, failed: 0 });
    expect(prisma.mediaAsset.updateMany).toHaveBeenCalledWith({
      where: { id: 'p1', storageProvider: 'B2' },
      data: {
        storageKey: '/for-after/users/u1/messages/m1/photo/p1.jpg',
        storageProvider: 'IMAGEKIT',
        providerFileId: expect.any(String),
      },
    });
    expect(
      prisma.recipientPhoto.updateMany.mock.calls[0][0].data.storageKey,
    ).toBe('/for-after/users/u1/recipients/x1/photo/r1.png');
    // Only ImageKit paths are ever deleted (clearing a crashed earlier attempt).
    for (const [ref] of storage.deleteObject.mock.calls) {
      expect(ref.storageProvider).toBe('IMAGEKIT');
    }
    expect(storage.files.size).toBe(2);
  });

  it('a failed copy (size differs, or bytes not of their type) leaves the row on B2', async () => {
    const { prisma, b2, storage, run } = setup();
    b2.set(photo.storageKey, new Uint8Array(3)); // wrong size
    b2.set(voice.storageKey, new TextEncoder().encode('<html>....')); // 10 bytes, not a PNG
    expect(await run(true)).toEqual({ candidates: 2, migrated: 0, failed: 2 });
    expect(prisma.mediaAsset.updateMany).not.toHaveBeenCalled();
    expect(prisma.recipientPhoto.updateMany).not.toHaveBeenCalled();
    expect(storage.files.size).toBe(0); // the unverified copy is removed
  });

  it('every copy is malware-scanned; an infected one stays on B2 and its copy is removed', async () => {
    const { prisma, storage, scanner, run } = setup();
    scanner.scan.mockResolvedValueOnce('INFECTED');
    expect(await run(true)).toEqual({ candidates: 2, migrated: 1, failed: 1 });
    expect(scanner.scan).toHaveBeenCalledTimes(2);
    expect(prisma.mediaAsset.updateMany).not.toHaveBeenCalled();
    expect(storage.files.size).toBe(1); // only the clean Recipient photo
  });

  it('a row changed meanwhile is not overwritten and its copy is removed', async () => {
    const { prisma, storage, run } = setup();
    prisma.mediaAsset.updateMany.mockResolvedValue({ count: 0 });
    expect((await run(true)).failed).toBe(1);
    expect(storage.files.size).toBe(1); // only the Recipient photo's copy
  });
});
