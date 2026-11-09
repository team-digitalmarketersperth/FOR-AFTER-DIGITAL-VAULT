import { ConfigModule } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import session from 'express-session';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { adminSignIn } from './admin-sign-in.js';
import { FakeEmailProvider } from './fake-email.js';
import { AnnouncementPolicy, type PolicyBlocker } from '../src/announcements/announcement-audience.service.js';
import { AnnouncementBroadcastProcessor, emailHash, MAX_ATTEMPTS } from '../src/announcements/announcement-broadcast.processor.js';
import { AnnouncementBroadcastQueue } from '../src/announcements/announcement-broadcast-queue.service.js';
import { RETRY_BATCH_MAX } from '../src/announcements/announcement-results.service.js';
import { signReview } from '../src/announcements/announcement-broadcast.service.js';
import { AnnouncementsModule } from '../src/announcements/announcements.module.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { configureApp } from '../src/config/app.setup.js';
import { EmailProvider, EmailSendError, type EmailMessage } from '../src/email/email-provider.js';
import { EmailModule } from '../src/email/email.module.js';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { RedisModule } from '../src/redis/redis.module.js';
import { RedisService } from '../src/redis/redis.service.js';

// Notification centre Step 4 on real HTTP, sessions, PostgreSQL, Redis and BullMQ.
// The email provider is the fake inbox: nothing reaches Microsoft Graph. The
// communication policy is swapped for a cleared one (the real app always has
// POLICY_BLOCKERS) so the sending path can be exercised; tests put the real
// blockers back to prove they stop everything. The worker is closed after
// start-up and each slice is driven by hand. Fictional people and content only.
// The shared test database holds other suites' customers too: a run includes
// them (fake inbox only), so assertions look at this file's own customers.
// Step 5: size of the bounded throughput fixture (fictional customers, fake provider). Modest by default.
const LOAD_N = Number(process.env.BCAST_LOAD_N ?? 200);

describe('Announcement customer broadcasts (e2e, PostgreSQL, provider mocked)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let processor: AnnouncementBroadcastProcessor;
  let queue: AnnouncementBroadcastQueue;
  const inbox = new FakeEmailProvider();
  const policy: { blockers: readonly PolicyBlocker[]; version: string } = { blockers: [], version: 'e2e-cleared' };
  const run = Date.now();
  const at = (n: string) => `bcast.${n}.${run}@example.test`;
  const staff = { admin: at('admin'), root: at('root'), root2: at('root2') };
  const password = 'StrongPassword123!';
  type Agent = ReturnType<typeof request.agent>;
  const agents = {} as Record<keyof typeof staff, Agent>;
  const ids: string[] = [];
  const api = (p: string) => `/api/v1${p}`;
  const ORIGIN = 'https://app.example.test';
  const ENV = [
    'EMAIL_PROVIDER',
    'APP_BASE_URL',
    'FRONTEND_URL',
    'THROTTLE_KEY_PREFIX',
    'ANNOUNCEMENT_BROADCAST_QUEUE_NAME',
    'ANNOUNCEMENT_BROADCAST_ENABLED',
    'ANNOUNCEMENT_BROADCAST_DAILY_LIMIT',
    'EMAIL_RECONCILE_INTERVAL_SECONDS',
  ];
  let paused: number[] = [];

  const customer = async (n: string, over: Record<string, unknown> = {}) => {
    const u = await prisma.user.create({
      // Opted in to product news (Step 7 consent rule) unless a test says otherwise.
      data: { email: at(n), passwordHash: 'x', role: 'CUSTOMER', emailVerifiedAt: new Date(), marketingConsentAt: new Date(), ...over },
      select: { id: true, email: true },
    });
    ids.push(u.id);
    return u;
  };
  /** These tests exercise the all-eligible path (pilot runs: announcement-pilot.e2e-spec.ts). */
  const newDraft = async (subject = 'Hello <customers> & friends') => {
    const d = (await agents.root.post(api('/admin/announcements')).set('Origin', ORIGIN).send({ name: `B ${randomUUID()}`, subject, body: 'Line one.\n\nLine two.' }).expect(201))
      .body as { id: string; version: number };
    await agents.root.put(api(`/admin/announcements/${d.id}/audience-scope`)).set('Origin', ORIGIN).send({ audience: 'ALL_ELIGIBLE' }).expect(200);
    return d;
  };
  const review = (id: string, expectedVersion: number, agent = agents.root) =>
    agent.post(api(`/admin/announcements/${id}/broadcast-review`)).set('Origin', ORIGIN).send({ expectedVersion });
  const confirm = (id: string, body: object, agent = agents.root) => agent.post(api(`/admin/announcements/${id}/broadcasts`)).set('Origin', ORIGIN).send(body);
  /** Review then confirm; other suites can change the shared audience in between, so one retry on that 409. */
  const queueRun = async (id: string, version: number) => {
    for (let i = 0; ; i++) {
      const { reviewToken } = (await review(id, version).expect(200)).body as { reviewToken: string };
      const res = await confirm(id, { clientOperationId: randomUUID(), expectedVersion: version, reviewToken });
      if (res.status === 202) return res.body as { id: string; status: string };
      if (i) throw new Error(`confirm failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
  };
  const progress = async (id: string, runId: string) =>
    (await agents.root.get(api(`/admin/announcements/${id}/broadcasts/${runId}`)).expect(200)).body as {
      status: string;
      stopping: boolean;
      prepared: number;
      audiencePrepared: boolean;
      counts: Record<string, number>;
      reasons: Record<string, Record<string, number>>;
      lastUpdatedAt: string;
    };
  /** Drives slices until the run is final, skipping waits (lease pauses) but never backoffs. */
  const driveAll = async (runId: string) => {
    for (let i = 0; i < 100; i++) {
      const { status } = await prisma.announcementSendRun.findUniqueOrThrow({ where: { id: runId } });
      if (!['PREPARING', 'SENDING'].includes(status)) return;
      const out = await processor.drive(runId);
      if (out === 'finished') return;
      await prisma.announcementSendRun.update({ where: { id: runId }, data: { leaseUntil: null } });
    }
    throw new Error('run did not finish');
  };
  const recipient = (runId: string, userId: string) => prisma.announcementRunRecipient.findUnique({ where: { runId_userId: { runId, userId } } });
  const prepareAll = async (runId: string) => {
    const p = processor as unknown as { prepareBatch(id: string): Promise<void> };
    for (let i = 0; i < 1000; i++) {
      if ((await prisma.announcementSendRun.findUniqueOrThrow({ where: { id: runId } })).status !== 'PREPARING') return;
      await p.prepareBatch(runId);
    }
  };
  const finishRunsOf = async () => {
    // Leave nothing active for the next test (one active run at a time).
    await prisma.announcementSendRun.updateMany({ where: { status: { in: ['PREPARING', 'SENDING'] } , requestedByUserId: { in: ids } }, data: { status: 'CANCELLED' } });
  };

  beforeAll(async () => {
    Object.assign(process.env, {
      EMAIL_PROVIDER: 'disabled',
      APP_BASE_URL: ORIGIN,
      FRONTEND_URL: ORIGIN,
      THROTTLE_KEY_PREFIX: `for_after:test_bcast_throttle:${run}:`,
      ANNOUNCEMENT_BROADCAST_QUEUE_NAME: `announcement-broadcast-e2e-${run}`,
      ANNOUNCEMENT_BROADCAST_ENABLED: 'true',
      ANNOUNCEMENT_BROADCAST_DAILY_LIMIT: '10000',
      EMAIL_RECONCILE_INTERVAL_SECONDS: '3600',
    });
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule, RedisModule, AuthModule, AnnouncementsModule, EmailModule],
      providers: [AnnouncementBroadcastProcessor],
    })
      .overrideProvider(EmailProvider)
      .useValue(inbox)
      .overrideProvider(AnnouncementPolicy)
      .useValue(policy)
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app, new session.MemoryStore(), new session.MemoryStore());
    await app.init();
    prisma = app.get(PrismaService);
    processor = app.get(AnnouncementBroadcastProcessor);
    queue = app.get(AnnouncementBroadcastQueue);
    await (processor as unknown as { worker: { close: () => Promise<void> } }).worker.close();
    vi.spyOn(processor as unknown as { pause(ms: number): Promise<void> }, 'pause').mockImplementation((ms: number) => {
      paused.push(ms);
      return Promise.resolve();
    });
    for (const email of Object.values(staff)) {
      await request(app.getHttpServer()).post(api('/auth/register')).send({ email, password, firstName: 'Staff', lastName: 'Test' }).expect(201);
    }
    await prisma.user.updateMany({ where: { email: { in: Object.values(staff) } }, data: { emailVerifiedAt: new Date() } });
    await prisma.user.update({ where: { email: staff.admin }, data: { role: 'ADMIN' } });
    await prisma.user.updateMany({ where: { email: { in: [staff.root, staff.root2] } }, data: { role: 'SUPER_ADMIN' } });
    ids.push(...(await prisma.user.findMany({ where: { email: { in: Object.values(staff) } }, select: { id: true } })).map((u) => u.id));
    for (const k of Object.keys(staff) as (keyof typeof staff)[]) agents[k] = (await adminSignIn(app, staff[k], password)).agent;
  });

  const resetThrottle = async () => {
    const redis = app.get(RedisService).client;
    for (const key of await redis.keys(`${process.env.THROTTLE_KEY_PREFIX}*`)) await redis.del(key);
  };

  beforeEach(async () => {
    await resetThrottle();
    policy.blockers = [];
    policy.version = 'e2e-cleared';
    process.env.ANNOUNCEMENT_BROADCAST_ENABLED = 'true';
    paused = [];
    inbox.sent.length = 0;
    inbox.failuresFor.clear();
    processor.prepareBatchSize = 500;
  });

  afterEach(finishRunsOf);

  afterAll(async () => {
    for (const k of ENV) delete process.env[k];
    const runs = await prisma?.announcementSendRun.findMany({ where: { requestedByUserId: { in: ids } }, select: { id: true } });
    await prisma?.announcementRunRecipient.deleteMany({ where: { runId: { in: runs?.map((r) => r.id) ?? [] } } });
    await prisma?.announcementSendRun.deleteMany({ where: { requestedByUserId: { in: ids } } });
    await prisma?.emailAnnouncement.deleteMany({ where: { createdByUserId: { in: ids } } });
    await prisma?.user.deleteMany({ where: { id: { in: ids } } });
    await queue?.queue.obliterate({ force: true });
    await app?.close();
  });

  it('only a SUPER_ADMIN with an MFA session reaches broadcast routes; Origin checked; no client recipients or counts accepted', async () => {
    const { id, version } = await newDraft();
    const runId = randomUUID();
    const body = { clientOperationId: randomUUID(), expectedVersion: version, reviewToken: 'a.b' };
    const anon = request(app.getHttpServer());
    await anon.post(api(`/admin/announcements/${id}/broadcast-review`)).send({ expectedVersion: version }).expect(401);
    await anon.post(api(`/admin/announcements/${id}/broadcasts`)).send(body).expect(401);
    await anon.get(api(`/admin/announcements/${id}/broadcasts/${runId}`)).expect(401);
    await anon.post(api(`/admin/announcements/${id}/broadcasts/${runId}/cancel`)).expect(401);
    await review(id, version, agents.admin).expect(403);
    await confirm(id, body, agents.admin).expect(403);
    await agents.admin.get(api(`/admin/announcements/${id}/broadcasts/${runId}`)).expect(403);
    await agents.admin.post(api(`/admin/announcements/${id}/broadcasts/${runId}/cancel`)).set('Origin', ORIGIN).expect(403);
    // Password only, two-factor not completed.
    const half = request.agent(app.getHttpServer());
    await half.post(api('/auth/login')).send({ email: staff.root, password }).expect(200);
    await half.post(api(`/admin/announcements/${id}/broadcast-review`)).set('Origin', ORIGIN).send({ expectedVersion: version }).expect(401);
    await half.post(api(`/admin/announcements/${id}/broadcasts`)).set('Origin', ORIGIN).send(body).expect(401);
    await agents.root.post(api(`/admin/announcements/${id}/broadcasts`)).set('Origin', 'https://evil.example').send(body).expect(403);
    for (const extra of [{ recipients: [at('x')] }, { to: at('x') }, { eligibleCount: 1 }, { audience: 'ALL' }]) {
      await confirm(id, { ...body, ...extra }).expect(400);
    }
    // Per-IP limit on confirmations (5 per minute): an unauthenticated review token never gets past 409, then 429.
    const statuses: number[] = [];
    for (let i = 0; i < 7 && !statuses.includes(429); i++) statuses.push((await confirm(id, body)).status);
    expect(statuses.at(-1)).toBe(429);
    expect(statuses.slice(0, -1).every((st) => st === 409)).toBe(true);
    expect(await prisma.announcementSendRun.count({ where: { announcementId: id } })).toBe(0);
  });

  it('gate off: review shows the blocker without a token, confirmation refused, and a running broadcast stops (BLOCKED, nothing sent)', async () => {
    await customer('gate');
    const { id, version } = await newDraft();
    const { reviewToken } = (await review(id, version).expect(200)).body as { reviewToken: string };
    process.env.ANNOUNCEMENT_BROADCAST_ENABLED = 'false';
    const r = (await review(id, version).expect(200)).body as { reviewToken: string | null; blockers: { code: string }[] };
    expect(r.reviewToken).toBeNull();
    expect(r.blockers.map((b) => b.code)).toContain('broadcast_disabled');
    expect((await confirm(id, { clientOperationId: randomUUID(), expectedVersion: version, reviewToken }).expect(409)).body.message).toMatch(/turned off/);
    expect(await prisma.announcementSendRun.count({ where: { announcementId: id } })).toBe(0);

    // Gate closed after confirmation: the worker refuses too.
    process.env.ANNOUNCEMENT_BROADCAST_ENABLED = 'true';
    const started = await queueRun(id, version);
    await prepareAll(started.id);
    process.env.ANNOUNCEMENT_BROADCAST_ENABLED = 'false';
    await driveAll(started.id);
    const p = await progress(id, started.id);
    expect(p.status).toBe('BLOCKED');
    expect(p.counts.ACCEPTED).toBe(0);
    expect(p.counts.SKIPPED).toBe(p.prepared);
    expect(p.reasons.SKIPPED.broadcast_disabled).toBe(p.prepared);
    expect(inbox.sent).toHaveLength(0);
  });

  it('policy blockers: no token while open, a token from before is refused, and a run under a changed policy is BLOCKED', async () => {
    await customer('policy');
    const { id, version } = await newDraft();
    const { reviewToken } = (await review(id, version).expect(200)).body as { reviewToken: string };
    const TEST_BLOCKERS: PolicyBlocker[] = [{ code: 'e2e_open_decision', message: 'An open policy decision (test only).' }];
    policy.blockers = TEST_BLOCKERS;
    const r = (await review(id, version).expect(200)).body as { reviewToken: string | null; eligible: number | null; blockers: { code: string }[] };
    expect(r.reviewToken).toBeNull();
    expect(r.eligible).toBeNull();
    expect(r.blockers.map((b) => b.code)).toContain('e2e_open_decision');
    await confirm(id, { clientOperationId: randomUUID(), expectedVersion: version, reviewToken }).expect(409);
    policy.blockers = [];
    policy.version = 'e2e-other';
    await confirm(id, { clientOperationId: randomUUID(), expectedVersion: version, reviewToken }).expect(409); // token for another policy version

    const started = await queueRun(id, version);
    policy.version = 'e2e-changed-again';
    await driveAll(started.id);
    const p = await progress(id, started.id);
    expect(p.status).toBe('BLOCKED');
    expect(inbox.sent).toHaveLength(0);
  });

  it('stale, changed, expired, forged or borrowed reviews require a new review; a larger audience requires a new confirmation', async () => {
    const { id, version } = await newDraft();
    await review(id, version + 1).expect(409); // the editor's version is not the saved one
    const { reviewToken } = (await review(id, version).expect(200)).body as { reviewToken: string };
    const v2 = (await agents.root.put(api(`/admin/announcements/${id}`)).set('Origin', ORIGIN).send({ name: 'B2', subject: 'Changed', body: 'New text', expectedVersion: version }).expect(200)).body as { version: number };
    expect((await confirm(id, { clientOperationId: randomUUID(), expectedVersion: version, reviewToken }).expect(409)).body.message).toMatch(/changed/);
    expect((await confirm(id, { clientOperationId: randomUUID(), expectedVersion: v2.version, reviewToken }).expect(409)).body.message).toMatch(/expired/);

    const secret = process.env.SESSION_SECRET!;
    const { eligible } = (await review(id, v2.version).expect(200)).body as { eligible: number };
    const rootId = (await prisma.user.findUniqueOrThrow({ where: { email: staff.root } })).id;
    const claims = { a: id, v: v2.version, u: rootId, n: eligible, p: policy.version, s: 'ALL_ELIGIBLE' as const, m: '' };
    const expired = signReview({ ...claims, exp: Date.now() - 1 }, secret);
    await confirm(id, { clientOperationId: randomUUID(), expectedVersion: v2.version, reviewToken: expired }).expect(409);
    await resetThrottle(); // more confirmations than the 5-per-minute limit in this one test
    const forged = signReview({ ...claims, exp: Date.now() + 60_000 }, 'not-the-server-secret-0123456789abcdef');
    await confirm(id, { clientOperationId: randomUUID(), expectedVersion: v2.version, reviewToken: forged }).expect(409);
    const valid = signReview({ ...claims, exp: Date.now() + 60_000 }, secret);
    const [, sig] = valid.split('.');
    const tampered = `${Buffer.from(JSON.stringify({ ...claims, n: 999_999, exp: Date.now() + 60_000 })).toString('base64url')}.${sig}`;
    await confirm(id, { clientOperationId: randomUUID(), expectedVersion: v2.version, reviewToken: tampered }).expect(409);
    // Another super admin's review cannot be used.
    const theirs = (await review(id, v2.version, agents.root2).expect(200)).body as { reviewToken: string };
    await confirm(id, { clientOperationId: randomUUID(), expectedVersion: v2.version, reviewToken: theirs.reviewToken }).expect(409);

    // Audience grows after the review → new confirmation needed.
    const fresh = (await review(id, v2.version).expect(200)).body as { reviewToken: string };
    await customer('grown1');
    const res = await confirm(id, { clientOperationId: randomUUID(), expectedVersion: v2.version, reviewToken: fresh.reviewToken }).expect(409);
    expect(res.body.message).toMatch(/audience changed/);
    expect(await prisma.announcementSendRun.count({ where: { announcementId: id } })).toBe(0);
  });

  it('one run per announcement: replays return the same run, parallel or later confirmations do not create a second send', async () => {
    const mine = await customer('dupe');
    const { id, version } = await newDraft();
    const { reviewToken } = (await review(id, version).expect(200)).body as { reviewToken: string };
    const op = randomUUID();
    const [a, b, c] = await Promise.all([
      confirm(id, { clientOperationId: op, expectedVersion: version, reviewToken }),
      confirm(id, { clientOperationId: op, expectedVersion: version, reviewToken }),
      confirm(id, { clientOperationId: randomUUID(), expectedVersion: version, reviewToken }),
    ]);
    expect([a.status, b.status].sort((x, y) => x - y)).toEqual([202, 202]);
    expect(a.body.id).toBe(b.body.id);
    expect(c.status).toBe(409);
    expect(a.headers['cache-control']).toBe('no-store');
    expect(await prisma.announcementSendRun.count({ where: { announcementId: id } })).toBe(1);
    await confirm(id, { clientOperationId: op, expectedVersion: version + 1, reviewToken }).expect(409); // operation reuse
    const again = (await review(id, version).expect(200)).body as { reviewToken: string | null; blockers: { code: string }[] };
    expect(again.reviewToken).toBeNull();
    expect(again.blockers.map((x) => x.code)).toContain('already_sent');
    // Another announcement while this one is active: blocked (one active run at a time).
    const other = await newDraft();
    const o = (await review(other.id, other.version).expect(200)).body as { reviewToken: string | null; blockers: { code: string }[] };
    expect(o.blockers.map((x) => x.code)).toContain('run_in_progress');
    expect(o.reviewToken).toBeNull();
    // Duplicate jobs / concurrent drivers: one holds the lease, every customer gets one email.
    const [d1, d2] = await Promise.all([processor.drive(a.body.id), processor.drive(a.body.id)]);
    expect([d1, d2]).toContain('busy');
    await driveAll(a.body.id);
    expect(inbox.to(mine.email)).toHaveLength(1);
    const total = await prisma.announcementRunRecipient.count({ where: { runId: a.body.id, status: 'ACCEPTED' } });
    expect(inbox.sent).toHaveLength(total);
    expect(new Set(inbox.sent.map((m) => m.to)).size).toBe(total);
    const audit = await prisma.auditLog.findMany({ where: { subjectId: a.body.id }, orderBy: { createdAt: 'asc' } });
    expect(audit.map((r) => r.eventType)).toEqual(['ANNOUNCEMENT_BROADCAST_REQUESTED', 'ANNOUNCEMENT_BROADCAST_QUEUED', 'ANNOUNCEMENT_BROADCAST_FINISHED']);
    expect(JSON.stringify(audit)).not.toMatch(/Hello|Line one|@example\.test/);
  });

  it('snapshot, boundary, resume and send-time rechecks: edits never reach the email, late sign-ups are not added, changed people are skipped', async () => {
    const ok = await customer('ok');
    const willSuspend = await customer('suspend');
    const willChange = await customer('change');
    const willUnverify = await customer('unverify');
    const willDelete = await customer('delete');
    await customer('unverified', { emailVerifiedAt: null });
    const { id, version } = await newDraft('Original subject');
    const started = await queueRun(id, version);
    expect(started.status).toBe('PREPARING');
    let p = await progress(id, started.id);
    expect(p).toMatchObject({ status: 'PREPARING', prepared: 0, audiencePrepared: false });

    // Editing after confirmation is refused; the queued run keeps the reviewed content either way.
    await agents.root.put(api(`/admin/announcements/${id}`)).set('Origin', ORIGIN).send({ name: 'x', subject: 'Edited subject', body: 'Edited', expectedVersion: version }).expect(409);
    // Registered after the boundary: never added to this run.
    const late = await customer('late');

    // Interrupted preparation: two tiny batches, then a "crash"; the cursor is durable.
    processor.prepareBatchSize = 2;
    const p2 = processor as unknown as { prepareBatch(id: string): Promise<void> };
    await p2.prepareBatch(started.id);
    await p2.prepareBatch(started.id);
    const mid = await prisma.announcementSendRun.findUniqueOrThrow({ where: { id: started.id } });
    expect(mid.prepareCursor).toBeTruthy();
    expect(mid.status).toBe('PREPARING');
    processor.prepareBatchSize = 500;
    await prepareAll(started.id);
    p = await progress(id, started.id);
    expect(p.audiencePrepared).toBe(true);
    expect(p.status).toBe('SENDING');
    expect(await recipient(started.id, late.id)).toBeNull();
    const unverifiedRow = await prisma.user.findUniqueOrThrow({ where: { email: at('unverified') } });
    expect(await recipient(started.id, unverifiedRow.id)).toBeNull();
    // Unique per run + user: resumed batches never duplicated anyone.
    expect(await prisma.announcementRunRecipient.count({ where: { runId: started.id, userId: ok.id } })).toBe(1);
    const prepared = await recipient(started.id, ok.id);
    expect(prepared?.emailHash).toBe(emailHash(ok.email));
    expect(JSON.stringify(prepared)).not.toContain('@');

    // Changes between preparation and the send.
    await prisma.user.update({ where: { id: willSuspend.id }, data: { status: 'SUSPENDED' } });
    await prisma.user.update({ where: { id: willChange.id }, data: { email: at('changed-new') } });
    await prisma.user.update({ where: { id: willUnverify.id }, data: { emailVerifiedAt: null } });
    await prisma.user.update({ where: { id: willDelete.id }, data: { deletedAt: new Date(), status: 'DELETED' } });

    await driveAll(started.id);
    p = await progress(id, started.id);
    expect(p.status).toBe('COMPLETED');
    expect((await recipient(started.id, ok.id))?.status).toBe('ACCEPTED');
    expect((await recipient(started.id, willSuspend.id))).toMatchObject({ status: 'SKIPPED', reasonCode: 'account_unavailable', attemptCount: 1 });
    expect((await recipient(started.id, willChange.id))).toMatchObject({ status: 'SKIPPED', reasonCode: 'email_changed' });
    expect((await recipient(started.id, willUnverify.id))).toMatchObject({ status: 'SKIPPED', reasonCode: 'email_not_verified' });
    expect((await recipient(started.id, willDelete.id))).toMatchObject({ status: 'SKIPPED', reasonCode: 'account_unavailable' });
    expect(inbox.to(at('change'))).toHaveLength(0);
    expect(inbox.to(at('changed-new'))).toHaveLength(0); // never redirected to an unreviewed address
    const [email] = inbox.to(ok.email) as EmailMessage[];
    expect(email).toMatchObject({ kind: 'announcement', subject: 'Original subject' });
    expect(email!.html).toContain('Line one.');
    expect(email!.html).not.toContain('Edited');
    // Its own unsubscribe link, never the run's placeholder.
    expect(email!.html).toMatch(/href="https:\/\/app\.example\.test\/unsubscribe\?token=[\w-]+\.[\w-]+"/);
    expect(email!.html).not.toContain('__FA_UNSUBSCRIBE_');
    expect(email!.text).toMatch(/Unsubscribe: https:\/\/app\.example\.test\/unsubscribe\?token=/);
    // Accepted by the provider is never called delivered; no open/read states.
    expect(Object.keys(p.counts).sort()).toEqual(['ACCEPTED', 'CANCELLED', 'FAILED', 'PROCESSING', 'QUEUED', 'SKIPPED', 'UNKNOWN']);
    // No customer address in the aggregate (the requesting admin is shown as everywhere in the admin portal).
    expect(JSON.stringify(p)).not.toMatch(/deliver|opened/i);
    for (const c of [ok, willSuspend, willChange, willUnverify, willDelete]) expect(JSON.stringify(p)).not.toContain(c.email);
    expect(p.counts.ACCEPTED + p.counts.SKIPPED + p.counts.FAILED + p.counts.UNKNOWN).toBe(p.prepared);
    expect(p.lastUpdatedAt).toBeTruthy();
  });

  it('provider outcomes: permanent → FAILED once; timeout → UNKNOWN never retried; throttling honours Retry-After and stops after the limit', async () => {
    const perm = await customer('perm');
    const timeout = await customer('timeout');
    const throttled = await customer('throttled');
    const flaky = await customer('flaky');
    const { id, version } = await newDraft();
    const started = await queueRun(id, version);
    await prepareAll(started.id);
    inbox.failuresFor.set(perm.email, [new EmailSendError('ErrorInvalidRecipients', false)]);
    inbox.failuresFor.set(timeout.email, [new EmailSendError('timeout', true)]);
    inbox.failuresFor.set(flaky.email, Array.from({ length: MAX_ATTEMPTS }, () => new EmailSendError('unauthorized', true)));
    inbox.failuresFor.set(throttled.email, [new EmailSendError('rate_limit_exceeded', true, 120_000)]);

    // Run until throttled: the run pauses (lease held until Retry-After) and a second driver cannot start early.
    let out = await processor.drive(started.id);
    for (let i = 0; out === 'continue' && (await recipient(started.id, throttled.id))?.status !== 'QUEUED' && i < 50; i++) {
      await prisma.announcementSendRun.update({ where: { id: started.id }, data: { leaseUntil: null } });
      out = await processor.drive(started.id);
    }
    const t = await recipient(started.id, throttled.id);
    expect(t).toMatchObject({ status: 'QUEUED', reasonCode: 'rate_limit_exceeded', attemptCount: 1 });
    expect(t!.nextAttemptAt!.getTime() - Date.now()).toBeGreaterThan(100_000);
    const r = await prisma.announcementSendRun.findUniqueOrThrow({ where: { id: started.id } });
    expect(r.leaseUntil!.getTime()).toBe(t!.nextAttemptAt!.getTime());
    expect(await processor.drive(started.id)).toBe('busy');

    // Time passes (simulated): everything due again.
    await prisma.announcementRunRecipient.updateMany({ where: { runId: started.id, status: 'QUEUED' }, data: { nextAttemptAt: null } });
    for (let i = 0; i < MAX_ATTEMPTS + 2; i++) {
      await prisma.announcementSendRun.update({ where: { id: started.id }, data: { leaseUntil: null } });
      if ((await processor.drive(started.id)) === 'finished') break;
      await prisma.announcementRunRecipient.updateMany({ where: { runId: started.id, status: 'QUEUED' }, data: { nextAttemptAt: null } });
    }
    expect(await recipient(started.id, perm.id)).toMatchObject({ status: 'FAILED', reasonCode: 'ErrorInvalidRecipients', attemptCount: 1 });
    expect(await recipient(started.id, timeout.id)).toMatchObject({ status: 'UNKNOWN', reasonCode: 'timeout', attemptCount: 1 });
    expect(await recipient(started.id, flaky.id)).toMatchObject({ status: 'FAILED', reasonCode: 'unauthorized', attemptCount: MAX_ATTEMPTS });
    expect(await recipient(started.id, throttled.id)).toMatchObject({ status: 'ACCEPTED', attemptCount: 2 });
    expect(inbox.to(throttled.email)).toHaveLength(1);
    expect(inbox.to(timeout.email)).toHaveLength(0);
    const p = await progress(id, started.id);
    expect(p.reasons.FAILED).toMatchObject({ ErrorInvalidRecipients: 1, unauthorized: 1 });
    expect(p.reasons.UNKNOWN).toMatchObject({ timeout: 1 });
    // Spacing between provider attempts = 60 s / rate (10 per minute by default).
    expect(new Set(paused)).toEqual(new Set([6000]));
  });

  it('crash after a possible acceptance: the in-flight recipient becomes UNKNOWN and is never resent; a lost enqueue is recovered', async () => {
    const victim = await customer('crash');
    const { id, version } = await newDraft();
    // Redis down at confirmation: the run is committed anyway and the reconciler finds it.
    const add = vi.spyOn(queue.queue, 'add').mockRejectedValueOnce(new Error('redis down'));
    const started = await queueRun(id, version);
    add.mockRestore();
    expect(await prisma.announcementSendRun.count({ where: { id: started.id, status: 'PREPARING' } })).toBe(1);
    expect(await queue.enqueueIdle()).toBeGreaterThanOrEqual(1);
    expect((await queue.queue.getJobs(['delayed', 'waiting'])).some((j) => j.data.runId === started.id)).toBe(true);

    await prepareAll(started.id);
    // A driver claimed the victim and died after (maybe) handing it to the provider.
    await prisma.announcementRunRecipient.update({
      where: { runId_userId: { runId: started.id, userId: victim.id } },
      data: { status: 'PROCESSING', attemptCount: 1, attemptedAt: new Date() },
    });
    await prisma.announcementSendRun.update({ where: { id: started.id }, data: { leaseOwner: 'dead-worker', leaseUntil: new Date(Date.now() + 60_000) } });
    expect(await processor.drive(started.id)).toBe('busy'); // lease still valid
    await prisma.announcementSendRun.update({ where: { id: started.id }, data: { leaseUntil: new Date(Date.now() - 1) } });
    await driveAll(started.id);
    expect(await recipient(started.id, victim.id)).toMatchObject({ status: 'UNKNOWN', reasonCode: 'worker_interrupted', attemptCount: 1 });
    expect(inbox.to(victim.email)).toHaveLength(0);
  });

  it('stop: pending recipients are cancelled before any attempt, the in-flight send keeps its real outcome, history is kept', async () => {
    await customer('stop-a');
    await customer('stop-b');
    const { id, version } = await newDraft();
    const started = await queueRun(id, version);
    await prepareAll(started.id);
    // The stop arrives while one email is with the provider.
    const send = inbox.send.bind(inbox);
    let stopped = false;
    const spy = vi.spyOn(inbox, 'send').mockImplementation(async (m: EmailMessage) => {
      if (!stopped) {
        stopped = true;
        const res = await agents.root.post(api(`/admin/announcements/${id}/broadcasts/${started.id}/cancel`)).set('Origin', ORIGIN).expect(200);
        expect(res.body).toMatchObject({ stopping: true });
      }
      return send(m);
    });
    await driveAll(started.id);
    spy.mockRestore();
    const p = await progress(id, started.id);
    expect(p.status).toBe('CANCELLED');
    expect(p.stopping).toBe(false);
    expect(p.counts.ACCEPTED).toBe(1); // the in-flight one was not "recalled"
    expect(p.counts.CANCELLED).toBe(p.prepared - 1);
    expect(inbox.sent).toHaveLength(1);
    const accepted = await prisma.announcementRunRecipient.findFirstOrThrow({ where: { runId: started.id, status: 'ACCEPTED' } });
    expect(accepted.providerMessageId).toMatch(/^fake-/);
    // Repeated stop after the end: refused, records kept.
    await agents.root.post(api(`/admin/announcements/${id}/broadcasts/${started.id}/cancel`)).set('Origin', ORIGIN).expect(409);
    expect(await prisma.announcementRunRecipient.count({ where: { runId: started.id } })).toBe(p.prepared);
    const events = (await prisma.auditLog.findMany({ where: { subjectId: started.id } })).map((r) => r.eventType);
    expect(events).toEqual(expect.arrayContaining(['ANNOUNCEMENT_BROADCAST_CANCEL_REQUESTED', 'ANNOUNCEMENT_BROADCAST_FINISHED']));
    expect(events.filter((e) => e === 'ANNOUNCEMENT_BROADCAST_CANCEL_REQUESTED')).toHaveLength(1);
  });

  it('post-send monitoring: the list shows the run (not Draft), failures count as issues, the sent version is locked, results stay readable with the gate off, and reading never sends', async () => {
    const perm = await customer('post-perm');
    const { id, version } = await newDraft();
    const untouched = await newDraft();
    const started = await queueRun(id, version);
    await prepareAll(started.id);
    inbox.failuresFor.set(perm.email, [new EmailSendError('ErrorMessageSizeExceeded', false)]);
    await driveAll(started.id);
    const sent = inbox.sent.length;
    process.env.ANNOUNCEMENT_BROADCAST_ENABLED = 'false';

    type Item = { id: string; status: string; broadcast: { id: string; status: string; audience: string; issues: number } | null };
    const items = (await agents.root.get(api('/admin/announcements?page=1&limit=100')).expect(200)).body.items as Item[];
    const item = items.find((i) => i.id === id)!;
    expect(item.broadcast).toMatchObject({ id: started.id, status: 'COMPLETED', audience: 'ALL_ELIGIBLE' });
    expect(items.find((i) => i.id === untouched.id)!.broadcast).toBeNull();
    const p = await progress(id, started.id);
    expect(p.counts.FAILED).toBeGreaterThanOrEqual(1);
    // Counts reconcile: every prepared recipient is in exactly one state, and the list's issues are the non-accepted finals.
    expect(Object.values(p.counts).reduce((a, b) => a + b, 0)).toBe(p.prepared);
    expect(item.broadcast!.issues).toBe(p.counts.FAILED + p.counts.UNKNOWN + p.counts.SKIPPED + p.counts.CANCELLED);

    // The queued version is the record of what was sent: no edits after a run.
    const edit = await agents.root
      .put(api(`/admin/announcements/${id}`))
      .set('Origin', ORIGIN)
      .send({ name: 'Changed', subject: 'Changed', body: 'Changed.', expectedVersion: version })
      .expect(409);
    expect(edit.body.message).toMatch(/can no longer be edited/);
    expect((await prisma.emailAnnouncement.findUniqueOrThrow({ where: { id } })).version).toBe(version);

    // Monitoring stays SUPER_ADMIN-only.
    await request(app.getHttpServer()).get(api('/admin/announcements')).expect(401);
    await agents.admin.get(api('/admin/announcements')).expect(403);
    await agents.admin.get(api(`/admin/announcements/${id}/broadcasts/${started.id}`)).expect(403);
    // Reading results (repeatedly) never queues, resends or creates anything.
    await progress(id, started.id);
    expect(inbox.sent).toHaveLength(sent);
    expect(await prisma.announcementSendRun.count({ where: { announcementId: id } })).toBe(1);
  });

  it('provider acceptance followed by a database failure: never a send failure, never retryable, never resent', async () => {
    const victim = await customer('accepted-dbfail');
    const { id, version } = await newDraft();
    const started = await queueRun(id, version);
    await prepareAll(started.id);
    // Everyone else waits, so the victim is the next (and only) send of this slice.
    await prisma.announcementRunRecipient.updateMany({ where: { runId: started.id, NOT: { userId: victim.id } }, data: { nextAttemptAt: new Date(Date.now() + 3_600_000) } });
    const real = prisma.announcementRunRecipient.updateMany.bind(prisma.announcementRunRecipient);
    const spy = vi
      .spyOn(prisma.announcementRunRecipient, 'updateMany')
      .mockImplementation(((args: { data: { status?: string } }) => (args.data.status === 'ACCEPTED' ? Promise.reject(new Error('connection lost')) : real(args as never))) as never);
    try {
      await expect(processor.drive(started.id)).rejects.toThrow('connection lost');
    } finally {
      spy.mockRestore();
    }
    expect(inbox.to(victim.email)).toHaveLength(1);
    // Not FAILED: the provider took it. Left claimed, so the next lease holder settles it conservatively.
    const held = await recipient(started.id, victim.id);
    expect(held).toMatchObject({ status: 'PROCESSING', attemptCount: 1 });

    await prisma.announcementRunRecipient.updateMany({ where: { runId: started.id }, data: { nextAttemptAt: null } });
    await prisma.announcementSendRun.update({ where: { id: started.id }, data: { leaseUntil: null } });
    await driveAll(started.id);
    const settled = await recipient(started.id, victim.id);
    expect(settled).toMatchObject({ status: 'UNKNOWN', reasonCode: 'worker_interrupted', attemptCount: 1 });
    expect(inbox.to(victim.email)).toHaveLength(1);
    // No manual path back to the provider either.
    const retry = (await agents.root.post(api(`/admin/announcements/${id}/broadcasts/${started.id}/retry-review`)).set('Origin', ORIGIN).send({ recipientId: settled!.id }).expect(200)).body as { count: number };
    expect(retry.count).toBe(0);
  });

  it('a throw from the provider that is not a classified failure proves nothing: UNKNOWN, never FAILED or retried', async () => {
    const odd = await customer('unclassified');
    const { id, version } = await newDraft();
    const started = await queueRun(id, version);
    await prepareAll(started.id);
    inbox.failuresFor.set(odd.email, [new Error('adapter bug') as EmailSendError]);
    await driveAll(started.id);
    expect(await recipient(started.id, odd.id)).toMatchObject({ status: 'UNKNOWN', reasonCode: 'unknown_error', attemptCount: 1 });
    expect(inbox.to(odd.email)).toHaveLength(0);
  });

  describe('results and safe manual retry', () => {
    type Row = { id: string; email: string | null; status: string; reasonCode: string | null; attemptCount: number; retryable: boolean; retryBlockedReason: string | null };
    const base = (id: string, runId: string) => api(`/admin/announcements/${id}/broadcasts/${runId}`);
    const rows = async (id: string, runId: string, query: string, agent = agents.root) =>
      (await agent.get(base(id, runId) + '/recipients?' + query).expect(200)).body as { items: Row[]; pagination: { total: number } };
    const reviewRetry = (id: string, runId: string, body: object = {}, agent = agents.root) =>
      agent.post(base(id, runId) + '/retry-review').set('Origin', ORIGIN).send(body);
    const confirmRetry = (id: string, runId: string, body: object, agent = agents.root) =>
      agent.post(base(id, runId) + '/retries').set('Origin', ORIGIN).send(body);
    /** Drives to the end, treating every throttling backoff as already over. */
    const driveThroughBackoff = async (runId: string) => {
      for (let i = 0; i < 200; i++) {
        const { status } = await prisma.announcementSendRun.findUniqueOrThrow({ where: { id: runId } });
        if (!['PREPARING', 'SENDING'].includes(status)) return;
        await prisma.announcementRunRecipient.updateMany({ where: { runId, status: 'QUEUED' }, data: { nextAttemptAt: null } });
        await prisma.announcementSendRun.update({ where: { id: runId }, data: { leaseUntil: null } });
        await processor.drive(runId);
      }
      throw new Error('run did not finish');
    };
    const signInFailures = () => Array.from({ length: MAX_ATTEMPTS }, () => new EmailSendError('unauthorized', true));

    it('recipient results: states, safe reasons, retry eligibility per rule, unchanged-address display, search and pagination; readable with the gate off', async () => {
      const ok = await customer('res-ok');
      const transient = await customer('res-transient');
      const perm = await customer('res-perm');
      const unknown = await customer('res-unknown');
      const optedOut = await customer('res-optout');
      const moved = await customer('res-moved');
      const suppressed = await customer('res-suppressed');
      const capped = await customer('res-capped');
      const { id, version } = await newDraft();
      const started = await queueRun(id, version);
      await prepareAll(started.id);
      for (const c of [transient, optedOut, moved, suppressed, capped]) inbox.failuresFor.set(c.email, signInFailures());
      inbox.failuresFor.set(perm.email, [new EmailSendError('ErrorMessageRejected', false)]);
      inbox.failuresFor.set(unknown.email, [new EmailSendError('timeout', true)]);
      await driveThroughBackoff(started.id);
      // After the run: consent withdrawn, address changed, address suppressed, attempts at the limit.
      await prisma.user.update({ where: { id: optedOut.id }, data: { marketingConsentAt: null } });
      await prisma.user.update({ where: { id: moved.id }, data: { email: at('res-moved-new') } });
      await prisma.emailSuppression.create({ data: { emailHash: emailHash(suppressed.email), reason: 'UNSUBSCRIBED' } });
      await prisma.announcementRunRecipient.updateMany({ where: { runId: started.id, userId: capped.id }, data: { attemptCount: 5 } });

      const all = await rows(id, started.id, 'q=bcast.res-&limit=100');
      const byEmail = (email: string) => all.items.find((r) => r.email === email);
      expect(all.pagination.total).toBe(8);
      expect(byEmail(ok.email)).toMatchObject({ status: 'ACCEPTED', retryable: false, retryBlockedReason: null });
      expect(byEmail(transient.email)).toMatchObject({ status: 'FAILED', reasonCode: 'unauthorized', attemptCount: MAX_ATTEMPTS, retryable: true });
      expect(byEmail(perm.email)).toMatchObject({ status: 'FAILED', retryable: false, retryBlockedReason: 'permanent_failure' });
      expect(byEmail(unknown.email)).toMatchObject({ status: 'UNKNOWN', reasonCode: 'timeout', retryable: false });
      expect(byEmail(optedOut.email)).toMatchObject({ retryable: false, retryBlockedReason: 'no_consent' });
      expect(byEmail(suppressed.email)).toMatchObject({ retryable: false, retryBlockedReason: 'suppressed' });
      expect(byEmail(capped.email)).toMatchObject({ retryable: false, retryBlockedReason: 'retry_limit_reached' });
      // The changed account: its new address is never shown as the destination.
      expect(all.items.filter((r) => r.email === null)).toEqual([expect.objectContaining({ retryable: false, retryBlockedReason: 'email_changed' })]);
      expect(JSON.stringify(all)).not.toContain(at('res-moved-new'));
      // Server-side filter and pagination.
      const failed = await rows(id, started.id, 'q=bcast.res-&status=FAILED&limit=2&page=2');
      expect(failed.pagination.total).toBe(6);
      expect(failed.items).toHaveLength(2);
      expect(failed.items.every((r) => r.status === 'FAILED')).toBe(true);

      // The email as queued (snapshot), with no personal unsubscribe token.
      const email = (await agents.root.get(base(id, started.id) + '/email').expect(200)).body as { subject: string; html: string };
      expect(email.subject).toBe('Hello <customers> & friends');
      expect(email.html).toContain(`${ORIGIN}/unsubscribe"`);
      expect(email.html).not.toMatch(/__FA_UNSUBSCRIBE_|token=/);

      // Access: SUPER_ADMIN with MFA only.
      const anon = request(app.getHttpServer());
      await anon.get(base(id, started.id) + '/recipients').expect(401);
      await agents.admin.get(base(id, started.id) + '/recipients').expect(403);
      await agents.admin.get(base(id, started.id) + '/email').expect(403);
      await reviewRetry(id, started.id, {}, agents.admin).expect(403);
      await confirmRetry(id, started.id, { clientOperationId: randomUUID(), setHash: 'a'.repeat(64) }, agents.admin).expect(403);
      await agents.root.get(base(id, started.id) + '/recipients?status=DELIVERED').expect(400);

      // Gate off: results stay readable; retry is refused and says why.
      process.env.ANNOUNCEMENT_BROADCAST_ENABLED = 'false';
      const off = (await agents.root.get(base(id, started.id)).expect(200)).body as { status: string; retry: { eligible: number; blockedReason: string } };
      expect(off).toMatchObject({ status: 'COMPLETED', retry: { eligible: 1, blockedReason: 'broadcast_disabled' } });
      const offReview = (await reviewRetry(id, started.id).expect(200)).body as { count: number; setHash: string; blockers: { code: string }[] };
      expect(offReview.blockers.map((b) => b.code)).toEqual(['broadcast_disabled']);
      await confirmRetry(id, started.id, { clientOperationId: randomUUID(), setHash: offReview.setHash }).expect(409);
      // Pilot-only server: an all-eligible run cannot be retried.
      process.env.ANNOUNCEMENT_BROADCAST_ENABLED = 'pilot';
      expect(((await reviewRetry(id, started.id).expect(200)).body as { blockers: { code: string }[] }).blockers.map((b) => b.code)).toEqual(['pilot_only']);
      await confirmRetry(id, started.id, { clientOperationId: randomUUID(), setHash: offReview.setHash }).expect(409);
      // A non-retryable recipient on its own: nothing to retry.
      const permRow = byEmail(perm.email)!;
      process.env.ANNOUNCEMENT_BROADCAST_ENABLED = 'true';
      const one = (await reviewRetry(id, started.id, { recipientId: permRow.id }).expect(200)).body as { count: number; blockers: { code: string }[] };
      expect(one).toMatchObject({ count: 0, blockers: [{ code: 'nothing_to_retry' }] });
      expect(inbox.to(transient.email)).toHaveLength(0);
      expect(await prisma.announcementRetry.count({ where: { runId: started.id } })).toBe(0);
    });

    it('manual retry: the exact reviewed set, once (double click, two operators, duplicate jobs), after completion, same content, history kept', async () => {
      const transient = await customer('rt-transient');
      const { id, version } = await newDraft('Retry snapshot subject');
      const started = await queueRun(id, version);
      await prepareAll(started.id);
      inbox.failuresFor.set(transient.email, signInFailures());
      await driveThroughBackoff(started.id);
      const before = await prisma.announcementSendRun.findUniqueOrThrow({ where: { id: started.id } });
      expect(before.status).toBe('COMPLETED');
      const failedRow = (await rows(id, started.id, `q=${encodeURIComponent(transient.email)}`)).items[0]!;
      expect(failedRow).toMatchObject({ status: 'FAILED', retryable: true });

      const review = (await reviewRetry(id, started.id).expect(200)).body as { count: number; setHash: string; scope: string; subject: string; announcementVersion: number; blockers: unknown[] };
      expect(review).toMatchObject({ count: 1, scope: 'ALL', subject: 'Retry snapshot subject', announcementVersion: version, blockers: [] });
      // A stale or forged set is refused.
      await confirmRetry(id, started.id, { clientOperationId: randomUUID(), setHash: 'b'.repeat(64) }).expect(409);
      await confirmRetry(id, started.id, { clientOperationId: randomUUID(), setHash: review.setHash, recipients: [transient.id] }).expect(400);

      // Double click (same operation id) + a second operator at the same moment: one retry request.
      const op = randomUUID();
      const [a, b, c] = await Promise.all([
        confirmRetry(id, started.id, { clientOperationId: op, setHash: review.setHash }),
        confirmRetry(id, started.id, { clientOperationId: op, setHash: review.setHash }),
        confirmRetry(id, started.id, { clientOperationId: randomUUID(), setHash: review.setHash }, agents.root2),
      ]);
      expect(a.status).toBe(202);
      expect(b.status).toBe(202);
      expect(b.body.retryId).toBe(a.body.retryId);
      expect(c.status).toBe(409);
      expect(await prisma.announcementRetry.count({ where: { runId: started.id } })).toBe(1);

      // Reopened for the worker; the earlier completion is kept with the retry.
      const reopened = await prisma.announcementSendRun.findUniqueOrThrow({ where: { id: started.id } });
      expect(reopened).toMatchObject({ status: 'SENDING', completedAt: null });
      const retry = await prisma.announcementRetry.findFirstOrThrow({ where: { runId: started.id }, include: { items: true } });
      expect(retry).toMatchObject({ previousRunStatus: 'COMPLETED', previousCompletedAt: before.completedAt, recipientCount: 1, scope: 'ALL' });
      expect(retry.items).toEqual([expect.objectContaining({ recipientId: failedRow.id, previousReasonCode: 'unauthorized', previousAttemptCount: MAX_ATTEMPTS })]);
      expect(await recipient(started.id, transient.id)).toMatchObject({ status: 'QUEUED', reasonCode: 'manual_retry', attemptCount: MAX_ATTEMPTS });
      // Progress counts recipients, not attempts.
      const during = await progress(id, started.id);
      expect(Object.values(during.counts).reduce((x, y) => x + y, 0)).toBe(during.prepared);
      expect(during.reasons.QUEUED).toMatchObject({ manual_retry: 1 });

      // Duplicate jobs: two drivers at once; the lease lets only one act.
      const sentBefore = inbox.to(transient.email).length;
      await Promise.all([processor.drive(started.id), processor.drive(started.id)]);
      await driveAll(started.id);
      const sent = inbox.to(transient.email);
      expect(sent).toHaveLength(sentBefore + 1);
      expect(sent.at(-1)!.subject).toBe('Retry snapshot subject');
      expect(await recipient(started.id, transient.id)).toMatchObject({ status: 'ACCEPTED', attemptCount: MAX_ATTEMPTS + 1 });
      const after = await progress(id, started.id);
      expect(after.status).toBe('COMPLETED');

      // Nothing left to retry; history and audit are kept.
      const again = (await reviewRetry(id, started.id).expect(200)).body as { count: number; blockers: { code: string }[] };
      expect(again).toMatchObject({ count: 0, blockers: [{ code: 'nothing_to_retry' }] });
      const detail = (await agents.root.get(base(id, started.id) + '/recipients/' + failedRow.id).expect(200)).body as {
        status: string;
        providerReference: boolean;
        history: { previousReasonCode: string; previousAttemptCount: number }[];
      };
      expect(detail).toMatchObject({ status: 'ACCEPTED', providerReference: true, history: [{ previousReasonCode: 'unauthorized', previousAttemptCount: MAX_ATTEMPTS }] });
      const events = (await prisma.auditLog.findMany({ where: { subjectId: started.id } })).map((r) => r.eventType);
      expect(events.filter((e) => e === 'ANNOUNCEMENT_BROADCAST_RETRY_REQUESTED')).toHaveLength(1);
      expect(events.filter((e) => e === 'ANNOUNCEMENT_BROADCAST_FINISHED')).toHaveLength(2);
    });

    it('a retry confirmed just before the run completes is not stranded: completion waits for it and it is sent once', async () => {
      const racer = await customer('rt-race');
      const { id, version } = await newDraft();
      const started = await queueRun(id, version);
      await prepareAll(started.id);
      inbox.failuresFor.set(racer.email, signInFailures());
      const p = processor as unknown as { finish(...a: unknown[]): Promise<boolean> };
      const real = p.finish.bind(processor);
      let confirmed = 0;
      const spy = vi.spyOn(p, 'finish').mockImplementationOnce(async (...a: unknown[]) => {
        // The worker has seen nothing left to do and is about to complete the run: the operator's retry lands here.
        const r = (await reviewRetry(id, started.id).expect(200)).body as { count: number; setHash: string };
        expect(r.count).toBe(1);
        await confirmRetry(id, started.id, { clientOperationId: randomUUID(), setHash: r.setHash }).expect(202);
        confirmed += 1;
        return real(...a);
      });
      try {
        await driveThroughBackoff(started.id);
      } finally {
        spy.mockRestore();
      }
      expect(confirmed).toBe(1);
      expect(await recipient(started.id, racer.id)).toMatchObject({ status: 'ACCEPTED', attemptCount: MAX_ATTEMPTS + 1 });
      expect(inbox.to(racer.email)).toHaveLength(1);
      const done = await prisma.announcementSendRun.findUniqueOrThrow({ where: { id: started.id } });
      expect(done.status).toBe('COMPLETED');
      expect(await prisma.announcementRunRecipient.count({ where: { runId: started.id, status: 'QUEUED' } })).toBe(0);
    });

    it('recipients blocked by today\'s rules do not hide eligible ones behind the batch limit; review and confirmation agree', async () => {
      const { id, version } = await newDraft();
      const started = await queueRun(id, version);
      await driveAll(started.id);
      // More blocked rows than one page, all sorting before the one that can be retried.
      const blockedIds = Array.from({ length: RETRY_BATCH_MAX + 3 }, () => randomUUID());
      await prisma.user.createMany({ data: blockedIds.map((uid, i) => ({ id: uid, email: at(`blocked${i}`), passwordHash: 'x', role: 'CUSTOMER', emailVerifiedAt: new Date() })) });
      ids.push(...blockedIds);
      const eligible = await customer('rt-after-blocked');
      const row = (userId: string, email: string, recipientId: string) => ({ id: recipientId, runId: started.id, userId, emailHash: emailHash(email), status: 'FAILED' as const, reasonCode: 'unauthorized', attemptCount: MAX_ATTEMPTS });
      await prisma.announcementRunRecipient.createMany({
        data: [
          ...blockedIds.map((uid, i) => row(uid, at(`blocked${i}`), `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`)),
          row(eligible.id, eligible.email, 'ffffffff-0000-4000-8000-000000000000'),
        ],
      });
      const r = (await reviewRetry(id, started.id).expect(200)).body as { count: number; setHash: string };
      expect(r.count).toBe(1);
      await confirmRetry(id, started.id, { clientOperationId: randomUUID(), setHash: r.setHash }).expect(202);
      expect(await recipient(started.id, eligible.id)).toMatchObject({ status: 'QUEUED', reasonCode: 'manual_retry' });
      // Every blocked row kept its outcome; the worker still rechecks at send time.
      expect(await prisma.announcementRunRecipient.count({ where: { runId: started.id, status: 'FAILED', userId: { in: blockedIds } } })).toBe(blockedIds.length);
      await driveThroughBackoff(started.id);
      expect(inbox.to(eligible.email)).toHaveLength(1);
      await prisma.announcementRunRecipient.deleteMany({ where: { runId: started.id } });
      await prisma.user.deleteMany({ where: { id: { in: blockedIds } } });
    }, 120_000);

    it('a manual retry never overlaps automatic retries or other states: only FAILED rows qualify, and an unknown outcome is never retried', async () => {
      const waiting = await customer('rt-waiting');
      const unknown = await customer('rt-unknown');
      const { id, version } = await newDraft();
      const started = await queueRun(id, version);
      await prepareAll(started.id);
      inbox.failuresFor.set(waiting.email, [new EmailSendError('rate_limit_exceeded', true, 120_000)]);
      inbox.failuresFor.set(unknown.email, [new EmailSendError('network_error', true)]);
      for (let i = 0; i < 50 && (await recipient(started.id, waiting.id))?.reasonCode !== 'rate_limit_exceeded'; i++) {
        await prisma.announcementSendRun.update({ where: { id: started.id }, data: { leaseUntil: null } });
        await processor.drive(started.id);
      }
      // Waiting for its automatic retry (QUEUED with a backoff): not a manual-retry candidate.
      expect(await recipient(started.id, waiting.id)).toMatchObject({ status: 'QUEUED', reasonCode: 'rate_limit_exceeded' });
      const r = (await reviewRetry(id, started.id).expect(200)).body as { count: number };
      expect(r.count).toBe(0);
      await driveThroughBackoff(started.id);
      expect(await recipient(started.id, unknown.id)).toMatchObject({ status: 'UNKNOWN' });
      const unknownRow = (await rows(id, started.id, `q=${encodeURIComponent(unknown.email)}`)).items[0]!;
      expect(unknownRow).toMatchObject({ status: 'UNKNOWN', retryable: false });
      const one = (await reviewRetry(id, started.id, { recipientId: unknownRow.id }).expect(200)).body as { count: number };
      expect(one.count).toBe(0);
      expect(inbox.to(unknown.email)).toHaveLength(0);
    });
  });

  it('capacity: own queue (not email-delivery), and the daily broadcast limit pauses a run without any provider attempt', async () => {
    expect(queue.settings.queueName).not.toBe(process.env.EMAIL_QUEUE_NAME);
    await customer('daily');
    const { id, version } = await newDraft();
    const started = await queueRun(id, version);
    await prepareAll(started.id);
    const settings = queue.settings as { dailyLimit: number };
    const before = settings.dailyLimit;
    settings.dailyLimit = 0; // limit already reached
    try {
      expect(await processor.drive(started.id)).toBe('continue');
      expect(inbox.sent).toHaveLength(0);
      const r = await prisma.announcementSendRun.findUniqueOrThrow({ where: { id: started.id } });
      expect(r.leaseUntil!.getTime() - Date.now()).toBeGreaterThan(10 * 60_000);
      expect(r.status).toBe('SENDING');
    } finally {
      settings.dailyLimit = before;
    }
  });

  // ─── Step 5 verification ──────────────────────────────────────────────────

  it('stop during audience preparation: preparation ends, nothing is sent, a repeated stop is a no-op (one audit row)', async () => {
    await customer('prep-stop-a');
    await customer('prep-stop-b');
    const { id, version } = await newDraft();
    const started = await queueRun(id, version);
    processor.prepareBatchSize = 1;
    await (processor as unknown as { prepareBatch(id: string): Promise<void> }).prepareBatch(started.id);
    const stop = () => agents.root.post(api(`/admin/announcements/${id}/broadcasts/${started.id}/cancel`)).set('Origin', ORIGIN);
    expect((await stop().expect(200)).body).toMatchObject({ status: 'PREPARING', stopping: true });
    await stop().expect(200); // still stopping: idempotent
    await driveAll(started.id);
    const p = await progress(id, started.id);
    expect(p).toMatchObject({ status: 'CANCELLED', audiencePrepared: false, stopping: false });
    expect(p.prepared).toBe(1); // no further batch after the stop
    expect(p.counts.CANCELLED).toBe(1);
    expect(inbox.sent).toHaveLength(0);
    const events = (await prisma.auditLog.findMany({ where: { subjectId: started.id } })).map((r) => r.eventType);
    expect(events.filter((e) => e === 'ANNOUNCEMENT_BROADCAST_CANCEL_REQUESTED')).toHaveLength(1);
    expect(events).toContain('ANNOUNCEMENT_BROADCAST_FINISHED');
    expect(events).not.toContain('ANNOUNCEMENT_BROADCAST_QUEUED');
  });

  it('graceful shutdown mid-run: the in-flight email is recorded, the rest stay QUEUED, and a new driver resumes without duplicates', async () => {
    await customer('shutdown-a');
    await customer('shutdown-b');
    await customer('shutdown-c');
    const { id, version } = await newDraft();
    const started = await queueRun(id, version);
    await prepareAll(started.id);
    const state = processor as unknown as { stopping: boolean };
    const send = inbox.send.bind(inbox);
    const spy = vi.spyOn(inbox, 'send').mockImplementationOnce(async (m: EmailMessage) => {
      state.stopping = true; // SIGTERM arrives while this email is with the provider
      return send(m);
    });
    try {
      expect(await processor.drive(started.id)).toBe('continue');
    } finally {
      state.stopping = false;
      spy.mockRestore();
    }
    expect(inbox.sent).toHaveLength(1);
    expect(await prisma.announcementRunRecipient.count({ where: { runId: started.id, status: 'PROCESSING' } })).toBe(0);
    expect(await prisma.announcementRunRecipient.count({ where: { runId: started.id, status: 'ACCEPTED' } })).toBe(1);
    await prisma.announcementSendRun.update({ where: { id: started.id }, data: { leaseUntil: null } });
    await driveAll(started.id);
    const accepted = await prisma.announcementRunRecipient.count({ where: { runId: started.id, status: 'ACCEPTED' } });
    expect(inbox.sent).toHaveLength(accepted);
    expect(new Set(inbox.sent.map((m) => m.to)).size).toBe(accepted); // nobody twice
  });

  it('database failure after the claim but before the provider: the recipient goes back to QUEUED (not UNKNOWN), no fake success, sent once later', async () => {
    const victim = await customer('dbblip');
    const { id, version } = await newDraft();
    const started = await queueRun(id, version);
    await prepareAll(started.id);
    // Make the victim the next claim, then fail its pre-send recheck once.
    await prisma.announcementRunRecipient.updateMany({ where: { runId: started.id, NOT: { userId: victim.id } }, data: { nextAttemptAt: new Date(Date.now() + 3_600_000) } });
    const spy = vi.spyOn(prisma.user, 'findUnique').mockImplementationOnce((() => Promise.reject(new Error('connection lost'))) as never);
    try {
      await expect(processor.drive(started.id)).rejects.toThrow('connection lost');
    } finally {
      spy.mockRestore();
    }
    expect(await recipient(started.id, victim.id)).toMatchObject({ status: 'QUEUED', attemptCount: 0 });
    expect(inbox.sent).toHaveLength(0);
    // The lease holds off a second driver briefly (no tight retry loop), then the run resumes.
    const r = await prisma.announcementSendRun.findUniqueOrThrow({ where: { id: started.id } });
    expect(r.leaseUntil!.getTime()).toBeGreaterThan(Date.now());
    expect(await processor.drive(started.id)).toBe('busy');
    await prisma.announcementRunRecipient.updateMany({ where: { runId: started.id }, data: { nextAttemptAt: null } });
    await prisma.announcementSendRun.update({ where: { id: started.id }, data: { leaseUntil: null } });
    await driveAll(started.id);
    expect(await recipient(started.id, victim.id)).toMatchObject({ status: 'ACCEPTED', attemptCount: 1 });
    expect(inbox.to(victim.email)).toHaveLength(1);
  });

  it('an account hard-deleted between finding and claiming its recipient row is skipped; the run carries on (no slice failure)', async () => {
    const gone = await customer('vanish');
    const stays = await customer('stays');
    const { id, version } = await newDraft();
    const started = await queueRun(id, version);
    await prepareAll(started.id);
    const goneRow = (await recipient(started.id, gone.id))!;
    await prisma.user.delete({ where: { id: gone.id } }); // cascades to the recipient row
    // The claim's lookup still returns the row it saw just before the delete.
    vi.spyOn(prisma.announcementRunRecipient, 'findFirst').mockResolvedValueOnce({ id: goneRow.id } as never);
    await driveAll(started.id);
    expect(await recipient(started.id, stays.id)).toMatchObject({ status: 'ACCEPTED' });
    expect(inbox.to(gone.email)).toHaveLength(0);
    expect((await prisma.announcementSendRun.findUniqueOrThrow({ where: { id: started.id } })).status).toBe('COMPLETED');
  });

  it('paused runs say so: progress reports pausedUntil while waiting out Retry-After or the daily limit', async () => {
    await customer('paused');
    const { id, version } = await newDraft();
    const started = await queueRun(id, version);
    await prepareAll(started.id);
    const settings = queue.settings as { dailyLimit: number };
    const before = settings.dailyLimit;
    settings.dailyLimit = 0;
    try {
      expect(await processor.drive(started.id)).toBe('continue');
    } finally {
      settings.dailyLimit = before;
    }
    const p = (await agents.root.get(api(`/admin/announcements/${id}/broadcasts/${started.id}`)).expect(200)).body as { pausedUntil: string | null };
    expect(new Date(p.pausedUntil!).getTime()).toBeGreaterThan(Date.now() + 10 * 60_000);
  });

  it(`bounded throughput run (${LOAD_N} fictional customers, fake provider): batches, one send at a time, configured spacing`, async () => {
    const emails = Array.from({ length: LOAD_N }, (_, i) => at(`load${i}`));
    await prisma.user.createMany({
      data: emails.map((email) => ({ email, passwordHash: 'x', role: 'CUSTOMER' as const, emailVerifiedAt: new Date(), marketingConsentAt: new Date() })),
    });
    ids.push(...(await prisma.user.findMany({ where: { email: { in: emails } }, select: { id: true } })).map((u) => u.id));
    const { id, version } = await newDraft();
    const started = await queueRun(id, version);
    let inFlight = 0;
    let maxInFlight = 0;
    const send = inbox.send.bind(inbox);
    const spy = vi.spyOn(inbox, 'send').mockImplementation(async (m: EmailMessage) => {
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      try {
        await new Promise((r) => setTimeout(r, 2)); // a little provider latency
        return await send(m);
      } finally {
        inFlight--;
      }
    });
    try {
      const t0 = performance.now();
      await prepareAll(started.id);
      const t1 = performance.now();
      await driveAll(started.id);
      const t2 = performance.now();
      const p = await progress(id, started.id);
      const mine = await prisma.announcementRunRecipient.count({ where: { runId: started.id, user: { email: { in: emails } }, status: 'ACCEPTED' } });
      expect(mine).toBe(LOAD_N);
      expect(maxInFlight).toBe(1); // concurrency cap: one provider attempt at a time
      expect(paused.every((ms) => ms === 6000)).toBe(true); // 10/min default spacing between attempts
      expect(paused.length).toBe(p.counts.ACCEPTED + p.counts.FAILED + p.counts.UNKNOWN);
      // Real time would be ≥ attempts × 6 s (the pause is stubbed here); this is NOT a production capacity figure.
      process.stdout.write(
        `[bcast-load] customers=${LOAD_N} prepared=${p.prepared} prepareMs=${Math.round(t1 - t0)} sendLoopMs=${Math.round(t2 - t1)} attempts=${paused.length} maxInFlight=${maxInFlight} impliedMinutesAt10PerMin=${(paused.length / 10).toFixed(1)}\n`,
      );
    } finally {
      spy.mockRestore();
    }
  });
});
