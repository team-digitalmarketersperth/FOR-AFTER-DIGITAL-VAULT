import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { positiveInt } from '../media/media.service.js';
import { MessageReleaseQueue } from '../message-release/message-release-queue.service.js';
import { errorCode } from '../prisma/prisma.service.js';

/**
 * Worker liveness for admin System Health (docs/admin.md §19). One Redis hash
 * in queue Redis: field = an opaque random id per worker process, value = its
 * last beat (epoch ms). Ids and times only. Keyed by the release queue's name,
 * so test runs (own queue names) never mix with real workers. Uses BullMQ's
 * own connection through its documented Redis escape hatch (backend.client);
 * its adapter offers hashes, not sorted sets or EXPIRE, hence the pruning.
 */
export const heartbeatSettings = (config: ConfigService) => {
  const intervalMs = positiveInt(config, 'WORKER_HEARTBEAT_INTERVAL_SECONDS', 15) * 1000;
  return {
    intervalMs,
    // Three missed beats.
    staleMs: intervalMs * 3,
    // A silent worker is listed as "last seen" this long, then pruned by any live worker.
    retainMs: intervalMs * 20,
  };
};
export const heartbeatKey = (queueName: string) => `for_after:${queueName}:worker-heartbeats`;

/** Settles with `work` or rejects after `ms`; the timer never holds the process open. */
export const within = <T>(work: Promise<T>, ms: number): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), ms);
      timer.unref();
    }),
  ]).finally(() => clearTimeout(timer));
};

export type HeartbeatReading = { reporting: number; lastSeenAt: Date | null };

/**
 * Read side (API): one HGETALL of a hash bounded to workers seen within the
 * retention (live workers prune it). Read-only; entries past the retention are
 * ignored here rather than deleted.
 */
export const readHeartbeats = (
  entries: Record<string, string>,
  now: number,
  settings: Pick<ReturnType<typeof heartbeatSettings>, 'staleMs' | 'retainMs'>,
): HeartbeatReading => {
  const seen = Object.values(entries)
    .map(Number)
    .filter((t) => Number.isFinite(t) && t > now - settings.retainMs);
  return {
    reporting: seen.filter((t) => t > now - settings.staleMs).length,
    lastSeenAt: seen.length ? new Date(Math.max(...seen)) : null,
  };
};

/**
 * Publishes this worker's heartbeat. Provided only by WorkerModule (the worker
 * process), started after every module has initialised (the BullMQ consumers
 * exist by then), stopped first on shutdown. No job is needed to beat. A failed
 * beat is logged once (and once on recovery) and never touches job processing.
 */
@Injectable()
export class WorkerHeartbeat implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(WorkerHeartbeat.name);
  readonly id = randomUUID();
  private readonly settings: ReturnType<typeof heartbeatSettings>;
  private timer?: NodeJS.Timeout;
  private failing = false;

  constructor(
    private readonly releases: MessageReleaseQueue,
    config: ConfigService,
  ) {
    this.settings = heartbeatSettings(config);
  }

  private get key() {
    return heartbeatKey(this.releases.queue.name);
  }

  onApplicationBootstrap() {
    void this.beat();
    this.timer = setInterval(() => void this.beat(), this.settings.intervalMs);
    this.timer.unref();
  }

  async beat(now = Date.now()): Promise<void> {
    try {
      await within(
        (async () => {
          const client = await this.releases.queue.backend.client;
          await client.hset(this.key, { [this.id]: now });
          // Bounded cleanup: drop workers silent for longer than the retention.
          const old = Object.entries(await client.hgetall(this.key))
            .filter(([, t]) => !(Number(t) > now - this.settings.retainMs))
            .map(([id]) => id);
          if (old.length) await client.hdel(this.key, ...old);
        })(),
        this.settings.intervalMs,
      );
      if (this.failing) this.logger.log('worker_heartbeat_recovered');
      this.failing = false;
    } catch (err) {
      if (!this.failing) this.logger.warn(`worker_heartbeat_failed (code: ${errorCode(err)})`);
      this.failing = true;
    }
  }

  /** Stop beating; best-effort removal, capped at 1 s so shutdown never waits on Redis. */
  async onModuleDestroy() {
    clearInterval(this.timer);
    this.timer = undefined;
    try {
      await within(
        (async () => {
          const client = await this.releases.queue.backend.client;
          await client.hdel(this.key, this.id);
        })(),
        1000,
      );
    } catch {
      // It ages out after the stale threshold anyway.
    }
  }
}
