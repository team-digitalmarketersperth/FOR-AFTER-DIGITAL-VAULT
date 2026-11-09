import { Logger } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants.js';
import { AdminAiController } from '../admin/admin.controller.js';
import { AdminAiService, summarise } from '../admin/admin-ai.service.js';
import { AdminGuard } from '../auth/guards/admin.guard.js';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard.js';
import type { RedisService } from '../redis/redis.service.js';
import { AssistantMetrics, bucketKey, RETENTION_HOURS } from './assistant-metrics.js';
import type { AssistantService } from './assistant.service.js';

const HOUR = 3_600_000;
// One in-memory "Redis" shared by several recorders = several API replicas.
const sharedRedis = () => {
  const hashes = new Map<string, Map<string, string>>();
  const strings = new Map<string, string>();
  const ttl = new Map<string, number>();
  const h = (k: string) => hashes.get(k) ?? hashes.set(k, new Map()).get(k)!;
  const state = { fail: false };
  const client = {
    multi() {
      const q: (() => unknown)[] = [];
      const chain = {
        hIncrBy: (k: string, f: string, n: number) => (q.push(() => h(k).set(f, String(Number(h(k).get(f) ?? 0) + n))), chain),
        expire: (k: string, s: number) => (q.push(() => ttl.set(k, s)), chain),
        set: (k: string, v: string, o?: { NX?: boolean }) => (q.push(() => (o?.NX && strings.has(k) ? null : strings.set(k, v))), chain),
        hSet: (k: string, f: string, v: string) => (q.push(() => h(k).set(f, v)), chain),
        hGetAll: (k: string) => (q.push(() => Object.fromEntries(hashes.get(k) ?? [])), chain),
        get: (k: string) => (q.push(() => strings.get(k) ?? null), chain),
        exec: async () => {
          if (state.fail) throw new Error('redis down');
          return q.map((f) => f());
        },
      };
      return chain;
    },
  };
  return { redis: { client } as unknown as RedisService, hashes, ttl, state };
};

const NOW = Date.UTC(2026, 9, 31, 12, 30);

describe('AssistantMetrics (shared hourly buckets)', () => {
  it('replicas write into the same hour bucket; the reader sums them; retention is set', async () => {
    const { redis, ttl } = sharedRedis();
    const a = new AssistantMetrics(redis);
    const b = new AssistantMetrics(redis);
    await a.request('messages', 'draft', 'reply', 1200, NOW);
    await b.request('messages', 'draft', 'reply', 800, NOW);
    await b.request('dashboard', 'ask', 'timeout', 25_000, NOW);
    await a.attempt('messages', 'draft', 'provider_5xx', 300, false, undefined, NOW);
    await a.attempt('messages', 'draft', 'ok', 900, true, { input: 30, output: 12, total: 42 }, NOW);
    await b.attempt('messages', 'draft', 'ok', 700, false, { total: 10 }, NOW); // incomplete usage: unknown
    expect(ttl.get(bucketKey(NOW))).toBe(RETENTION_HOURS * 3600);

    const read = await new AssistantMetrics(redis).read(24, NOW);
    const s = summarise(read.buckets);
    expect(s.requests).toMatchObject({ total: 3, replySamples: 2, replyMeanMs: 1000 });
    expect(s.requests.byOutcome).toMatchObject({ reply: 2, timeout: 1, provider_failure: 0 });
    // Weighted over all requests, not a mean of per-instance means.
    expect(s.requests.meanMs).toBe(Math.round((1200 + 800 + 25_000) / 3));
    expect(s.attempts).toMatchObject({ total: 3, retries: 1, meanMs: Math.round((300 + 900 + 700) / 3) });
    expect(s.tokens).toEqual({ reportedAttempts: 1, unknownAttempts: 2, input: 30, output: 12, total: 42 });
    expect(read.lastReplyAt?.getTime()).toBe(NOW);
    expect(read.lastProviderFailureAt?.getTime()).toBe(NOW);
    expect(read.collectingSince?.getTime()).toBe(NOW);
    // Page/action filters.
    expect(summarise(read.buckets, 'dashboard').requests.total).toBe(1);
    expect(summarise(read.buckets, undefined, 'draft').attempts.total).toBe(3);
  });

  it('window: whole hourly buckets back from the current (partial) one; older buckets are not read', async () => {
    const { redis } = sharedRedis();
    const m = new AssistantMetrics(redis);
    await m.request('dashboard', 'ask', 'reply', 1, NOW - 23 * HOUR); // inside 24 h
    await m.request('dashboard', 'ask', 'reply', 1, NOW - 25 * HOUR); // outside 24 h, inside 7 d
    const day = await m.read(24, NOW);
    expect(day.buckets).toHaveLength(24);
    expect(day.from.getTime()).toBe(Date.UTC(2026, 9, 30, 13, 0)); // start of the oldest whole bucket
    expect(summarise(day.buckets).requests.total).toBe(1);
    const week = await m.read(168, NOW);
    expect(week.buckets).toHaveLength(168);
    expect(summarise(week.buckets).requests.total).toBe(2);
  });

  it('unknown or malformed fields are ignored, never shown', () => {
    const s = summarise([
      { 'r:dashboard:ask:reply': '2', 'r:admin:ask:reply': '5', 'r:dashboard:ask:<script>': '1', 'x:anything': '9', 'r:dashboard:ask:timeout': 'NaN' },
    ]);
    expect(s.requests.total).toBe(2);
    expect(JSON.stringify(s)).not.toMatch(/admin|script|anything/);
  });

  it('a Redis failure never throws from the recorder, and is logged once per failure spell', async () => {
    const { redis, state } = sharedRedis();
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const m = new AssistantMetrics(redis);
    state.fail = true;
    await expect(m.request('dashboard', 'ask', 'reply', 1, NOW)).resolves.toBeUndefined();
    await expect(m.attempt('dashboard', 'ask', 'ok', 1, false, undefined, NOW)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toBe('assistant_metrics_failed (Error)');
    warn.mockRestore();
  });

  it('admin read: monitoring unavailable is reported as such (never zeros); settings never carry the key', async () => {
    const { redis, state } = sharedRedis();
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const settings = { configured: true, provider: 'Groq', model: 'm', perUserHour: 30, globalAttemptsPerMinute: 20, maxConcurrent: 3, budgetMs: 25_000, maxAttempts: 2, maxCompletionTokens: 700 };
    const service = new AdminAiService({ settings } as unknown as AssistantService, new AssistantMetrics(redis));
    const fetch = vi.spyOn(globalThis, 'fetch');
    state.fail = true;
    const down = await service.operations({}, NOW);
    expect(down).toEqual({ evaluatedAt: new Date(NOW).toISOString(), window: '24h', filters: { area: null, action: null }, configuration: settings, monitoring: 'unavailable' });
    state.fail = false;
    const up = await service.operations({ window: '7d' }, NOW);
    expect(up).toMatchObject({ monitoring: 'available', window: '7d', requests: { total: 0 }, collectingSince: null });
    // Reading never calls the provider.
    expect(fetch).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('admin route: admin role + MFA guards', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, AdminAiController)).toEqual([SessionAuthGuard, AdminGuard]);
  });
});
