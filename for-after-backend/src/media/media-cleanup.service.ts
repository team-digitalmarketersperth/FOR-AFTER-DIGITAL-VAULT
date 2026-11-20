import {
  ConflictException,
  GoneException,
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
import { MEDIA_TABLES, type MediaTable } from './media-tables.js';
import {
  MediaStorage,
  MediaStorageThrottled,
  type StoredRef,
} from './storage/media-storage.service.js';

export type { MediaTable } from './media-tables.js';

/**
 * What a purge needs of a row. `status` and `deletedAt` are optional: without
 * them a settled purge always checks the path too (the safe default).
 */
type PurgeRow = StoredRef & {
  id: string;
  createdAt: Date;
  status?: MediaAssetStatus;
  deletedAt?: Date | null;
};

/** Select for rows handed to `purge` after a delete (lets it skip a needless path lookup). */
export const cleanupRefSelect = {
  id: true,
  storageKey: true,
  storageProvider: true,
  providerFileId: true,
  createdAt: true,
  status: true,
  deletedAt: true,
} as const;

// The media tables share these columns; one narrow view of each delegate.
type Delegate = {
  findMany(args: object): Promise<PurgeRow[]>;
  updateMany(args: object): Promise<{ count: number }>;
};

const MINUTE = 60 * 1000;
// ponytail: fixed allowances; make them config if real uploads or scans ever take longer.
// An upload that started before its token expired may still be arriving: a
// 100 MB video on a slow connection takes well under an hour.
export const UPLOAD_IN_FLIGHT_MS = 60 * MINUTE;
// Provider check + first bytes + database work around a scan, beyond its own timeout.
export const SCAN_MARGIN_MS = 10 * MINUTE;
// How long after its upload URL was issued a PENDING_UPLOAD may still be
// confirmed (`complete`): the upload itself ends within settleMs (the browser
// aborts at UPLOAD_IN_FLIGHT_MS), the rest covers a tab that was backgrounded
// or frozen between the upload finishing and its confirmation. Product value:
// the stale-upload bound in force before 2026-11-10. Until then the row
// reserves its declared size; the browser removes a failed upload at once.
export const COMPLETION_WINDOW_MS = 24 * 60 * MINUTE;
const BATCH = 100;

export const UPLOAD_EXPIRED =
  'This upload expired before it was confirmed. Please upload the file again.';
export const NOT_READY = 'Media is not ready.';

/** deferred = left for a later run without an error (not settled yet, or skipped after the provider throttled). */
export type PurgeResult = { purged: number; failed: number; deferred: number };

/**
 * Removes stored files once their rows are soft-deleted or FAILED. PostgreSQL
 * is authoritative: rows become inaccessible first, then `purge` deletes the
 * provider file best effort. Anything left (provider down) is retried by
 * `reconcile`, which also retires abandoned PENDING_UPLOAD rows.
 *
 * Upload lifecycle (times from the row's createdAt = upload URL issued):
 * - settleMs (token TTL + UPLOAD_IN_FLIGHT_MS): a signed token can still put
 *   a file at the row's path (once, never overwriting) until it expires and
 *   an upload already in flight finishes. Before that a purge deletes the
 *   known file but leaves the row unmarked; afterwards it also checks the
 *   path when a re-upload was possible (the path was freed before settling),
 *   so a file re-uploaded with the old token is removed before
 *   storageDeletedAt is set.
 * - completionWindowMs (COMPLETION_WINDOW_MS): `complete` may start a
 *   verification until then (claimScan); later it gets 410 UPLOAD_EXPIRED.
 * - + scanLeaseMs: a verification started in the window holds the row this
 *   long; only then may `reconcile` retire the row (soft delete) and purge it.
 *
 * Only ImageKit files are ever deleted automatically. A legacy B2 file is
 * deleted only by its owner's own delete request, never by the reconciler.
 */
@Injectable()
export class MediaCleanup implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(MediaCleanup.name);
  private readonly uploadTtlMs: number;
  /** After this, no file can appear at a row's path any more. */
  readonly settleMs: number;
  /** How long a started verification + scan may hold a PENDING_UPLOAD row. */
  readonly scanLeaseMs: number;
  /** After this, `complete` is refused (410) and the row may be retired. */
  readonly completionWindowMs: number;
  private readonly intervalMs: number;
  private timer?: NodeJS.Timeout;
  private running?: Promise<PurgeResult>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: MediaStorage,
    config: ConfigService,
  ) {
    this.uploadTtlMs =
      Number(config.get('MEDIA_UPLOAD_URL_TTL_SECONDS') ?? 600) * 1000;
    this.settleMs = this.uploadTtlMs + UPLOAD_IN_FLIGHT_MS;
    // Same key and default as mediaSettings() (not imported: media.service imports this file).
    this.scanLeaseMs =
      Number(config.get('MEDIA_MALWARE_SCAN_TIMEOUT_MS') ?? 120_000) +
      SCAN_MARGIN_MS;
    this.completionWindowMs = Math.max(COMPLETION_WINDOW_MS, this.settleMs);
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
   * Starts verification of an upload: claims the PENDING_UPLOAD row for one
   * scan by touching updatedAt, so `reconcile` never retires it mid-scan.
   * Throws 410 once the completion window has passed. False when the row is
   * no longer a live pending upload (completed, failed, deleted or retired
   * meanwhile): the caller must not scan it.
   */
  async claimScan(
    table: MediaTable,
    id: string,
    createdAt: Date,
    now = new Date(),
  ) {
    const openSince = new Date(now.getTime() - this.completionWindowMs);
    if (createdAt <= openSince) throw new GoneException(UPLOAD_EXPIRED);
    const { count } = await this.table(table).updateMany({
      where: {
        id,
        status: MediaAssetStatus.PENDING_UPLOAD,
        deletedAt: null,
        createdAt: { gt: openSince },
      },
      data: { updatedAt: now },
    });
    return count === 1;
  }

  /** claimScan for the complete() routes: 410 when expired, 409 when not claimable. */
  async claimScanOrThrow(table: MediaTable, id: string, createdAt: Date) {
    if (!(await this.claimScan(table, id, createdAt))) {
      throw new ConflictException(NOT_READY);
    }
  }

  /**
   * A re-upload with a row's old token needs its path free while the token
   * is still usable. Ruled out when the known file was removed only once the
   * path had settled: a READY row deleted after settleMs (the file stayed at
   * the path until then). Unknown status or deletion time counts as possible.
   */
  private mayHoldReupload(row: PurgeRow) {
    return !(
      row.providerFileId &&
      row.status === MediaAssetStatus.READY &&
      row.deletedAt &&
      row.deletedAt.getTime() - row.createdAt.getTime() >= this.settleMs
    );
  }

  /**
   * Deletes each row's file, best effort. A legacy B2 row, or an ImageKit row
   * whose path has settled, is then marked storage-deleted; an unsettled
   * ImageKit row only has its known file deleted and stays unmarked
   * (`deferred`) for reconcile. Missing files count as deleted. A failure is
   * logged by id only and retried; after a throttled call the rest of the
   * batch waits for the next run (`deferred`).
   */
  async purge(
    table: MediaTable,
    rows: PurgeRow[],
    now = new Date(),
  ): Promise<PurgeResult> {
    const result: PurgeResult = { purged: 0, failed: 0, deferred: 0 };
    for (const [i, row] of rows.entries()) {
      const imageKit = row.storageProvider === MediaStorageProvider.IMAGEKIT;
      const settled = now.getTime() - row.createdAt.getTime() >= this.settleMs;
      try {
        if (!imageKit) {
          await this.storage.deleteObject(row);
        } else {
          // The known file goes at once (privacy); a lookup by path waits for
          // settling, as the list API lags behind uploads by a few seconds.
          if (row.providerFileId) await this.storage.deleteObject(row);
          if (!settled) {
            result.deferred++;
            continue;
          }
          // Whatever is at the path now: the original if it had no id, or a
          // re-upload made with the old token after the known file was deleted.
          if (!row.providerFileId || this.mayHoldReupload(row)) {
            await this.storage.deleteObject({ ...row, providerFileId: null });
          }
        }
        await this.table(table).updateMany({
          where: { id: row.id, storageDeletedAt: null },
          data: { storageDeletedAt: now },
        });
        result.purged++;
      } catch (err) {
        result.failed++;
        this.logger.warn(`Media ${row.id} file cleanup failed; will retry`);
        if (err instanceof MediaStorageThrottled) {
          result.deferred += rows.length - i - 1;
          break;
        }
      }
    }
    return result;
  }

  // One run at a time per instance; a call during a run joins it.
  reconcile(now = new Date()) {
    this.running ??= this.run(now).finally(() => (this.running = undefined));
    return this.running;
  }

  private async run(now: Date): Promise<PurgeResult> {
    const total: PurgeResult = { purged: 0, failed: 0, deferred: 0 };
    const ago = (ms: number) => new Date(now.getTime() - ms);
    for (const name of MEDIA_TABLES) {
      try {
        // Abandoned uploads become inaccessible first, like any delete: past
        // the completion window (claimScan refuses new verifications) and no
        // verification started within the last scan lease still holds it.
        await this.table(name).updateMany({
          where: {
            status: MediaAssetStatus.PENDING_UPLOAD,
            deletedAt: null,
            createdAt: { lte: ago(this.completionWindowMs) },
            updatedAt: { lt: ago(this.scanLeaseMs) },
          },
          data: { deletedAt: now },
        });
        // Settled rows only (earlier ones were purged by id when deleted).
        // Bounded: the next run continues where this one stopped.
        const rows = await this.table(name).findMany({
          where: {
            storageProvider: MediaStorageProvider.IMAGEKIT,
            storageDeletedAt: null,
            createdAt: { lt: ago(this.settleMs) },
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
            status: true,
            deletedAt: true,
          },
          orderBy: { createdAt: 'asc' },
          take: BATCH,
        });
        const result = await this.purge(name, rows, now);
        total.purged += result.purged;
        total.failed += result.failed;
        total.deferred += result.deferred;
      } catch {
        this.logger.error(`media_cleanup_error (${name})`);
      }
    }
    return total;
  }
}
