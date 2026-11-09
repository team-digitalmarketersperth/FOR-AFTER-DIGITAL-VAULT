// Phase 24: delivery-worker load harness (docs/testing/phase-24-load-test.md).
//
//   node scripts/phase24/isolated-env.mjs -- node scripts/load/delivery-load.mjs --profile smoke
//
// One run = one namespace (run id): its own Customer, queues and log folder.
// The API (compiled AppModule, in this process) only produces: fixtures go
// through its real HTTP routes (register, recipients, messages, schedule).
// Delivery runs in N real worker processes (scripts/load/worker-entry.mjs →
// dist/worker.module.js) whose MicrosoftGraphEmailProvider posts to a local fake Graph
// that records every attempt and simulates latency, 5xx, 429, timeouts,
// permanent rejections and the "accepted, then the worker died" window.
// Completion is measured in PostgreSQL after the queues settle; the run fails
// (exit 1) on any unmet acceptance criterion or when its deadline passes.
import { fork } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir, cpus, totalmem } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const require = createRequire(import.meta.url);
if (process.env.P24_ISOLATED !== '1')
  throw new Error('Run through scripts/phase24/isolated-env.mjs (dedicated test PostgreSQL + Redis only).');

// ---------------------------------------------------------------- settings
// Provisional local profiles (no documented launch workload or SLO exists).
// Thresholds are acceptance criteria for *this* local harness, not capacity
// claims. Seconds unless named otherwise.
const PROFILES = {
  smoke: { messages: 100, workers: 1, deadline: 300, accept: { p95DueToRelease: 30, p95DueToSent: 60, drain: 180 } },
  burst: { messages: 1000, workers: 1, deadline: 1800, accept: { drain: 1200 } },
  'burst-2w': { messages: 1000, workers: 2, deadline: 1800, accept: { drain: 900 } },
  sustained: { rate: 3, duration: 900, workers: 2, deadline: 1500, accept: { p95DueToRelease: 30, p95DueToSent: 60, drain: 120 } },
  recovery: { messages: 300, workers: 2, gracefulAt: 0.25, killAt: 0.5, crashWindowAt: 0.1, deadline: 900, accept: { drain: 600 } },
  faults: { messages: 300, workers: 2, p500: 0.1, p429: 0.1, pTimeout: 0.03, permanentEvery: 25, deadline: 1500, accept: { drain: 1200 } },
  'dup-cancel': { messages: 300, workers: 2, duplicates: true, cancelBefore: 30, cancelWaiting: 30, startDelay: 15, reconcileSeconds: 5, deadline: 900, accept: { drain: 600 } },
};
const { values: argv } = parseArgs({
  options: {
    profile: { type: 'string', default: 'smoke' },
    messages: { type: 'string' },
    fanout: { type: 'string' },
    workers: { type: 'string' },
    rate: { type: 'string' },
    duration: { type: 'string' },
    'latency-ms': { type: 'string' },
    'jitter-ms': { type: 'string' },
    'provider-dedupe': { type: 'boolean', default: false },
    keep: { type: 'boolean', default: false },
  },
});
const base = PROFILES[argv.profile];
if (!base) throw new Error(`unknown profile ${argv.profile}: ${Object.keys(PROFILES).join(', ')}`);
const num = (v, d) => (v === undefined ? d : Number(v));
const cfg = {
  profile: argv.profile,
  messages: num(argv.messages, base.messages ?? 0),
  fanout: num(argv.fanout, base.fanout ?? 1),
  workers: num(argv.workers, base.workers),
  rate: num(argv.rate, base.rate ?? 0),
  duration: num(argv.duration, base.duration ?? 0),
  latencyMs: num(argv['latency-ms'], 80),
  jitterMs: num(argv['jitter-ms'], 40),
  providerDedupe: argv['provider-dedupe'],
  p500: base.p500 ?? 0,
  p429: base.p429 ?? 0,
  pTimeout: base.pTimeout ?? 0,
  permanentEvery: base.permanentEvery ?? 0,
  gracefulAt: base.gracefulAt,
  killAt: base.killAt,
  crashWindowAt: base.crashWindowAt,
  duplicates: !!base.duplicates,
  cancelBefore: base.cancelBefore ?? 0,
  cancelWaiting: base.cancelWaiting ?? 0,
  startDelay: base.startDelay ?? 0,
  reconcileSeconds: base.reconcileSeconds ?? 60,
  deadline: base.deadline,
  accept: base.accept,
  // Production defaults (email-provider.ts / release-notification-queue.service.ts).
  emailTimeoutMs: 10_000,
};
const sustained = cfg.rate > 0;

const run = `${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${randomUUID().slice(0, 6)}`;
const runDir = join(tmpdir(), 'for-after-p24', `${cfg.profile}-${run}`);
mkdirSync(runDir, { recursive: true });
const log = (...a) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a);
const T0 = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const queues = {
  release: `p24load-${run}-release`,
  email: `p24load-${run}-email`,
  death: `p24load-${run}-death`,
};
const OWNER = `p24load.${run}@example.test`;
const OPS = `ops.${run}@example.test`;
const PASSWORD = 'Load-Test-Password-123!';

// Env shared by the in-process API and every worker: namespaced queues,
// nothing that can send. Release backoff/attempts and email backoff/attempts/
// timeout stay at their production defaults.
Object.assign(process.env, {
  NODE_ENV: 'development',
  RELEASE_QUEUE_NAME: queues.release,
  EMAIL_QUEUE_NAME: queues.email,
  DEATH_VERIFICATION_QUEUE_NAME: queues.death,
  RELEASE_RECONCILE_INTERVAL_SECONDS: String(cfg.reconcileSeconds),
  EMAIL_RECONCILE_INTERVAL_SECONDS: String(cfg.reconcileSeconds),
  EMAIL_PROVIDER: 'disabled',
  SMS_VERIFY_PROVIDER: 'disabled',
  SMS_MESSAGING_PROVIDER: 'disabled',
  TWILIO_ACCOUNT_SID: '',
  TWILIO_AUTH_TOKEN: '',
  OPS_ALERT_EMAIL: OPS,
  MEDIA_CLEANUP_INTERVAL_SECONDS: '0',
  THROTTLE_KEY_PREFIX: `for_after:p24load:${run}:throttle:`,
  APP_BASE_URL: 'http://localhost:3000',
});

// ---------------------------------------------------------------- fake Microsoft Graph sendMail
const provider = {
  attempts: [], // { at, worker, kind, to, key, outcome }
  acceptedKeys: new Map(), // idempotency key → accepted count
  held: null,
  crashArmed: false,
};
const rand = () => Math.random();
const fakeServer = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', async () => {
    const body = JSON.parse(raw || '{}');
    const kind = (req.headers['x-p24-kind'] || 'unknown').replaceAll('-', '_');
    const to = body.message?.toRecipients?.[0]?.emailAddress?.address ?? '';
    const key = req.headers['x-p24-key'] || null;
    const worker = req.headers['x-p24-worker'] ?? '?';
    const rec = { at: Date.now(), worker, kind, to, key, outcome: '' };
    provider.attempts.push(rec);
    // Graph: 202 Accepted, empty body, a request id.
    const accept = (status = 202) => {
      const seen = provider.acceptedKeys.get(key) ?? 0;
      provider.acceptedKeys.set(key, seen + 1);
      rec.outcome = seen && cfg.providerDedupe ? 'deduplicated' : 'accepted';
      if (res.writableEnded || res.destroyed) return;
      res.writeHead(status, { 'request-id': `p24-${createHash('sha1').update(String(rec.at) + to + rand()).digest('hex').slice(0, 16)}` });
      res.end();
    };
    const reject = (status, code, outcome, headers = {}) => {
      rec.outcome = outcome;
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify({ error: { code, message: 'simulated' } }));
    };
    await sleep(Math.max(0, cfg.latencyMs + (rand() * 2 - 1) * cfg.jitterMs));
    // Ops alerts and safety notices are always accepted: faults target the
    // release-notification path under load.
    if (kind !== 'message_released') return accept();
    // Crash window: accepted by the provider, but the worker dies before it
    // can record SENT. The response is never delivered.
    if (provider.crashArmed) {
      provider.crashArmed = false;
      const seen = provider.acceptedKeys.get(key) ?? 0;
      provider.acceptedKeys.set(key, seen + 1);
      rec.outcome = 'accepted_then_worker_killed';
      provider.held = { worker, key, res };
      return;
    }
    if (to.startsWith('perm')) return reject(400, 'ErrorInvalidRecipients', 'permanent_400');
    const r = rand();
    if (r < cfg.p500) return reject(503, 'ServiceUnavailable', 'transient_5xx');
    if (r < cfg.p500 + cfg.p429) return reject(429, 'ApplicationThrottled', 'throttled_429', { 'retry-after': '2' });
    if (r < cfg.p500 + cfg.p429 + cfg.pTimeout) {
      // Slower than EMAIL_SEND_TIMEOUT_MS: the worker gives up, but the
      // provider still accepts it (the realistic worst case).
      rec.outcome = 'timeout_but_accepted';
      await sleep(cfg.emailTimeoutMs + 2000);
      const seen = provider.acceptedKeys.get(key) ?? 0;
      provider.acceptedKeys.set(key, seen + 1);
      if (!res.destroyed) res.destroy();
      return;
    }
    accept();
  });
});
await new Promise((r) => fakeServer.listen(0, '127.0.0.1', r));
const fakeUrl = `http://127.0.0.1:${fakeServer.address().port}/v1.0/users/notifications%40example.test/sendMail`;

// ---------------------------------------------------------------- API (producer only)
const { Test } = require('@nestjs/testing');
const request = require('supertest');
const session = require('express-session');
const { Queue } = require('bullmq');
const { createClient } = require('redis');
const { AppModule } = await import('../../dist/app.module.js');
const { configureApp } = await import('../../dist/config/app.setup.js');
const { EmailProvider } = await import('../../dist/email/email-provider.js');
const { MediaStorage } = await import('../../dist/media/storage/media-storage.service.js');
const { PrismaService } = await import('../../dist/prisma/prisma.service.js');

const apiInbox = [];
const apiRef = await Test.createTestingModule({ imports: [AppModule] })
  .overrideProvider(MediaStorage)
  .useValue({})
  .overrideProvider(EmailProvider)
  .useValue({ name: 'p24-api-recorder', send: async (m) => (apiInbox.push(m.kind), { providerMessageId: null }) })
  .compile();
const api = apiRef.createNestApplication({ logger: ['error', 'warn'] });
configureApp(api, new session.MemoryStore());
await api.init();
const prisma = api.get(PrismaService);
const http = () => request(api.getHttpServer());
const connection = { url: process.env.REDIS_URL };
const releaseQ = new Queue(queues.release, { connection });
const emailQ = new Queue(queues.email, { connection });
const deathQ = new Queue(queues.death, { connection });
const redis = createClient({ url: process.env.REDIS_URL });
await redis.connect();
const consumers = async () =>
  (await Promise.all([releaseQ, emailQ, deathQ].map((q) => q.getWorkersCount()))).reduce((a, b) => a + b, 0);

// ---------------------------------------------------------------- workers
const workers = new Map(); // id → { child, ready, samples }
let workerSeq = 0;
const startWorker = () =>
  new Promise((resolve, reject) => {
    const id = `w${++workerSeq}`;
    const out = createWriteStream(join(runDir, `${id}.log`));
    const child = fork(fileURLToPath(new URL('./worker-entry.mjs', import.meta.url)), [], {
      env: { ...process.env, P24_WORKER_ID: id, P24_FAKE_PROVIDER_URL: fakeUrl },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    child.stdout.pipe(out);
    child.stderr.pipe(out);
    const w = { id, child, samples: [], exited: null };
    workers.set(id, w);
    child.on('message', (m) => {
      if (m.type === 'ready') resolve(w);
      if (m.type === 'sample') w.samples.push(m);
      if (m.type === 'stopped') w.closeMs = m.closeMs;
    });
    child.on('exit', (code, signal) => {
      w.exited = { code, signal, at: Date.now() };
      reject(new Error(`${id} exited before ready (${code ?? signal})`));
    });
  });
const stopGracefully = (w) =>
  new Promise((resolve) => {
    w.child.once('exit', resolve);
    w.child.send({ type: 'shutdown' });
  });
const kill = (w) =>
  new Promise((resolve) => {
    w.child.once('exit', resolve);
    w.child.kill('SIGKILL');
  });
const liveWorkers = () => [...workers.values()].filter((w) => !w.exited);

// ---------------------------------------------------------------- fixtures (real API routes)
const events = [];
const note = (what, extra = {}) => {
  events.push({ t: Date.now() - T0, what, ...extra });
  log(what, Object.keys(extra).length ? JSON.stringify(extra) : '');
};
note('api_ready', { consumers: await consumers() });
if ((await consumers()) !== 0) throw new Error('API process consumes jobs');

await http().post('/api/v1/auth/register').send({ email: OWNER, password: PASSWORD, firstName: 'Load', lastName: 'Test' }).expect(201);
const owner = request.agent(api.getHttpServer());
await owner.post('/api/v1/auth/login').send({ email: OWNER, password: PASSWORD }).expect(200);

const POOL = Math.max(cfg.fanout, 20);
const recipients = [];
for (let i = 0; i < POOL; i++)
  recipients.push(
    (await owner.post('/api/v1/recipients').send({ firstName: `R${i}`, email: `r${i}.${run}@example.test` }).expect(201)).body.id,
  );
const permRecipient = cfg.permanentEvery
  ? (await owner.post('/api/v1/recipients').send({ firstName: 'Perm', email: `perm.${run}@example.test` }).expect(201)).body.id
  : null;
const recipientsFor = (i) =>
  permRecipient && i % cfg.permanentEvery === 0
    ? [permRecipient]
    : Array.from({ length: cfg.fanout }, (_, k) => recipients[(i * cfg.fanout + k) % POOL]);

const createDraft = async (i) =>
  (
    await owner
      .post('/api/v1/messages')
      .send({ title: `Load ${i}`, contentType: 'TEXT', textContent: 'Fictional load-test text.', recipientIds: recipientsFor(i) })
      .expect(201)
  ).body.id;
const schedule = (id, at) =>
  owner.post(`/api/v1/messages/${id}/schedule`).send({ triggerType: 'FIXED_DATE', scheduledFor: at.toISOString() }).expect(201);
const unschedule = (id) => owner.delete(`/api/v1/messages/${id}/schedule`);

const messageIds = [];
const cancelled = new Set();
let dueAt;
let producer;

if (!sustained) {
  for (let i = 0; i < cfg.messages; i++) messageIds.push(await createDraft(i));
  note('drafts_created', { messages: messageIds.length });
  const lead = Math.max(20, Math.ceil(cfg.messages * 0.06));
  dueAt = new Date(Date.now() + lead * 1000);
  for (const id of messageIds) await schedule(id, dueAt);
  note('scheduled', { dueAt: dueAt.toISOString(), leftBeforeDueMs: dueAt - Date.now() });
  if (Date.now() >= dueAt.getTime()) throw new Error('scheduling overran the due time; raise the lead');
  // Cancel before due: unschedule while the delayed job waits.
  for (const id of messageIds.slice(0, cfg.cancelBefore)) {
    await unschedule(id).expect(204);
    cancelled.add(id);
  }
  if (cfg.cancelBefore) note('cancelled_before_due', { count: cfg.cancelBefore });
} else {
  dueAt = null;
}

// The API alone: due work must sit in the queue, unconsumed.
const startAt = sustained ? Date.now() : dueAt.getTime() + cfg.startDelay * 1000;
if (cfg.startDelay) {
  await sleep(Math.max(0, startAt - Date.now() - 1000));
  const counts = await releaseQ.getJobCounts('waiting', 'delayed', 'active');
  note('api_only_after_due', { ...counts, consumers: await consumers() });
  if (counts.active || (await consumers())) throw new Error('jobs consumed without a worker process');
  // Cancel while waiting: due, queued, no worker yet.
  const waitingIds = messageIds.slice(cfg.cancelBefore, cfg.cancelBefore + cfg.cancelWaiting);
  for (const id of waitingIds) {
    await unschedule(id).expect(204);
    cancelled.add(id);
  }
  if (cfg.cancelWaiting) note('cancelled_while_waiting', { count: waitingIds.length });
}
if (cfg.duplicates) {
  // Same deterministic ids: BullMQ keeps one job each.
  let foreign = 0;
  for (const id of messageIds) {
    await releaseQ.add('release', { messageId: id }, { jobId: `message-release-${id}` });
    if (foreign < 20 && !cancelled.has(id)) {
      // A foreign duplicate (different job id) for the same message: the worker re-checks PostgreSQL.
      await releaseQ.add('release', { messageId: id }, { jobId: `p24-dup-${id}`, attempts: 1 });
      foreign++;
    }
  }
  for (const id of [...cancelled].slice(0, 10))
    await releaseQ.add('release', { messageId: id }, { jobId: `p24-dup-cancelled-${id}`, attempts: 1 });
  note('duplicates_enqueued', { sameId: messageIds.length, foreignId: foreign, forCancelled: Math.min(10, cancelled.size) });
}

for (let i = 0; i < cfg.workers; i++) await startWorker();
note('workers_ready', { workers: cfg.workers, consumers: await consumers() });

if (sustained) {
  // Arrival: one message every 1/rate s, due 15 s after creation.
  const until = Date.now() + cfg.duration * 1000;
  producer = (async () => {
    let i = 0;
    let next = Date.now();
    while (Date.now() < until) {
      const id = await createDraft(i++);
      await schedule(id, new Date(Date.now() + 15_000));
      messageIds.push(id);
      next += 1000 / cfg.rate;
      await sleep(Math.max(0, next - Date.now()));
    }
    note('producer_done', { messages: messageIds.length });
  })();
}

// ---------------------------------------------------------------- monitoring
const jobTimes = { release: new Map(), email: new Map() };
const samples = [];
const db = async () => {
  const [msgs, notes] = await Promise.all([
    prisma.message.groupBy({ by: ['status'], where: { owner: { email: OWNER } }, _count: true }),
    prisma.releaseNotification.groupBy({ by: ['status'], where: { grant: { message: { owner: { email: OWNER } } } }, _count: true }),
  ]);
  const flat = (rows) => Object.fromEntries(rows.map((r) => [r.status, r._count]));
  return { messages: flat(msgs), notifications: flat(notes) };
};
const captureJobs = async () => {
  for (const [name, q] of [['release', releaseQ], ['email', emailQ]]) {
    for (const j of await q.getJobs(['completed', 'failed'], 0, 1999)) {
      if (!j?.id || jobTimes[name].has(j.id) || !j.finishedOn) continue;
      jobTimes[name].set(j.id, {
        readyAt: j.timestamp + (j.opts?.delay ?? 0),
        processedOn: j.processedOn,
        finishedOn: j.finishedOn,
        attemptsMade: j.attemptsMade,
        failed: !!j.failedReason,
      });
    }
  }
};
let pgConnPeak = 0;
let redisClientsPeak = 0;
const monitor = async () => {
  const [counts, rel, conns, info] = await Promise.all([
    db(),
    Promise.all([releaseQ.getJobCounts('waiting', 'delayed', 'active', 'failed'), emailQ.getJobCounts('waiting', 'delayed', 'active', 'failed')]),
    prisma.$queryRawUnsafe('select count(*)::int as n from pg_stat_activity where datname = current_database()'),
    redis.info('clients'),
  ]);
  await captureJobs();
  const pgConns = conns[0].n;
  const redisClients = Number(/connected_clients:(\d+)/.exec(info)?.[1] ?? 0);
  pgConnPeak = Math.max(pgConnPeak, pgConns);
  redisClientsPeak = Math.max(redisClientsPeak, redisClients);
  const s = { t: Date.now() - T0, ...counts, releaseQueue: rel[0], emailQueue: rel[1], pgConns, redisClients, providerAttempts: provider.attempts.length };
  samples.push(s);
  return s;
};

// Fault injection by progress (fraction of expected notifications SENT).
const expectedMessages = () => messageIds.filter((id) => !cancelled.has(id));
let crashDone = false;
let gracefulDone = false;
let killDone = false;
const progress = (s) => (s.notifications.SENT ?? 0) / Math.max(1, expectedMessages().length * cfg.fanout);
const inject = async (s) => {
  const p = progress(s);
  if (cfg.crashWindowAt !== undefined && !crashDone && p >= cfg.crashWindowAt) {
    crashDone = true;
    provider.crashArmed = true;
    note('crash_window_armed');
  }
  if (provider.held) {
    const { worker, key } = provider.held;
    provider.held = null;
    const w = workers.get(worker);
    note('crash_window_kill', { worker, key });
    await kill(w);
    await startWorker();
    note('replacement_started_after_crash');
  }
  if (cfg.gracefulAt !== undefined && !gracefulDone && p >= cfg.gracefulAt) {
    gracefulDone = true;
    const w = liveWorkers()[0];
    const t = Date.now();
    await stopGracefully(w);
    note('graceful_stop', { worker: w.id, closeMs: w.closeMs, exitMs: Date.now() - t, code: w.exited?.code });
    await startWorker();
  }
  if (cfg.killAt !== undefined && !killDone && p >= cfg.killAt) {
    killDone = true;
    const w = liveWorkers().at(-1);
    await kill(w);
    note('unexpected_kill', { worker: w.id });
    await startWorker();
  }
};

// ---------------------------------------------------------------- settle
const settled = async (s) => {
  if (producer && !producer.done) return false;
  const expected = expectedMessages().length;
  const released = s.messages.RELEASED ?? 0;
  const terminal = (s.notifications.SENT ?? 0) + (s.notifications.FAILED ?? 0);
  const pending = s.notifications.PENDING ?? 0;
  const busy = ['waiting', 'delayed', 'active'].some((k) => s.emailQueue[k] > 0);
  return released === expected && pending === 0 && terminal === expected * cfg.fanout && !busy;
};
if (producer) producer.then(() => (producer.done = true));
const deadline = T0 + cfg.deadline * 1000;
let last;
let lastLog = 0;
while (true) {
  last = await monitor();
  await inject(last);
  if (Date.now() - lastLog > 10_000) {
    lastLog = Date.now();
    log(JSON.stringify({ messages: last.messages, notifications: last.notifications, release: last.releaseQueue, email: last.emailQueue, pg: last.pgConns }));
  }
  if (await settled(last)) break;
  if (Date.now() > deadline) break;
  await sleep(1000);
}
const settledAt = Date.now();
const timedOut = settledAt > deadline;
note(timedOut ? 'deadline_passed' : 'settled');

// Post-settle duplicate probes: foreign email jobs for SENT rows must be no-ops.
if (cfg.duplicates && !timedOut) {
  const sent = await prisma.releaseNotification.findMany({ where: { status: 'SENT', grant: { message: { owner: { email: OWNER } } } }, take: 20, select: { id: true } });
  const attemptsBefore = provider.attempts.length;
  for (const { id } of sent) await emailQ.add('message-released', { notificationId: id }, { jobId: `p24-dup-email-${id}`, attempts: 1 });
  const t = Date.now();
  while (Date.now() - t < 30_000 && (await emailQ.getJobCounts('waiting', 'active')).waiting + (await emailQ.getJobCounts('active')).active > 0) await sleep(500);
  await sleep(1000);
  note('foreign_email_jobs_for_sent_rows', { jobs: sent.length, newProviderAttempts: provider.attempts.length - attemptsBefore });
}
// One more reconcile window with everything idle: nothing new may appear.
const quietBefore = { attempts: provider.attempts.length, releases: await prisma.messageRelease.count({ where: { message: { owner: { email: OWNER } } } }) };
await sleep(Math.min(cfg.reconcileSeconds, 60) * 1000 + 2000);
await captureJobs();

// ---------------------------------------------------------------- results
const pct = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};
const stats = (arr) => {
  const n = arr.length;
  const r = (v) => (v === null ? null : Math.round(v) / 1000);
  return {
    n,
    p50: r(pct(arr, 50)),
    p95: n >= 20 ? r(pct(arr, 95)) : null,
    p99: n >= 100 ? r(pct(arr, 99)) : null,
    max: r(n ? Math.max(...arr) : null),
  };
};
const mine = { message: { owner: { email: OWNER } } };
const releases = await prisma.messageRelease.findMany({ where: { message: { owner: { email: OWNER } } }, select: { messageId: true, scheduledFor: true, releasedAt: true } });
const grants = await prisma.recipientMessageAccessGrant.findMany({ where: mine, select: { id: true, messageId: true, recipientId: true } });
const notes = await prisma.releaseNotification.findMany({ where: { grant: mine }, select: { id: true, grantId: true, status: true, attemptCount: true, createdAt: true, sentAt: true, failedAt: true, lastErrorCode: true, grant: { select: { messageId: true } } } });
const dueOf = new Map(releases.map((r) => [r.messageId, r.scheduledFor]));
const dead = await prisma.deadLetterJob.findMany({ where: { OR: [{ entityId: { in: notes.map((n) => n.id) } }, { entityId: { in: messageIds } }] }, select: { id: true, queueName: true, entityType: true, errorCode: true, alertStatus: true, failureCount: true } });

const dupGrantPairs = Object.values(grants.reduce((m, g) => ((m[`${g.messageId}:${g.recipientId}`] = (m[`${g.messageId}:${g.recipientId}`] ?? 0) + 1), m), {})).filter((c) => c > 1).length;
const dupNotifications = Object.values(notes.reduce((m, n) => ((m[n.grantId] = (m[n.grantId] ?? 0) + 1), m), {})).filter((c) => c > 1).length;
const released = releases.length;
const cancelledReleased = releases.filter((r) => cancelled.has(r.messageId)).length;
const sentRows = notes.filter((n) => n.status === 'SENT');
const failedRows = notes.filter((n) => n.status === 'FAILED');
const relAttempts = provider.attempts.filter((a) => a.kind === 'message_released');
const keysAccepted = [...provider.acceptedKeys.entries()].filter(([k]) => k?.startsWith('release-notification/'));
const multiAccepted = keysAccepted.filter(([, c]) => c > 1);
const outcomes = relAttempts.reduce((m, a) => ((m[a.outcome] = (m[a.outcome] ?? 0) + 1), m), {});
// Alerts for this run's dead letters; others are for rows already in the
// database (the alert reconciler covers the last 24 h of the whole table).
const allOpsAlerts = provider.attempts.filter((a) => a.kind === 'ops_alert');
const deadIds = new Set(dead.map((d) => d.id));
const opsAlerts = allOpsAlerts.filter((a) => deadIds.has(a.key?.split('/')[1]));
const relJobs = [...jobTimes.release.values()].filter((j) => !j.failed);
const emailJobs = [...jobTimes.email.values()];
const firstDue = sustained ? Math.min(...releases.map((r) => r.scheduledFor.getTime())) : dueAt.getTime();
const lastSent = Math.max(...sentRows.map((n) => n.sentAt.getTime()), ...failedRows.map((n) => n.failedAt?.getTime() ?? 0));
const workerSamples = [...workers.values()].map((w) => ({
  id: w.id,
  exited: w.exited ? { code: w.exited.code, signal: w.exited.signal } : null,
  closeMs: w.closeMs ?? null,
  cpuMs: w.samples.at(-1)?.cpuMs ?? null,
  peakRssMb: Math.max(0, ...w.samples.map((s) => s.rssMb)),
}));

const expectedPermanent = cfg.permanentEvery ? messageIds.filter((id, i) => i % cfg.permanentEvery === 0 && !cancelled.has(id)).length : 0;
const result = {
  run,
  profile: cfg.profile,
  config: cfg,
  host: { cpus: cpus().length, cpuModel: cpus()[0]?.model, memGb: Math.round(totalmem() / 1073741824), node: process.version },
  queues,
  events,
  counts: {
    messagesCreated: messageIds.length,
    cancelled: cancelled.size,
    expectedReleased: expectedMessages().length,
    released,
    cancelledReleased,
    grants: grants.length,
    expectedDeliveries: expectedMessages().length * cfg.fanout,
    notificationRows: notes.length,
    sent: sentRows.length,
    failed: failedRows.length,
    pending: notes.filter((n) => n.status === 'PENDING').length,
    failedCodes: failedRows.reduce((m, n) => ((m[n.lastErrorCode] = (m[n.lastErrorCode] ?? 0) + 1), m), {}),
    retries: notes.reduce((a, n) => a + n.attemptCount, 0) - notes.filter((n) => n.attemptCount > 0).length,
    deadLetters: dead.length,
    deadLettersByQueue: dead.reduce((m, d) => ((m[`${d.queueName}:${d.errorCode}`] = (m[`${d.queueName}:${d.errorCode}`] ?? 0) + 1), m), {}),
    deadLetterAlerts: dead.reduce((m, d) => ((m[d.alertStatus] = (m[d.alertStatus] ?? 0) + 1), m), {}),
    opsAlertEmails: opsAlerts.length,
    opsAlertEmailsForPreexistingDeadLetters: allOpsAlerts.length - opsAlerts.length,
    duplicateGrantPairs: dupGrantPairs,
    grantsWithMultipleNotificationRows: dupNotifications,
  },
  provider: {
    releaseAttempts: relAttempts.length,
    outcomes,
    distinctIdempotencyKeys: keysAccepted.length,
    keysAcceptedMoreThanOnce: multiAccepted.length,
    deliveriesWithoutProviderDedupe: keysAccepted.reduce((a, [, c]) => a + c, 0),
    deliveriesIfProviderHonoursKey: keysAccepted.length,
    providerDedupeSimulated: cfg.providerDedupe,
  },
  latencySeconds: {
    dueToReleased: stats(releases.map((r) => r.releasedAt - r.scheduledFor)),
    dueToSentRecorded: stats(sentRows.map((n) => n.sentAt - dueOf.get(n.grant.messageId))),
    notificationCreatedToSent: stats(sentRows.map((n) => n.sentAt - n.createdAt)),
    releaseQueueWait: stats(relJobs.map((j) => j.processedOn - j.readyAt)),
    releaseProcessing: stats(relJobs.map((j) => j.finishedOn - j.processedOn)),
    emailQueueWaitFirstAttempt: stats(emailJobs.filter((j) => j.attemptsMade <= 1).map((j) => j.processedOn - j.readyAt)),
    emailProcessing: stats(emailJobs.map((j) => j.finishedOn - j.processedOn)),
  },
  jobSamplesCaptured: { release: jobTimes.release.size, email: jobTimes.email.size },
  throughput: {
    drainSeconds: sentRows.length || failedRows.length ? Math.round(lastSent - firstDue) / 1000 : null,
    // After the last arrival fell due: how long the remaining backlog took.
    drainAfterLastDueSeconds: releases.length ? Math.round(lastSent - Math.max(...releases.map((r) => r.scheduledFor.getTime()))) / 1000 : null,
    notificationsPerSecond: sentRows.length ? +(sentRows.length / Math.max(1, (lastSent - firstDue) / 1000)).toFixed(2) : 0,
    peakEmailBacklog: Math.max(0, ...samples.map((s) => s.emailQueue.waiting + s.emailQueue.delayed)),
    peakReleaseBacklog: Math.max(0, ...samples.map((s) => s.releaseQueue.waiting)),
  },
  resources: { workers: workerSamples, pgConnectionsPeak: pgConnPeak, redisClientsPeak },
  quietPeriod: {
    newProviderAttempts: provider.attempts.length - quietBefore.attempts,
    newReleases: (await prisma.messageRelease.count({ where: { message: { owner: { email: OWNER } } } })) - quietBefore.releases,
  },
  apiOnlyConsumers: events.find((e) => e.what === 'api_ready')?.consumers,
  timedOut,
};

// ---------------------------------------------------------------- acceptance
const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });
check('settled before deadline', !timedOut, `${cfg.deadline}s`);
check('API process alone consumed nothing', result.apiOnlyConsumers === 0);
check('every expected message released exactly once', released === expectedMessages().length && cancelledReleased === 0, `${released}/${expectedMessages().length}`);
check('cancelled messages never released', cancelledReleased === 0, `${cancelled.size} cancelled`);
check('one grant per message and recipient', grants.length === expectedMessages().length * cfg.fanout && dupGrantPairs === 0);
check('one notification row per grant', notes.length === grants.length && dupNotifications === 0);
check('every notification terminal (none PENDING)', result.counts.pending === 0);
// FAILED = every permanent rejection, plus transient failures only once all
// attempts (EMAIL_JOB_ATTEMPTS, default 5) are spent.
const permanentFailed = failedRows.filter((n) => n.lastErrorCode === 'ErrorInvalidRecipients');
const exhausted = failedRows.filter((n) => n.lastErrorCode !== 'ErrorInvalidRecipients');
check('FAILED only for permanent rejections or exhausted retries', permanentFailed.length === expectedPermanent && permanentFailed.every((n) => n.attemptCount === 1) && exhausted.every((n) => n.attemptCount >= 5), `${permanentFailed.length}/${expectedPermanent} permanent, ${exhausted.length} exhausted`);
const emailDead = dead.filter((d) => d.queueName === 'email-delivery');
check('one dead letter and one ops alert per FAILED notification', emailDead.length === failedRows.length && opsAlerts.length === emailDead.length && dead.length === emailDead.length, `${emailDead.length} dead letters, ${opsAlerts.length} alerts, ${failedRows.length} failed`);
check('quiet period: reconcilers add no provider attempt or release', result.quietPeriod.newProviderAttempts === 0 && result.quietPeriod.newReleases === 0);
const drain = sustained ? result.throughput.drainAfterLastDueSeconds : result.throughput.drainSeconds;
if (cfg.accept.drain) check(`${sustained ? 'backlog drain after the last arrival' : 'drain from first due'} ≤ ${cfg.accept.drain}s (provisional)`, drain !== null && drain <= cfg.accept.drain, `${drain}s`);
if (cfg.accept.p95DueToRelease) check(`p95 due→released ≤ ${cfg.accept.p95DueToRelease}s (provisional)`, (result.latencySeconds.dueToReleased.p95 ?? Infinity) <= cfg.accept.p95DueToRelease, `${result.latencySeconds.dueToReleased.p95}s`);
if (cfg.accept.p95DueToSent) check(`p95 due→sent ≤ ${cfg.accept.p95DueToSent}s (provisional)`, (result.latencySeconds.dueToSentRecorded.p95 ?? Infinity) <= cfg.accept.p95DueToSent, `${result.latencySeconds.dueToSentRecorded.p95}s`);
if (cfg.crashWindowAt !== undefined) check('crash window exercised: one key accepted twice, one logical SENT row', multiAccepted.length >= 1, `${multiAccepted.length} keys accepted > 1`);
result.checks = checks;
result.passed = checks.every((c) => c.ok);

// ---------------------------------------------------------------- cleanup (this run only)
for (const w of liveWorkers()) await stopGracefully(w);
const out = new URL(`../../docs/testing/load-results/${cfg.profile}-${run}.json`, import.meta.url);
mkdirSync(new URL('.', out), { recursive: true });
writeFileSync(out, JSON.stringify(result, null, 2));
writeFileSync(join(runDir, 'samples.json'), JSON.stringify(samples));
writeFileSync(join(runDir, 'provider-attempts.json'), JSON.stringify(provider.attempts.map(({ at, worker, kind, outcome, key }) => ({ at, worker, kind, outcome, key }))));
if (!argv.keep) {
  await prisma.user.deleteMany({ where: { email: OWNER } });
  await prisma.deadLetterJob.deleteMany({ where: { OR: [{ entityId: { in: notes.map((n) => n.id) } }, { entityId: { in: messageIds } }] } });
  for (const q of [releaseQ, emailQ, deathQ]) await q.obliterate({ force: true }).catch(() => undefined);
  for (const k of await redis.keys(`for_after:p24load:${run}:*`)) await redis.del(k);
}
for (const q of [releaseQ, emailQ, deathQ]) await q.close();
await redis.quit();
await api.close();
fakeServer.close();

console.log('\n=== Phase 24 load result:', cfg.profile, run, result.passed ? 'PASS' : 'FAIL', '===');
for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? ` (${c.detail})` : ''}`);
console.log(JSON.stringify({ counts: result.counts, provider: result.provider, latencySeconds: result.latencySeconds, throughput: result.throughput, resources: result.resources }, null, 1));
console.log(`results: ${fileURLToPath(out)}\nlogs: ${runDir}`);
process.exit(result.passed ? 0 : 1);
