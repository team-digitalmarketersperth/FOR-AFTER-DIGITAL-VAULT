import { ConfigModule } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { Job } from 'bullmq';
import session from 'express-session';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { adminSignIn } from './admin-sign-in.js';
import { FakeEmailProvider } from './fake-email.js';
import { AnnouncementTestProcessor } from '../src/announcements/announcement-test.processor.js';
import { AnnouncementTestQueue, announcementTestJobId, type AnnouncementTestJobData } from '../src/announcements/announcement-test-queue.service.js';
import { AnnouncementsModule } from '../src/announcements/announcements.module.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { configureApp } from '../src/config/app.setup.js';
import { EmailProvider, EmailSendError } from '../src/email/email-provider.js';
import { EmailModule } from '../src/email/email.module.js';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { RedisModule } from '../src/redis/redis.module.js';
import { RedisService } from '../src/redis/redis.service.js';

// Notification centre Step 2 on real HTTP, sessions, PostgreSQL, Redis and BullMQ.
// The email provider is the fake inbox: nothing reaches Microsoft Graph. The
// worker is closed after start-up so each run is driven explicitly (duplicate
// runs, crashes, retries). Fictional people and content only.
describe('Announcement test emails (e2e, PostgreSQL, provider mocked)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let processor: AnnouncementTestProcessor;
  let queue: AnnouncementTestQueue;
  const inbox = new FakeEmailProvider();
  const run = Date.now();
  const at = (n: string) => `anntest.${n}.${run}@example.test`;
  const emails = { cara: at('cara'), admin: at('admin'), root: at('root'), root2: at('root2'), root3: at('root3') };
  const password = 'StrongPassword123!';
  type Agent = ReturnType<typeof request.agent>;
  const agents = {} as Record<keyof typeof emails, Agent>;
  const ids = {} as Record<string, string>;
  const api = (p: string) => `/api/v1${p}`;
  const ORIGIN = 'https://app.example.test';
  const draftBody = { name: 'Test run', subject: 'Hello <friends> & family', body: 'First line.\nSecond line.\n\nNext paragraph.', ctaLabel: 'Open', ctaDestination: 'DASHBOARD' };
  const ENV = ['EMAIL_PROVIDER', 'APP_BASE_URL', 'FRONTEND_URL', 'THROTTLE_KEY_PREFIX', 'ANNOUNCEMENT_TEST_QUEUE_NAME', 'EMAIL_RECONCILE_INTERVAL_SECONDS'];

  const job = (testSendId: string, attemptsMade = 0) =>
    ({ data: { testSendId }, attemptsMade, opts: { attempts: 3 } }) as unknown as Job<AnnouncementTestJobData>;
  const newDraft = async (agent: Agent = agents.root) =>
    (await agent.post(api('/admin/announcements')).set('Origin', ORIGIN).send(draftBody).expect(201)).body as { id: string; version: number };
  const requestTest = (agent: Agent, id: string, body: object) =>
    agent.post(api(`/admin/announcements/${id}/test-sends`)).set('Origin', ORIGIN).send(body);
  const row = (id: string) => prisma.announcementTestSend.findUniqueOrThrow({ where: { id } });

  beforeAll(async () => {
    Object.assign(process.env, {
      EMAIL_PROVIDER: 'disabled',
      APP_BASE_URL: ORIGIN,
      FRONTEND_URL: ORIGIN,
      THROTTLE_KEY_PREFIX: `for_after:test_anntest_throttle:${run}:`,
      ANNOUNCEMENT_TEST_QUEUE_NAME: `announcement-test-e2e-${run}`,
      EMAIL_RECONCILE_INTERVAL_SECONDS: '3600',
    });
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule, RedisModule, AuthModule, AnnouncementsModule, EmailModule],
      providers: [AnnouncementTestProcessor],
    })
      .overrideProvider(EmailProvider)
      .useValue(inbox)
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app, new session.MemoryStore(), new session.MemoryStore());
    await app.init();
    prisma = app.get(PrismaService);
    processor = app.get(AnnouncementTestProcessor);
    queue = app.get(AnnouncementTestQueue);
    // Drive the worker by hand from here on.
    await (processor as unknown as { worker: { close: () => Promise<void> } }).worker.close();
    for (const [k, email] of Object.entries(emails)) {
      await request(app.getHttpServer()).post(api('/auth/register')).send({ email, password, firstName: k, lastName: 'Test' }).expect(201);
      ids[k] = (await prisma.user.findUniqueOrThrow({ where: { email } })).id;
    }
    await prisma.user.updateMany({ where: { email: { in: Object.values(emails) } }, data: { emailVerifiedAt: new Date() } });
    await prisma.user.update({ where: { id: ids.admin }, data: { role: 'ADMIN' } });
    await prisma.user.updateMany({ where: { id: { in: [ids.root, ids.root2, ids.root3] } }, data: { role: 'SUPER_ADMIN' } });
    agents.cara = request.agent(app.getHttpServer());
    await agents.cara.post(api('/auth/login')).send({ email: emails.cara, password }).expect(200);
    for (const k of ['admin', 'root', 'root2', 'root3'] as const) agents[k] = (await adminSignIn(app, emails[k], password)).agent;
    inbox.sent.length = 0; // registration emails
  });

  // This file's own throttle namespace: every test starts with a clean per-IP window.
  beforeEach(async () => {
    const redis = app.get(RedisService).client;
    for (const key of await redis.keys(`${process.env.THROTTLE_KEY_PREFIX}*`)) await redis.del(key);
  });

  afterAll(async () => {
    for (const k of ENV) delete process.env[k];
    const mine = { createdByUserId: { in: Object.values(ids) } };
    await prisma?.announcementTestSend.deleteMany({ where: { announcement: mine } });
    await prisma?.emailAnnouncement.deleteMany({ where: mine });
    await prisma?.user.deleteMany({ where: { email: { in: Object.values(emails) } } });
    await queue?.queue.obliterate({ force: true });
    await app?.close();
  });

  it('only a SUPER_ADMIN with an MFA session reaches test routes; a test is never addressed by the client', async () => {
    const { id, version } = await newDraft();
    const body = { clientOperationId: randomUUID(), expectedVersion: version };
    await request(app.getHttpServer()).post(api(`/admin/announcements/${id}/test-sends`)).send(body).expect(401);
    await request(app.getHttpServer()).get(api('/admin/announcements/test-destination')).expect(401);
    expect((await requestTest(agents.cara, id, body)).status).toBeGreaterThanOrEqual(401);
    await requestTest(agents.admin, id, body).expect(403);
    await agents.admin.get(api('/admin/announcements/test-destination')).expect(403);

    const dest = await agents.root.get(api('/admin/announcements/test-destination')).expect(200);
    expect(dest.body).toEqual({ email: emails.root });
    expect(dest.headers['cache-control']).toBe('no-store');
    for (const extra of [{ to: emails.cara }, { cc: emails.cara }, { bcc: emails.cara }, { accountId: ids.cara }, { recipients: [emails.cara] }]) {
      await requestTest(agents.root, id, { ...body, ...extra }).expect(400);
    }
    await requestTest(agents.root, id, { expectedVersion: version }).expect(400); // operation id required
    await agents.root.post(api(`/admin/announcements/${id}/test-sends`)).set('Origin', 'https://evil.example').send(body).expect(403);
    expect(await prisma.announcementTestSend.count({ where: { announcementId: id } })).toBe(0);
  });

  it('unverified account: no destination, request refused, nothing recorded or verified', async () => {
    const { id, version } = await newDraft(agents.root2);
    await prisma.user.update({ where: { id: ids.root2 }, data: { emailVerifiedAt: null } });
    try {
      expect((await agents.root2.get(api('/admin/announcements/test-destination')).expect(200)).body).toEqual({ email: null });
      const res = await requestTest(agents.root2, id, { clientOperationId: randomUUID(), expectedVersion: version }).expect(409);
      expect(res.body.message).toMatch(/not verified/);
      expect(await prisma.announcementTestSend.count({ where: { announcementId: id } })).toBe(0);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: ids.root2 } })).emailVerifiedAt).toBeNull();
    } finally {
      await prisma.user.update({ where: { id: ids.root2 }, data: { emailVerifiedAt: new Date() } });
    }
  });

  it('saved snapshot to the requester only, [TEST] subject and notice, escaped; later edits never reach the email; draft stays Draft', async () => {
    const { id, version } = await newDraft();
    const op = randomUUID();
    const res = await requestTest(agents.root, id, { clientOperationId: op, expectedVersion: version }).expect(202);
    expect(res.body).toMatchObject({ status: 'QUEUED', announcementVersion: version });
    expect(JSON.stringify(res.body)).not.toContain(emails.root); // status only
    const testId = res.body.id as string;
    const queued = await queue.queue.getJob(announcementTestJobId(testId));
    expect(queued?.data).toEqual({ testSendId: testId }); // the job carries the id only

    // An edit after the request was accepted must not change what is sent.
    await agents.root
      .put(api(`/admin/announcements/${id}`))
      .set('Origin', ORIGIN)
      .send({ ...draftBody, subject: 'Edited later', body: 'Edited body', expectedVersion: version })
      .expect(200);

    expect(await processor.process(job(testId))).toBe('accepted');
    expect(inbox.sent).toHaveLength(1);
    const [mail] = inbox.sent;
    expect(mail).toMatchObject({ kind: 'announcement-test', to: emails.root, subject: '[TEST] Hello <friends> & family' });
    expect(mail!.html).toContain('This is a test announcement. It has not been sent to customers.');
    expect(mail!.html).toContain('First line.<br>Second line.');
    expect(mail!.html).toContain('Hello &#60;friends&#62; &#38; family');
    expect(mail!.html).toContain(`href="${ORIGIN}/dashboard"`);
    expect(mail!.text).toContain('This is a test announcement. It has not been sent to customers.');
    expect(JSON.stringify(mail)).not.toContain('Edited');

    // A second run of the same job (duplicate execution) sends nothing.
    expect(await processor.process(job(testId))).toBe('skipped');
    expect(inbox.sent).toHaveLength(1);

    const status = await agents.root.get(api(`/admin/announcements/${id}/test-sends/${testId}`)).expect(200);
    expect(status.body).toMatchObject({ status: 'ACCEPTED', lastErrorCode: null });
    expect(status.body.acceptedAt).toBeTruthy();
    expect(Object.keys(status.body).sort()).toEqual(['acceptedAt', 'announcementVersion', 'createdAt', 'finishedAt', 'id', 'lastErrorCode', 'status']);
    await agents.root2.get(api(`/admin/announcements/${id}/test-sends/${testId}`)).expect(404); // another admin's test

    const draft = await agents.root.get(api(`/admin/announcements/${id}`)).expect(200);
    expect(draft.body).toMatchObject({ status: 'DRAFT', version: version + 1 });
    expect(draft.body.latestTest).toMatchObject({ id: testId, status: 'ACCEPTED' });
    expect((await agents.root2.get(api(`/admin/announcements/${id}`)).expect(200)).body.latestTest).toBeNull();

    const audits = await prisma.auditLog.findMany({ where: { subjectId: testId }, orderBy: { createdAt: 'asc' } });
    expect(audits.map((a) => [a.eventType, a.actorType])).toEqual([
      ['ANNOUNCEMENT_TEST_REQUESTED', 'SUPER_ADMIN'],
      ['ANNOUNCEMENT_TEST_COMPLETED', 'SYSTEM'],
    ]);
    expect(audits[0]!.metadata).toEqual({ announcementId: id, version, operationId: op });
    expect(audits[1]!.metadata).toEqual({ announcementId: id, version, requestedBy: ids.root, outcome: 'accepted', errorCategory: null });
    expect(JSON.stringify(audits)).not.toMatch(/Hello|friends|First line|anntest\./);
  });

  it('idempotency: a replayed or concurrent POST is one request; reuse for another version is a 409; stale version is a 409', async () => {
    const { id, version } = await newDraft();
    const op = randomUUID();
    const [a, b] = await Promise.all([
      requestTest(agents.root2, id, { clientOperationId: op, expectedVersion: version }),
      requestTest(agents.root2, id, { clientOperationId: op, expectedVersion: version }),
    ]);
    expect([a.status, b.status]).toEqual([202, 202]);
    expect(a.body.id).toBe(b.body.id);
    expect(await prisma.announcementTestSend.count({ where: { announcementId: id } })).toBe(1);
    // The same operation id belongs to its admin: another admin's identical id is a separate request.
    await requestTest(agents.root3, id, { clientOperationId: op, expectedVersion: version }).expect(202);
    expect(await prisma.announcementTestSend.count({ where: { announcementId: id } })).toBe(2);

    await agents.root2.put(api(`/admin/announcements/${id}`)).set('Origin', ORIGIN).send({ ...draftBody, expectedVersion: version }).expect(200);
    const reused = await requestTest(agents.root2, id, { clientOperationId: op, expectedVersion: version + 1 }).expect(409);
    expect(reused.body.message).toMatch(/already used/);
    const stale = await requestTest(agents.root2, id, { clientOperationId: randomUUID(), expectedVersion: version }).expect(409);
    expect(stale.body.message).toMatch(/saved draft has changed/);
    await requestTest(agents.root2, '00000000-0000-4000-8000-000000000000', { clientOperationId: randomUUID(), expectedVersion: 1 }).expect(404);
    expect(await prisma.announcementTestSend.count({ where: { announcementId: id } })).toBe(2);
  });

  it('provider outcomes: permanent → FAILED; ambiguous → UNKNOWN and never resent; provably-not-accepted → retried once accepted', async () => {
    const { id } = await newDraft();
    const make = async () =>
      (await prisma.announcementTestSend.create({
        data: { announcementId: id, announcementVersion: 1, requestedByUserId: ids.root3, clientOperationId: randomUUID(), toEmail: emails.root3, subject: 'S', body: 'B' },
      })).id;
    inbox.sent.length = 0;

    const permanent = await make();
    inbox.failures.push(new EmailSendError('mailbox_not_found', false));
    expect(await processor.process(job(permanent))).toBe('failed');
    expect(await row(permanent)).toMatchObject({ status: 'FAILED', lastErrorCode: 'mailbox_not_found', attemptCount: 1 });

    const ambiguous = await make();
    inbox.failures.push(new EmailSendError('timeout', true));
    expect(await processor.process(job(ambiguous))).toBe('unknown');
    expect(await row(ambiguous)).toMatchObject({ status: 'UNKNOWN', lastErrorCode: 'timeout' });
    expect(await processor.process(job(ambiguous, 1))).toBe('skipped'); // no blind retry

    const throttled = await make();
    inbox.failures.push(new EmailSendError('rate_limit_exceeded', true));
    await expect(processor.process(job(throttled))).rejects.toThrow('rate_limit_exceeded');
    expect(await row(throttled)).toMatchObject({ status: 'QUEUED', lastErrorCode: 'rate_limit_exceeded' });
    expect(await processor.process(job(throttled, 1))).toBe('accepted');
    expect(await row(throttled)).toMatchObject({ status: 'ACCEPTED', attemptCount: 2 });

    const exhausted = await make();
    inbox.failures.push(new EmailSendError('rate_limit_exceeded', true));
    expect(await processor.process(job(exhausted, 2))).toBe('failed'); // last attempt

    expect(inbox.sent).toHaveLength(1); // only the retried, provably-unsent one
    const outcomes = await prisma.auditLog.findMany({ where: { subjectId: { in: [permanent, ambiguous, throttled, exhausted] }, eventType: 'ANNOUNCEMENT_TEST_COMPLETED' } });
    expect(outcomes).toHaveLength(4); // one completion each, even with repeated runs
    expect(outcomes.map((o) => String((o.metadata as { errorCategory: string | null }).errorCategory)).sort()).toEqual(['mailbox_not_found', 'null', 'rate_limit_exceeded', 'timeout']);
  });

  it('provider acceptance followed by a database failure: not a failure, not retried; settled as UNKNOWN and sent once', async () => {
    const { id } = await newDraft();
    const testId = (await prisma.announcementTestSend.create({
      data: { announcementId: id, announcementVersion: 1, requestedByUserId: ids.root3, clientOperationId: randomUUID(), toEmail: emails.root3, subject: 'S', body: 'B' },
    })).id;
    inbox.sent.length = 0;
    const p = processor as unknown as { finish(...a: unknown[]): Promise<boolean> };
    const real = p.finish.bind(processor);
    const spy = vi.spyOn(p, 'finish').mockImplementation((...a: unknown[]) => (a[2] === 'ACCEPTED' ? Promise.reject(new Error('connection lost')) : real(...a)));
    try {
      await expect(processor.process(job(testId))).rejects.toThrow('connection lost');
    } finally {
      spy.mockRestore();
    }
    expect(inbox.sent).toHaveLength(1);
    expect(await prisma.announcementTestSend.findUniqueOrThrow({ where: { id: testId } })).toMatchObject({ status: 'PROCESSING' });
    // BullMQ's retry of the same job, once the database is back: an earlier attempt may have sent, so never again.
    expect(await processor.process(job(testId, 1))).toBe('unknown');
    expect(await prisma.announcementTestSend.findUniqueOrThrow({ where: { id: testId } })).toMatchObject({ status: 'UNKNOWN', lastErrorCode: 'worker_interrupted', attemptCount: 1 });
    expect(inbox.sent).toHaveLength(1);
  });

  it('crash recovery: a send interrupted mid-flight becomes UNKNOWN (not resent); a lost enqueue is re-queued', async () => {
    const { id } = await newDraft();
    inbox.sent.length = 0;
    const interrupted = (
      await prisma.announcementTestSend.create({
        data: { announcementId: id, announcementVersion: 1, requestedByUserId: ids.root3, clientOperationId: randomUUID(), toEmail: emails.root3, subject: 'S', body: 'B', status: 'PROCESSING' },
      })
    ).id;
    // Old enough for the reconciler (the worker died long ago).
    await prisma.$executeRaw`UPDATE "AnnouncementTestSend" SET "updatedAt" = "updatedAt" - interval '1 hour' WHERE id = ${interrupted}::uuid`;
    const lost = (
      await prisma.announcementTestSend.create({
        data: { announcementId: id, announcementVersion: 1, requestedByUserId: ids.root3, clientOperationId: randomUUID(), toEmail: emails.root3, subject: 'S', body: 'B' },
      })
    ).id;
    await prisma.$executeRaw`UPDATE "AnnouncementTestSend" SET "createdAt" = "createdAt" - interval '1 hour' WHERE id = ${lost}::uuid`;
    expect(await queue.queue.getJob(announcementTestJobId(lost))).toBeUndefined();

    await processor.reconcile();
    expect(await row(interrupted)).toMatchObject({ status: 'UNKNOWN', lastErrorCode: 'worker_interrupted' });
    expect((await queue.queue.getJob(announcementTestJobId(lost)))?.data).toEqual({ testSendId: lost });
    expect(inbox.sent).toHaveLength(0);
  });

  it('limits: 3 new tests per admin per 10 minutes (replays do not count), and a shared cap', async () => {
    const { id, version } = await newDraft(agents.root);
    // root has sent 1 accepted test above; root2 has 1; use a clean count for root3 via its own draft.
    const before = await prisma.announcementTestSend.count({ where: { requestedByUserId: ids.root, createdAt: { gte: new Date(Date.now() - 600_000) } } });
    let last = '';
    for (let i = before; i < 3; i++) {
      last = randomUUID();
      await requestTest(agents.root, id, { clientOperationId: last, expectedVersion: version }).expect(202);
    }
    await requestTest(agents.root, id, { clientOperationId: last, expectedVersion: version }).expect(202); // replay still answered
    const limited = await requestTest(agents.root, id, { clientOperationId: randomUUID(), expectedVersion: version }).expect(429);
    expect(limited.body.message).toMatch(/up to 3 test emails every 10 minutes/);

    // Shared cap: fill the window to 20 with rows from another admin, then root2 is refused too.
    const all = await prisma.announcementTestSend.count({ where: { createdAt: { gte: new Date(Date.now() - 600_000) } } });
    await prisma.announcementTestSend.createMany({
      data: Array.from({ length: Math.max(0, 20 - all) }, () => ({
        announcementId: id, announcementVersion: 1, requestedByUserId: ids.cara, clientOperationId: randomUUID(), toEmail: emails.cara, subject: 'S', body: 'B', status: 'ACCEPTED' as const,
      })),
    });
    const shared = await requestTest(agents.root2, id, { clientOperationId: randomUUID(), expectedVersion: version }).expect(429);
    expect(shared.body.message).toMatch(/Too many test emails/);
  });
});
