// Phase 24 load harness: one delivery-worker process. Boots the compiled
// production composition root (dist/worker.module.js, what `npm run
// worker:prod` runs) with exactly one change: the real
// MicrosoftGraphEmailProvider gets a fixed fake token (no Entra ID call) and
// posts to the harness's fake Graph endpoint (P24_FAKE_PROVIDER_URL) instead of
// graph.microsoft.com. Every email (release notifications, safety notices, ops
// alerts) goes through EmailProvider, so nothing can leave the machine.
// Graph requests carry no kind or idempotency key, so the harness adds them
// as x-p24-* headers for its own accounting (test-only).
//
// Started by scripts/load/delivery-load.mjs; refuses to run otherwise.
// Graceful stop: IPC message 'shutdown' (Windows has no SIGTERM for child
// processes) → app.close(), the same path enableShutdownHooks takes.
import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Test } = require('@nestjs/testing');
const { WorkerModule } = await import('../../dist/worker.module.js');
const { EmailProvider } = await import('../../dist/email/email-provider.js');
const { MicrosoftGraphEmailProvider } = await import(
  '../../dist/email/microsoft-email-provider.js'
);

const fakeUrl = process.env.P24_FAKE_PROVIDER_URL;
const workerId = process.env.P24_WORKER_ID;
if (process.env.P24_ISOLATED !== '1' || !fakeUrl || !workerId)
  throw new Error('worker-entry: start through scripts/load/delivery-load.mjs');
if (!/^http:\/\/127\.0\.0\.1:\d+\/v1\.0\/users\/[^/]+\/sendMail$/.test(fakeUrl))
  throw new Error('worker-entry: the fake provider must be local');

const sending = new AsyncLocalStorage();
class HarnessGraphProvider extends MicrosoftGraphEmailProvider {
  send(message) {
    return sending.run({ kind: message.kind, key: message.idempotencyKey ?? '' }, () => super.send(message));
  }
}
const provider = new HarnessGraphProvider(
  { acquireTokenByClientCredential: async () => ({ accessToken: 'p24-fake-graph-token' }) },
  'notifications@example.test',
  { name: 'For After', address: 'notifications@example.test' },
  Number(process.env.EMAIL_SEND_TIMEOUT_MS ?? 10_000),
  (_url, init) => {
    const { kind, key } = sending.getStore() ?? {};
    return fetch(fakeUrl, {
      ...init,
      headers: { ...init.headers, 'x-p24-worker': workerId, 'x-p24-kind': kind ?? '', 'x-p24-key': key ?? '' },
    });
  },
);

const ref = await Test.createTestingModule({ imports: [WorkerModule] })
  .overrideProvider(EmailProvider)
  .useValue(provider)
  .compile();
// What src/worker.ts boots: an application context, no HTTP server.
const app = await ref.init();

const send = (msg) => process.send?.(msg);
send({ type: 'ready', workerId, pid: process.pid });

// Resource samples for the report (CPU ms since start, RSS MB).
const started = process.cpuUsage();
const sample = setInterval(() => {
  const cpu = process.cpuUsage(started);
  send({
    type: 'sample',
    workerId,
    at: Date.now(),
    cpuMs: Math.round((cpu.user + cpu.system) / 1000),
    rssMb: Math.round(process.memoryUsage().rss / 1048576),
  });
}, 1000);
sample.unref();

process.on('message', async (msg) => {
  if (msg?.type !== 'shutdown') return;
  const t0 = Date.now();
  await app.close();
  send({ type: 'stopped', workerId, closeMs: Date.now() - t0 });
  process.exit(0);
});
// The parent died: stop rather than linger.
process.on('disconnect', () => process.exit(0));
