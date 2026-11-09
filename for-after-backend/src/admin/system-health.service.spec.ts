import { ConfigService } from '@nestjs/config';
import { GUARDS_METADATA } from '@nestjs/common/constants.js';
import { createServer, type Server, type Socket } from 'node:net';
import { AdminGuard } from '../auth/guards/admin.guard.js';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard.js';
import type { HealthService } from '../health/health.service.js';
import { heartbeatKey } from '../health/worker-heartbeat.js';
import type { MessageReleaseQueue } from '../message-release/message-release-queue.service.js';
import { AdminSystemHealthController } from './admin.controller.js';
import { CHECK_TIMEOUT_MS, SNAPSHOT_MS, SystemHealthService, timed } from './system-health.service.js';

const ok = vi.fn(async () => ({ status: 'ok' }));

/** A local stand-in for clamd on 127.0.0.1; only ever reachable from this test. */
async function fakeClamd(reply: (socket: Socket) => void) {
  const sockets: Socket[] = [];
  const server: Server = createServer((s) => {
    sockets.push(s);
    s.on('data', () => reply(s));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    sockets,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

function setup(
  env: Record<string, string>,
  over: { database?: () => Promise<unknown>; redis?: () => Promise<unknown>; hgetall?: () => Promise<unknown> } = {},
) {
  const health = { checkDatabase: vi.fn(over.database ?? ok), checkRedis: vi.fn(over.redis ?? ok) };
  const hgetall = vi.fn(over.hgetall ?? (async () => ({})));
  const releases = {
    queue: { name: 'message-release', backend: { client: Promise.resolve({ hgetall }) } },
  } as unknown as MessageReleaseQueue;
  const service = new SystemHealthService(health as unknown as HealthService, releases, new ConfigService(env));
  return { service, health, hgetall };
}

describe('timed', () => {
  afterEach(() => vi.useRealTimers());

  it('ok, failed (message never returned) and timed out at the budget', async () => {
    expect(await timed(async () => undefined)).toMatchObject({ status: 'ok', durationMs: expect.any(Number) });
    const failed = await timed(async () => {
      throw new Error('password=secret host=db.internal');
    });
    expect(failed.status).toBe('failed');
    expect(JSON.stringify(failed)).not.toMatch(/secret|internal/);
    vi.useFakeTimers();
    const pending = timed(() => new Promise(() => undefined));
    await vi.advanceTimersByTimeAsync(CHECK_TIMEOUT_MS);
    expect((await pending).status).toBe('timed_out');
  });
});

describe('SystemHealthService', () => {
  it('each check is independent: a failed Redis leaves PostgreSQL and the rest as observed', async () => {
    const { service } = setup({}, { redis: async () => Promise.reject(new Error('down')) });
    const h = await service.check();
    expect(h.api.status).toBe('ok');
    expect(h.database.status).toBe('ok');
    expect(h.redis.status).toBe('failed');
    expect(h.worker.status).toBe('missing');
  });

  it('worker: recent, stale, missing, or unknown when Redis cannot be read', async () => {
    const now = Date.now();
    const states = async (hgetall: () => Promise<unknown>) => (await setup({}, { hgetall }).service.check()).worker;
    expect(await states(async () => ({ a: String(now - 1000), b: String(now - 2000) }))).toMatchObject({
      status: 'ok',
      reportingWorkers: 2,
      staleAfterSeconds: 45,
    });
    expect(await states(async () => ({ a: String(now - 90_000) }))).toMatchObject({
      status: 'stale',
      reportingWorkers: 0,
      lastSeenAt: new Date(now - 90_000).toISOString(),
    });
    expect(await states(async () => ({}))).toMatchObject({ status: 'missing', lastSeenAt: null });
    expect(await states(async () => Promise.reject(new Error('down')))).toMatchObject({
      status: 'unknown',
      reportingWorkers: null,
      lastSeenAt: null,
    });
  });

  it('reads only the heartbeat key of its own queue', async () => {
    const { service, hgetall } = setup({});
    await service.check();
    expect(hgetall).toHaveBeenCalledWith(heartbeatKey('message-release'));
  });

  it('concurrent and repeated calls share one probe for SNAPSHOT_MS, failures included, then probe again', async () => {
    const { service, health } = setup({}, { database: async () => Promise.reject(new Error('x')) });
    const t = Date.now();
    const [a, b] = await Promise.all([service.check(t), service.check(t + 10)]);
    expect(a).toBe(b);
    await service.check(t + SNAPSHOT_MS - 1);
    expect(health.checkDatabase).toHaveBeenCalledTimes(1);
    await service.check(t + SNAPSHOT_MS);
    expect(health.checkDatabase).toHaveBeenCalledTimes(2);
  });

  it('scanner: PING to the configured host and port only; PONG = ok, anything else = failed; socket closed', async () => {
    const pong = await fakeClamd((s) => s.end('PONG\0'));
    try {
      const h = await setup({ CLAMAV_HOST: '127.0.0.1', CLAMAV_PORT: String(pong.port) }).service.check();
      expect(h.malwareScanner).toMatchObject({ status: 'ok', durationMs: expect.any(Number) });
      expect(pong.sockets).toHaveLength(1);
      await vi.waitFor(() => expect(pong.sockets[0].destroyed || pong.sockets[0].readableEnded).toBe(true));
      // Nothing about the destination leaves the API.
      expect(JSON.stringify(h)).not.toMatch(/127\.0\.0\.1|CLAMAV|for_after:|message-release/);
    } finally {
      await pong.close();
    }
    const odd = await fakeClamd((s) => s.end('stream: OK\0'));
    try {
      const h = await setup({ CLAMAV_HOST: '127.0.0.1', CLAMAV_PORT: String(odd.port) }).service.check();
      expect(h.malwareScanner.status).toBe('failed');
    } finally {
      await odd.close();
    }
  });

  it('scanner: silent clamd times out at the budget; unreachable fails; no CLAMAV_HOST is "not configured"', async () => {
    const silent = await fakeClamd(() => undefined);
    try {
      const h = await setup({ CLAMAV_HOST: '127.0.0.1', CLAMAV_PORT: String(silent.port) }).service.check();
      expect(h.malwareScanner.status).toBe('timed_out');
      // The abort destroyed our socket.
      await vi.waitFor(() => expect(silent.sockets[0]?.destroyed || silent.sockets[0]?.readableEnded).toBe(true));
    } finally {
      await silent.close();
    }
    expect((await setup({ CLAMAV_HOST: '127.0.0.1', CLAMAV_PORT: '1' }).service.check()).malwareScanner.status).toBe('failed');
    expect((await setup({}).service.check()).malwareScanner).toMatchObject({ status: 'not_configured', durationMs: null });
  }, 10_000);

  it('the endpoint needs an admin session with completed MFA', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, AdminSystemHealthController)).toEqual([SessionAuthGuard, AdminGuard]);
  });
});
