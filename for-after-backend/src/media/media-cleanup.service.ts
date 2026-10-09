import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  MediaAssetStatus,
  MediaStorageProvider,
} from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  MediaStorage,
  type StoredRef,
} from './storage/media-storage.service.js';

export type MediaTable =
  | 'mediaAsset'
  | 'memoryVaultMediaAsset'
  | 'recipientPhoto'
  | 'myStoryMediaAsset'
  | 'myWishMediaAsset';
const TABLES: MediaTable[] = [
  'mediaAsset',
  'memoryVaultMediaAsset',
  'recipientPhoto',
  'myStoryMediaAsset',
  'myWishMediaAsset',
];
type PurgeRow = StoredRef & { id: string; createdAt: Date };

// The media tables share these columns; one narrow view of each delegate.
type Delegate = {
  findMany(args: object): Promise<PurgeRow[]>;
  updateMany(args: object): Promise<{ count: number }>;
};

const HOUR = 3600 * 1000;
// ponytail: fixed; a PENDING_UPLOAD a day old is abandoned. Config if uploads ever take longer.
const STALE_UPLOAD_MS = 24 * HOUR;
const BATCH = 100;

/**
 * Removes stored files once their rows are soft-deleted or FAILED. PostgreSQL
 * is authoritative: rows become inaccessible first, then `purge` deletes the
 * provider file best effort and records storageDeletedAt. Anything left
 * (provider down) is retried by `reconcile`, which also retires stale
 * PENDING_UPLOAD rows and removes whatever was uploaded for them.
 *
 * Only ImageKit files are ever deleted automatically. A legacy B2 file is
 * deleted only by its owner's own delete request, never by the reconciler.
 */
@Injectable()
export class MediaCleanup implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(MediaCleanup.name);
  private readonly uploadTtlMs: number;
  private readonly intervalMs: number;
  private timer?: NodeJS.Timeout;
  private running?: Promise<{ purged: number; failed: number }>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: MediaStorage,
    config: ConfigService,
  ) {
    this.uploadTtlMs =
      Number(config.get('MEDIA_UPLOAD_URL_TTL_SECONDS') ?? 600) * 1000;
    // 0 turns the periodic run off (automated tests share the dev database).
    const seconds = Number(
      config.get('MEDIA_CLEANUP_INTERVAL_SECONDS') ?? 3600,
    );
    if (!Number.isInteger(seconds) || seconds < 0) {
      throw new Error(
        'MEDIA_CLEANUP_INTERVAL_SECONDS must be a whole number (0 = off).',
      );
    }
    this.intervalMs = seconds * 1000;
  }

  // Same pattern as the release reconciler: a timer only triggers a re-scan
  // of PostgreSQL, so a missed tick loses nothing.
  onApplicationBootstrap(): void {
    if (!this.intervalMs) return;
    void this.reconcile();
    this.timer = setInterval(() => void this.reconcile(), this.intervalMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  private table(name: MediaTable) {
    return this.prisma[name] as unknown as Delegate;
  }

  /**
   * Deletes each row's file, best effort, and marks it storage-deleted. A
   * failure is logged by id only and left for reconcile. A row with no
   * provider id is skipped while its upload token may still be in use (the
   * file could arrive after a lookup); reconcile picks it up later.
   */
  async purge(table: MediaTable, rows: PurgeRow[], now = new Date()) {
    let purged = 0;
    let failed = 0;
    for (const row of rows) {
      const tokenLive =
        row.storageProvider === MediaStorageProvider.IMAGEKIT &&
        !row.providerFileId &&
        now.getTime() - row.createdAt.getTime() < this.uploadTtlMs;
      if (tokenLive) continue;
      try {
        await this.storage.deleteObject(row);
        await this.table(table).updateMany({
          where: { id: row.id, storageDeletedAt: null },
          data: { storageDeletedAt: now },
        });
        purged++;
      } catch {
        failed++;
        this.logger.warn(`Media ${row.id} file cleanup failed; will retry`);
      }
    }
    return { purged, failed };
  }

  // One run at a time per instance; a call during a run joins it.
  reconcile(now = new Date()) {
    this.running ??= this.run(now).finally(() => (this.running = undefined));
    return this.running;
  }

  private async run(now: Date) {
    const total = { purged: 0, failed: 0 };
    for (const name of TABLES) {
      try {
        // Abandoned uploads become inaccessible first, like any delete.
        await this.table(name).updateMany({
          where: {
            status: MediaAssetStatus.PENDING_UPLOAD,
            deletedAt: null,
            createdAt: { lt: new Date(now.getTime() - STALE_UPLOAD_MS) },
          },
          data: { deletedAt: now },
        });
        // Bounded: the next run continues where this one stopped.
        const rows = await this.table(name).findMany({
          where: {
            storageProvider: MediaStorageProvider.IMAGEKIT,
            storageDeletedAt: null,
            createdAt: { lt: new Date(now.getTime() - this.uploadTtlMs) },
            OR: [
              { deletedAt: { not: null } },
              { status: MediaAssetStatus.FAILED },
            ],
          },
          select: {
            id: true,
            storageKey: true,
            storageProvider: true,
            providerFileId: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'asc' },
          take: BATCH,
        });
        const result = await this.purge(name, rows, now);
        total.purged += result.purged;
        total.failed += result.failed;
      } catch {
        this.logger.error(`media_cleanup_error (${name})`);
      }
    }
    return total;
  }
}
