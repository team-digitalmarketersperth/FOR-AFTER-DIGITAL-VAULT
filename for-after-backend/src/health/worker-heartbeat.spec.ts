import { MODULE_METADATA } from '@nestjs/common/constants.js';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { AppModule } from '../app.module.js';
import type { MessageReleaseQueue } from '../message-release/message-release-queue.service.js';
import { QueueWorkersModule, WorkerModule } from '../worker.module.js';
import {
  heartbeatKey,
  heartbeatSettings,
  readHeartbeats,
  WorkerHeartbeat,
} from './worker-heartbeat.js';

const config = (env: Record<string, string> = {}) => new ConfigService(env);
const S = heartbeatSettings(config()); // 15 s beat, 45 s stale, 300 s retention
const NOW = 1_800_000_000_000;

/** One shared in-memory Redis hash per test, like BullMQ's adapter (hset/hgetall/hdel). */
function fakeRedis() {
  const store = new Map<string, Map<string, string>>();
  const hash = (k: string) => store.get(k) ?? store.set(k, new Map()).get(k)!;
  const client = {
    hset: vi.fn(async (k: string, data: Record<string, string | number>) => {
      for (const [f, v] of Object.entries(data)) hash(k).set(f, String(v));
      return 1;
    }),
    hgetall: vi.fn(async (k: string) => Object.fromEntries(hash(k))),
    hdel: vi.fn(async (k: string, ...fs: string[]) => fs.filter((f) => hash(k).delete(f)).length),
  };
  const queue = (name = 'message-release') =>
    ({ queue: { name, backend: { client: Promise.resolve(client) } } }) as unknown as MessageReleaseQueue;
  return { client, queue, entries: (name = 'message-release') => Object.fromEntries(hash(heartbeatKey(name))) };
}

describe('heartbeat settings', () => {
  it('defaults and derived thresholds; bad values stop startup', () => {
    expect(S).toEqual({ intervalMs: 15_000, staleMs: 45_000, retainMs: 300_000 });
    expect(heartbeatSettings(config({ WORKER_HEARTBEAT_INTERVAL_SECONDS: '5' })).staleMs).toBe(15_000);
    for (const bad of ['0', '-1', '1.5', 'soon']) {
      expect(() => heartbeatSettings(config({ WORKER_HEARTBEAT_INTERVAL_SECONDS: bad }))).toThrow(
        'WORKER_HEARTBEAT_INTERVAL_SECONDS must be a positive whole number.',
      );
    }
  });

  it('the key never contains anything but the queue name', () => {
    expect(heartbeatKey('test-release-1')).toBe('for_after:test-release-1:worker-heartbeats');
  });
});

describe('readHeartbeats', () => {
  it('fresh, stale, missing and expired observations', () => {
    expect(readHeartbeats({}, NOW, S)).toEqual({ reporting: 0, lastSeenAt: null });
    expect(readHeartbeats({ a: String(NOW - 1_000), b: String(NOW - 10_000) }, NOW, S)).toEqual({
      reporting: 2,
      lastSeenAt: new Date(NOW - 1_000),
    });
    // Older than 45 s: stale, still the last seen.
    expect(readHeartbeats({ a: String(NOW - 60_000) }, NOW, S)).toEqual({ reporting: 0, lastSeenAt: new Date(NOW - 60_000) });
    // Older than the retention, or garbage: ignored.
    expect(readHeartbeats({ a: String(NOW - 400_000), b: 'nonsense' }, NOW, S)).toEqual({ reporting: 0, lastSeenAt: null });
  });
});

describe('WorkerHeartbeat', () => {
  afterEach(() => vi.useRealTimers());

  it('each worker writes only its own opaque id; two never overwrite each other', async () => {
    const redis = fakeRedis();
    const a = new WorkerHeartbeat(redis.queue(), config());
    const b = new WorkerHeartbeat(redis.queue(), config());
    await a.beat(NOW);
    await b.beat(NOW + 5);
    expect(a.id).not.toBe(b.id);
    expect(a.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(redis.entries()).toEqual({ [a.id]: String(NOW), [b.id]: String(NOW + 5) });
  });

  it('prunes only workers silent past the retention (bounded registry)', async () => {
    const redis = fakeRedis();
    await redis.client.hset(heartbeatKey('message-release'), { gone: NOW - 301_000, quiet: NOW - 60_000 });
    const w = new WorkerHeartbeat(redis.queue(), config());
    await w.beat(NOW);
    expect(Object.keys(redis.entries()).sort()).toEqual([w.id, 'quiet'].sort());
  });

  it('a failing Redis never throws; logged once, then once on recovery', async () => {
    const redis = fakeRedis();
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    redis.client.hset.mockRejectedValue(Object.assign(new Error('down'), { code: 'ECONNREFUSED' }));
    const w = new WorkerHeartbeat(redis.queue(), config());
    await expect(w.beat(NOW)).resolves.toBeUndefined();
    await w.beat(NOW + 1);
    await w.beat(NOW + 2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).not.toMatch(/down|redis:\/\//);
    redis.client.hset.mockReset().mockResolvedValue(1);
    await w.beat(NOW + 3);
    expect(log).toHaveBeenCalledWith('worker_heartbeat_recovered');
    warn.mockRestore();
    log.mockRestore();
  });

  it('beats on bootstrap and every interval without any job; shutdown stops it and removes its entry', async () => {
    vi.useFakeTimers();
    const redis = fakeRedis();
    const w = new WorkerHeartbeat(redis.queue(), config());
    w.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(0);
    expect(redis.client.hset).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(redis.client.hset).toHaveBeenCalledTimes(3);
    await w.onModuleDestroy();
    expect(redis.entries()).toEqual({});
    await vi.advanceTimersByTimeAsync(60_000);
    expect(redis.client.hset).toHaveBeenCalledTimes(3);
  });

  it('shutdown cleanup is capped at 1 s when Redis hangs', async () => {
    vi.useFakeTimers();
    const redis = fakeRedis();
    redis.client.hdel.mockImplementation(() => new Promise(() => undefined));
    const w = new WorkerHeartbeat(redis.queue(), config());
    const done = vi.fn();
    void w.onModuleDestroy().then(done);
    await vi.advanceTimersByTimeAsync(999);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toHaveBeenCalled();
  });

  it('only the worker process publishes it (WorkerModule, not QueueWorkersModule or the API)', () => {
    const providers = (m: object) => (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, m) ?? []) as unknown[];
    expect(providers(WorkerModule)).toContain(WorkerHeartbeat);
    expect(providers(QueueWorkersModule)).not.toContain(WorkerHeartbeat);
    expect(providers(AppModule)).not.toContain(WorkerHeartbeat);
  });
});
