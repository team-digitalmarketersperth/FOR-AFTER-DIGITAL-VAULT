import { ConfigService } from '@nestjs/config';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  MediaAssetStatus,
  MediaStorageProvider,
} from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { MEDIA_TABLES } from './media-tables.js';
import { ImageKitMediaStorage } from './storage/imagekit-media-storage.service.js';

/**
 * Read-only ImageKit reconciliation report: every file in the provider's
 * library compared with the media rows in PostgreSQL. It deletes, moves and
 * changes nothing, and prints ids, paths (ids only, see mediaKey) and sizes:
 * never a URL, file name, content or secret.
 */

export type ProviderFile = { fileId: string; filePath: string; size: number };
export type ListPage = (skip: number, limit: number) => Promise<ProviderFile[]>;
type RowState = {
  status: MediaAssetStatus;
  deletedAt: Date | null;
  storageDeletedAt: Date | null;
  providerFileId: string | null;
};
export type FindRows = (paths: string[]) => Promise<Map<string, RowState>>;

export type Category = 'live' | 'pending' | 'cleanup' | 'unmatched';
export type Finding = ProviderFile & { category: Category; reason: string };

export const APP_PREFIX = '/for-after/';
export const PAGE_SIZE = 1000; // ImageKit's largest list page

/** Where one provider file stands against its row (or the lack of one). */
export const classify = (file: ProviderFile, row?: RowState): Finding => {
  const at = (category: Category, reason: string) => ({ ...file, category, reason });
  if (!row) return at('unmatched', 'no media row has this path');
  if (row.deletedAt || row.status === MediaAssetStatus.FAILED) {
    return at(
      'cleanup',
      row.storageDeletedAt
        ? 'present after cleanup was confirmed (e.g. re-uploaded with an old token)'
        : 'row deleted or failed; cleanup not finished',
    );
  }
  if (row.status === MediaAssetStatus.PENDING_UPLOAD) {
    return at('pending', 'upload not verified yet');
  }
  // A live row's path holds exactly one file (uploads never overwrite).
  if (row.providerFileId && row.providerFileId !== file.fileId) {
    return at('unmatched', 'live row records a different file id');
  }
  return at('live', 'verified, in use');
};

export type Report = {
  scanned: number;
  outsideApp: number;
  counts: Record<Category, { files: number; bytes: number }>;
  /** Cleanup candidates and unmatched files only; live/pending are counted. */
  attention: Finding[];
};

/** Pages through the whole library (oldest first) and classifies each app file. */
export async function buildReport(listPage: ListPage, findRows: FindRows): Promise<Report> {
  const report: Report = {
    scanned: 0,
    outsideApp: 0,
    counts: {
      live: { files: 0, bytes: 0 },
      pending: { files: 0, bytes: 0 },
      cleanup: { files: 0, bytes: 0 },
      unmatched: { files: 0, bytes: 0 },
    },
    attention: [],
  };
  for (let skip = 0; ; skip += PAGE_SIZE) {
    const page = await listPage(skip, PAGE_SIZE);
    report.scanned += page.length;
    const ours = page.filter((f) => f.filePath.startsWith(APP_PREFIX));
    report.outsideApp += page.length - ours.length;
    const rows = ours.length ? await findRows(ours.map((f) => f.filePath)) : new Map();
    for (const file of ours) {
      const finding = classify(file, rows.get(file.filePath));
      report.counts[finding.category].files++;
      report.counts[finding.category].bytes += file.size;
      if (finding.category === 'cleanup' || finding.category === 'unmatched') {
        report.attention.push(finding);
      }
    }
    if (page.length < PAGE_SIZE) return report;
  }
}

type Delegate = {
  findMany(args: object): Promise<(RowState & { storageKey: string })[]>;
};

/** The ImageKit rows at these paths, across every media table (read-only). */
export const findRowsIn =
  (prisma: PrismaService): FindRows =>
  async (paths) => {
    const found = new Map<string, RowState>();
    for (const table of MEDIA_TABLES) {
      const rows = await (prisma[table] as unknown as Delegate).findMany({
        where: {
          storageProvider: MediaStorageProvider.IMAGEKIT,
          storageKey: { in: paths },
        },
        select: {
          storageKey: true,
          status: true,
          deletedAt: true,
          storageDeletedAt: true,
          providerFileId: true,
        },
      });
      for (const { storageKey, ...state } of rows) found.set(storageKey, state);
    }
    return found;
  };

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export const formatReport = (r: Report, limit = 200) =>
  [
    'ImageKit reconciliation (read-only; nothing was changed)',
    `Files scanned: ${r.scanned} (outside ${APP_PREFIX}: ${r.outsideApp})`,
    ...(Object.keys(r.counts) as Category[]).map(
      (c) => `  ${c.padEnd(10)} ${String(r.counts[c].files).padStart(6)} files  ${mb(r.counts[c].bytes)}`,
    ),
    ...(r.attention.length ? ['', 'Needs attention (category, file id, path, size, reason):'] : []),
    ...r.attention
      .slice(0, limit)
      .map((f) => `  ${f.category}\t${f.fileId}\t${f.filePath}\t${f.size}\t${f.reason}`),
    ...(r.attention.length > limit ? [`  … and ${r.attention.length - limit} more`] : []),
    '',
    'Note: pages are read oldest first; files deleted during the run can shift a page.',
  ].join('\n');

// npm run storage:reconcile-report   (after npm run build)
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  if (existsSync('.env')) process.loadEnvFile();
  const config = new ConfigService();
  const prisma = new PrismaService(config);
  try {
    const storage = new ImageKitMediaStorage(config);
    const report = await buildReport((skip, limit) => storage.listFiles(skip, limit), findRowsIn(prisma));
    console.log(formatReport(report));
  } finally {
    await prisma.$disconnect();
  }
}
