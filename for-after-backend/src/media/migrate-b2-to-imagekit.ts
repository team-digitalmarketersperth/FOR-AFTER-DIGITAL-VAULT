import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  MediaAssetStatus,
  MediaStorageProvider,
} from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { MIME_TYPES } from './dto/create-media-upload.dto.js';
import { checkUpload, mediaKey, mediaSettings } from './media.service.js';
import { ClamAvMalwareScanner } from './scanner/clamav-malware-scanner.service.js';
import { MalwareScanner } from './scanner/malware-scanner.service.js';
import { ImageKitMediaStorage } from './storage/imagekit-media-storage.service.js';
import {
  MediaStorage,
  type UploadTarget,
} from './storage/media-storage.service.js';

type Row = {
  id: string;
  ownerUserId: string;
  kind: keyof typeof MIME_TYPES;
  storageKey: string;
  mimeType: string;
  sizeBytes: number;
  originalFileName: string;
  parent: string;
};

// The three media tables: how to find their live READY B2 rows and the
// parent folder of each (same layout as new uploads).
const TABLES = {
  mediaAsset: (r: { messageId: string }) => `messages/${r.messageId}`,
  memoryVaultMediaAsset: (r: { memoryVaultItemId: string }) =>
    `memory-vault/${r.memoryVaultItemId}`,
  recipientPhoto: (r: { recipientId: string }) => `recipients/${r.recipientId}`,
} as const;
type Table = keyof typeof TABLES;
type Delegate = {
  findMany(args: object): Promise<Record<string, unknown>[]>;
  updateMany(args: object): Promise<{ count: number }>;
};

/** Network steps, injectable for tests. */
export type MigrationIo = {
  download(url: string): Promise<Uint8Array>;
  upload(
    target: UploadTarget,
    file: { bytes: Uint8Array; mimeType: string; fileName: string },
  ): Promise<string>;
};

export const fetchIo: MigrationIo = {
  async download(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  },
  // The same signed direct upload a browser makes.
  async upload(target, { bytes, mimeType, fileName }) {
    const form = new FormData();
    for (const [k, v] of Object.entries(target.fields)) form.append(k, v);
    form.append(
      'file',
      new Blob([new Uint8Array(bytes)], { type: mimeType }),
      fileName,
    );
    const res = await fetch(target.url, { method: 'POST', body: form });
    const body = (await res.json().catch(() => ({}))) as { fileId?: string };
    if (!res.ok || !body.fileId) throw new Error(`upload HTTP ${res.status}`);
    return body.fileId;
  },
};

/**
 * Explicit, idempotent copy of legacy Backblaze B2 media to ImageKit (Phase 12).
 * Dry run unless `apply`. Only live READY rows still marked B2, in all three
 * media tables. Per file: download from B2 (short-lived presigned GET), upload
 * to its new server-chosen ImageKit path, verify exactly like a browser upload
 * (path, private, size, provider type, magic bytes), and only then switch the
 * row to IMAGEKIT (conditional: still B2). The B2 object is never deleted.
 * A failure leaves the row on B2 (still readable) and is reported; rerunning
 * retries it. Never run automatically. Logs ids and counts only.
 */
export async function migrateB2ToImageKit(
  prisma: PrismaService,
  storage: MediaStorage,
  scanner: MalwareScanner,
  scanTimeoutMs: number,
  apply: boolean,
  io: MigrationIo = fetchIo,
  logger = new Logger('B2ToImageKit'),
) {
  const result = { candidates: 0, migrated: 0, failed: 0 };
  for (const table of Object.keys(TABLES) as Table[]) {
    const delegate = prisma[table] as unknown as Delegate;
    const rows = await delegate.findMany({
      where: {
        storageProvider: MediaStorageProvider.B2,
        status: MediaAssetStatus.READY,
        deletedAt: null,
      },
    });
    for (const raw of rows) {
      const row = {
        ...(raw as Omit<Row, 'parent'>),
        parent: (TABLES[table] as (r: never) => string)(raw as never),
      };
      result.candidates++;
      const ctx = `${table} ${row.id}`;
      if (!apply) {
        logger.log(`migration_candidate ${ctx}`);
        continue;
      }
      try {
        await migrateOne(delegate, storage, scanner, scanTimeoutMs, io, row);
        result.migrated++;
        logger.log(`migrated ${ctx}`);
      } catch (err) {
        result.failed++;
        logger.warn(
          `migration_failed ${ctx} (${err instanceof Error ? err.message : 'error'})`,
        );
      }
    }
  }
  logger.log(
    `migration_${apply ? 'done' : 'dry_run'} candidates ${result.candidates} migrated ${result.migrated} failed ${result.failed}`,
  );
  return result;
}

async function migrateOne(
  delegate: Delegate,
  storage: MediaStorage,
  scanner: MalwareScanner,
  scanTimeoutMs: number,
  io: MigrationIo,
  row: Row,
) {
  const types: Record<string, string> = MIME_TYPES[row.kind];
  const extension = types[row.mimeType];
  if (!extension) throw new Error('type not allowlisted');
  const newKey = mediaKey(
    row.ownerUserId,
    row.parent,
    row.kind,
    row.id,
    extension,
  );
  const legacyUrl = await storage.createAccessUrl(
    {
      storageKey: row.storageKey,
      storageProvider: MediaStorageProvider.B2,
      providerFileId: null,
    },
    300,
  );
  const bytes = await io.download(legacyUrl);
  if (bytes.length !== row.sizeBytes) throw new Error('B2 size differs');
  // A crashed earlier run may have left a file at this asset's own new path.
  await storage.deleteObject({
    storageKey: newKey,
    storageProvider: MediaStorageProvider.IMAGEKIT,
    providerFileId: null,
  });
  const target = await storage.createUpload(
    newKey,
    row.mimeType,
    bytes.length,
    600,
  );
  const fileId = await io.upload(target, {
    bytes,
    mimeType: row.mimeType,
    fileName: target.fields.fileName ?? `${row.id}.${extension}`,
  });
  // Same checks as a new upload, malware scan included: an infected legacy
  // file is never copied in (its copy is removed; the row stays on B2).
  const check = await checkUpload(
    storage,
    scanner,
    {
      id: row.id,
      storageKey: newKey,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
    },
    fileId,
    scanTimeoutMs,
  );
  if (check.status !== 'ok') {
    if (check.status !== 'missing') await storage.deleteObject(check.ref);
    throw new Error(`verification ${check.status}`);
  }
  const { count } = await delegate.updateMany({
    where: { id: row.id, storageProvider: MediaStorageProvider.B2 },
    data: {
      storageKey: newKey,
      storageProvider: MediaStorageProvider.IMAGEKIT,
      providerFileId: check.ref.providerFileId,
    },
  });
  if (!count) {
    // Changed meanwhile (deleted or already migrated): drop the copy.
    await storage.deleteObject(check.ref);
    throw new Error('row changed during migration');
  }
}

// npm run migrate:b2-to-imagekit [-- --apply]   (after npm run build)
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  if (existsSync('.env')) process.loadEnvFile();
  const config = new ConfigService();
  const prisma = new PrismaService(config);
  try {
    await migrateB2ToImageKit(
      prisma,
      new ImageKitMediaStorage(config),
      new ClamAvMalwareScanner(config),
      mediaSettings(config).scanTimeoutMs,
      process.argv.includes('--apply'),
    );
  } finally {
    await prisma.$disconnect();
  }
}
