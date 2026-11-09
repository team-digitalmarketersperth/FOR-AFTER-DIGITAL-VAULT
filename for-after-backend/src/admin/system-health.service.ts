import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HealthService } from '../health/health.service.js';
import {
  heartbeatKey,
  heartbeatSettings,
  readHeartbeats,
  within,
} from '../health/worker-heartbeat.js';
import { ClamAvMalwareScanner } from '../media/scanner/clamav-malware-scanner.service.js';
import { MessageReleaseQueue } from '../message-release/message-release-queue.service.js';

/**
 * Admin System Health (docs/admin.md §19). Observations from THIS API instance
 * only: never the fleet. Read-only (the worker heartbeat is written by the
 * worker process, not here). Statuses and times only: no hosts, keys, errors or
 * configuration values leave the API.
 */

export const CHECK_TIMEOUT_MS = 2000;
// Coalesces probes: at most one set per window, failures included, never kept longer.
export const SNAPSHOT_MS = 5000;

export type CheckStatus = 'ok' | 'failed' | 'timed_out';
export type Check = { status: CheckStatus; checkedAt: string; durationMs: number };
// not_configured: no CLAMAV_HOST, so the adapter could not be built (the app
// normally refuses to start then; uploads stay fail-closed either way).
export type ScannerCheck = Check | { status: 'not_configured'; checkedAt: string; durationMs: null };
export type WorkerCheck = {
  /** ok = a heartbeat within the stale threshold; stale = only older ones; missing = none; unknown = Redis unreadable. */
  status: 'ok' | 'stale' | 'missing' | 'unknown';
  checkedAt: string;
  reportingWorkers: number | null;
  lastSeenAt: string | null;
  staleAfterSeconds: number;
};
export type SystemHealth = {
  checkedAt: string;
  api: { status: 'ok'; checkedAt: string };
  database: Check;
  redis: Check;
  worker: WorkerCheck;
  malwareScanner: ScannerCheck;
};

@Injectable()
export class SystemHealthService {
  private readonly heartbeat: ReturnType<typeof heartbeatSettings>;
  // The configured scanner (server-side CLAMAV_HOST/PORT only); null when absent.
  private readonly scanner: ClamAvMalwareScanner | null;
  private snapshot?: { at: number; result: Promise<SystemHealth> };

  constructor(
    private readonly health: HealthService,
    private readonly releases: MessageReleaseQueue,
    config: ConfigService,
  ) {
    this.heartbeat = heartbeatSettings(config);
    try {
      this.scanner = new ClamAvMalwareScanner(config);
    } catch {
      this.scanner = null;
    }
  }

  /** The latest snapshot if younger than SNAPSHOT_MS (concurrent callers share one probe set). */
  check(now = Date.now()): Promise<SystemHealth> {
    if (!this.snapshot || now - this.snapshot.at >= SNAPSHOT_MS) {
      this.snapshot = { at: now, result: this.probe() };
    }
    return this.snapshot.result;
  }

  private async probe(): Promise<SystemHealth> {
    const [database, redis, worker, malwareScanner] = await Promise.all([
      timed(() => this.health.checkDatabase()),
      timed(() => this.health.checkRedis()),
      this.worker(),
      this.scannerCheck(),
    ]);
    const checkedAt = new Date().toISOString();
    return { checkedAt, api: { status: 'ok', checkedAt }, database, redis, worker, malwareScanner };
  }

  private async worker(): Promise<WorkerCheck> {
    const base = { staleAfterSeconds: this.heartbeat.staleMs / 1000 };
    try {
      const entries = await within(
        (async () => {
          const client = await this.releases.queue.backend.client;
          return client.hgetall(heartbeatKey(this.releases.queue.name));
        })(),
        CHECK_TIMEOUT_MS,
      );
      const now = Date.now();
      const { reporting, lastSeenAt } = readHeartbeats(entries, now, this.heartbeat);
      return {
        ...base,
        status: reporting > 0 ? 'ok' : lastSeenAt ? 'stale' : 'missing',
        checkedAt: new Date(now).toISOString(),
        reportingWorkers: reporting,
        lastSeenAt: lastSeenAt?.toISOString() ?? null,
      };
    } catch {
      return { ...base, status: 'unknown', checkedAt: new Date().toISOString(), reportingWorkers: null, lastSeenAt: null };
    }
  }

  private scannerCheck(): Promise<ScannerCheck> {
    const scanner = this.scanner;
    if (!scanner) {
      return Promise.resolve({ status: 'not_configured', checkedAt: new Date().toISOString(), durationMs: null });
    }
    // A real cancellation: the abort destroys the socket.
    return timed(() => scanner.ping(AbortSignal.timeout(CHECK_TIMEOUT_MS)));
  }
}

/**
 * Runs one check within CHECK_TIMEOUT_MS and measures it. Any error becomes
 * 'failed' (its message is never returned); the timer becomes 'timed_out'.
 */
export async function timed(work: () => Promise<unknown>): Promise<Check> {
  const start = performance.now();
  const done = (status: CheckStatus): Check => ({
    status,
    checkedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - start),
  });
  try {
    await within(work(), CHECK_TIMEOUT_MS);
    return done('ok');
  } catch (err) {
    const aborted = err instanceof Error && (err.message === 'timeout' || err.name === 'TimeoutError' || err.name === 'AbortError');
    return done(aborted ? 'timed_out' : 'failed');
  }
}
