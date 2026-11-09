import { Logger } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { Job } from 'bullmq';
import session from 'express-session';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { adminSignIn } from './admin-sign-in.js';
import { FakeEmailProvider } from './fake-email.js';
import { AnnouncementPolicy, type PolicyBlocker } from '../src/announcements/announcement-audience.service.js';
import { AnnouncementBroadcastProcessor } from '../src/announcements/announcement-broadcast.processor.js';
import { AnnouncementBroadcastQueue } from '../src/announcements/announcement-broadcast-queue.service.js';
import { AnnouncementTestProcessor } from '../src/announcements/announcement-test.processor.js';
import { AnnouncementTestQueue, type AnnouncementTestJobData } from '../src/announcements/announcement-test-queue.service.js';
import { AnnouncementsModule } from '../src/announcements/announcements.module.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { configureApp } from '../src/config/app.setup.js';
import { EmailProvider } from '../src/email/email-provider.js';
import { EmailModule } from '../src/email/email.module.js';
import { MessagesModule } from '../src/messages/messages.module.js';
import type { OtpDeliveryInput } from '../src/otp-auth/otp-auth.service.js';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { RecipientAuthModule } from '../src/recipient-auth/recipient-auth.module.js';
import { RecipientOtpDelivery } from '../src/recipient-auth/recipient-otp-delivery.js';
import { RecipientsModule } from '../src/recipients/recipients.module.js';
import { RedisModule } from '../src/redis/redis.module.js';
import { RedisService } from '../src/redis/redis.service.js';
import { TrustedContactAuthModule } from '../src/trusted-contact-auth/trusted-contact-auth.module.js';
import { TrustedContactOtpDelivery } from '../src/trusted-contact-auth/trusted-contact-auth.service.js';
import { TrustedContactsModule } from '../src/trusted-contacts/trusted-contacts.module.js';

// Notification centre Step 5: the whole workflow over real HTTP, sessions,
// guards, PostgreSQL, Redis, BullMQ and both workers (driven by hand), with
// the fake inbox as EmailProvider. Also every principal the API knows
// (anonymous, Customer, Recipient, Trusted Contact, ordinary admin, super
// admin without MFA, signed out, demoted, suspended) against every
// Notification centre route. The communication policy is swapped for a cleared
// one ONLY here (the real app keeps POLICY_BLOCKERS). Fictional data only.
describe('Notification centre workflow (e2e, Step 5, provider mocked)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let tests: AnnouncementTestProcessor;
  let broadcasts: AnnouncementBroadcastProcessor;
  const inbox = new FakeEmailProvider();
  const policy: { blockers: readonly PolicyBlocker[]; version: string } = { blockers: [], version: 'e2e-workflow-cleared' };
  const run = Date.now();
  const at = (n: string) => `wf.${n}.${run}@example.test`;
  const people = {
    root: at('root'),
    nomfa: at('nomfa'),
    leaver: at('leaver'),
    demoted: at('demoted'),
    suspended: at('suspended'),
    admin: at('admin'),
    lisa: at('lisa'), // Customer with a Recipient and a Trusted Contact
  };
  const SOFIA = at('sofia'); // Recipient only (not a User)
  const DAVID = at('david'); // Trusted Contact only (not a User)
  const password = 'StrongPassword123!';
  type Agent = ReturnType<typeof request.agent>;
  const agents = {} as Record<string, Agent>;
  const ids: string[] = [];
  const otps: OtpDeliveryInput[] = [];
  const otpDelivery = { sendOtp: vi.fn(async (i: OtpDeliveryInput) => void otps.push(i)) };
  const api = (p: string) => `/api/v1${p}`;
  const ORIGIN = 'https://app.example.test';
  const ENV = ['APP_BASE_URL', 'FRONTEND_URL', 'ANNOUNCEMENT_BROADCAST_ENABLED', 'ANNOUNCEMENT_BROADCAST_QUEUE_NAME', 'ANNOUNCEMENT_TEST_QUEUE_NAME', 'ANNOUNCEMENT_BROADCAST_DAILY_LIMIT', 'RECIPIENT_OTP_IP_REQUEST_LIMIT', 'RECIPIENT_OTP_VERIFY_IP_LIMIT', 'TRUSTED_CONTACT_OTP_IP_REQUEST_LIMIT', 'TRUSTED_CONTACT_OTP_VERIFY_IP_LIMIT'];
  const resetThrottle = async () => {
    const redis = app.get(RedisService).client;
    for (const key of await redis.keys(`${process.env.THROTTLE_KEY_PREFIX}*`)) await redis.del(key);
  };
  const otpSignIn = async (base: 'trusted-contact-auth' | 'recipient-auth', email: string) => {
    const { challengeId } = (await request(app.getHttpServer()).post(api(`/${base}/request-otp`)).send({ email }).expect(202)).body;
    const agent = request.agent(app.getHttpServer());
    await agent.post(api(`/${base}/verify-otp`)).send({ challengeId, code: otps.findLast((o) => o.email === email)!.code }).expect(200);
    return agent;
  };
  const customer = async (n: string, over: Record<string, unknown> = {}) => {
    const u = await prisma.user.create({
      data: { email: at(n), passwordHash: 'x', role: 'CUSTOMER', emailVerifiedAt: new Date(), marketingConsentAt: new Date(), ...over },
      select: { id: true, email: true },
    });
    ids.push(u.id);
    return u;
  };

  beforeAll(async () => {
    Object.assign(process.env, {
      APP_BASE_URL: ORIGIN,
      FRONTEND_URL: ORIGIN,
      ANNOUNCEMENT_BROADCAST_ENABLED: 'true', // this process only; never set in a real env file
      ANNOUNCEMENT_BROADCAST_QUEUE_NAME: `announcement-broadcast-wf-${run}`,
      ANNOUNCEMENT_TEST_QUEUE_NAME: `announcement-test-wf-${run}`,
      ANNOUNCEMENT_BROADCAST_DAILY_LIMIT: '10000',
      RECIPIENT_OTP_IP_REQUEST_LIMIT: '10000',
      RECIPIENT_OTP_VERIFY_IP_LIMIT: '10000',
      TRUSTED_CONTACT_OTP_IP_REQUEST_LIMIT: '10000',
      TRUSTED_CONTACT_OTP_VERIFY_IP_LIMIT: '10000',
    });
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        RedisModule,
        AuthModule,
        AnnouncementsModule,
        EmailModule,
        RecipientsModule,
        TrustedContactsModule,
        MessagesModule,
        RecipientAuthModule,
        TrustedContactAuthModule,
      ],
      providers: [AnnouncementTestProcessor, AnnouncementBroadcastProcessor],
    })
      .overrideProvider(EmailProvider)
      .useValue(inbox)
      .overrideProvider(AnnouncementPolicy)
      .useValue(policy)
      .overrideProvider(TrustedContactOtpDelivery)
      .useValue(otpDelivery)
      .overrideProvider(RecipientOtpDelivery)
      .useValue(otpDelivery)
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app, new session.MemoryStore(), new session.MemoryStore());
    await app.init();
    prisma = app.get(PrismaService);
    tests = app.get(AnnouncementTestProcessor);
    broadcasts = app.get(AnnouncementBroadcastProcessor);
    // Both workers are driven by hand from here on.
    await (tests as unknown as { worker: { close: () => Promise<void> } }).worker.close();
    await (broadcasts as unknown as { worker: { close: () => Promise<void> } }).worker.close();
    vi.spyOn(broadcasts as unknown as { pause(ms: number): Promise<void> }, 'pause').mockResolvedValue(undefined);

    for (const [k, email] of Object.entries(people)) {
      await resetThrottle(); // registration is rate-limited per IP
      await request(app.getHttpServer()).post(api('/auth/register')).send({ email, password, firstName: k, lastName: 'Test' }).expect(201);
    }
    ids.push(...(await prisma.user.findMany({ where: { email: { in: Object.values(people) } }, select: { id: true } })).map((u) => u.id));
    await prisma.user.updateMany({ where: { email: { in: Object.values(people) } }, data: { emailVerifiedAt: new Date() } });
    await prisma.user.update({ where: { email: people.admin }, data: { role: 'ADMIN' } });
    await prisma.user.updateMany({
      where: { email: { in: [people.root, people.nomfa, people.leaver, people.demoted, people.suspended] } },
      data: { role: 'SUPER_ADMIN' },
    });
    for (const k of ['root', 'leaver', 'demoted', 'suspended', 'admin'] as const) {
      await resetThrottle(); // the login limit is 5 per minute per IP
      agents[k] = (await adminSignIn(app, people[k], password)).agent;
    }
    await resetThrottle();
    agents.nomfa = request.agent(app.getHttpServer());
    await agents.nomfa.post(api('/auth/login')).send({ email: people.nomfa, password }).expect(200); // password only
    agents.lisa = request.agent(app.getHttpServer());
    await agents.lisa.post(api('/auth/login')).send({ email: people.lisa, password }).expect(200);
    // A Recipient with a released message and a Trusted Contact, as the account e2e seeds them.
    await agents.lisa.post(api('/trusted-contacts')).set('Origin', ORIGIN).send({ firstName: 'David', email: DAVID }).expect(201);
    const recipientId = (await agents.lisa.post(api('/recipients')).set('Origin', ORIGIN).send({ firstName: 'Sofia', email: SOFIA }).expect(201)).body.id as string;
    const messageId = (
      await agents.lisa.post(api('/messages')).set('Origin', ORIGIN).send({ title: 'Fictional', textContent: 'Fictional text.', recipientIds: [recipientId] }).expect(201)
    ).body.id as string;
    await prisma.message.update({
      where: { id: messageId },
      data: {
        status: 'RELEASED',
        release: { create: { triggerType: 'FIXED_DATE', releasedAt: new Date(), accessGrants: { create: { recipientId, messageId, recipientEmailNormalized: SOFIA } } } },
      },
    });
    agents.recipient = await otpSignIn('recipient-auth', SOFIA);
    agents.trusted = await otpSignIn('trusted-contact-auth', DAVID);
    inbox.sent.length = 0; // registration and invitation emails from the set-up
  });

  beforeEach(resetThrottle);

  afterAll(async () => {
    for (const k of ENV) delete process.env[k];
    const runs = await prisma?.announcementSendRun.findMany({ where: { requestedByUserId: { in: ids } }, select: { id: true } });
    await prisma?.announcementRunRecipient.deleteMany({ where: { runId: { in: runs?.map((r) => r.id) ?? [] } } });
    await prisma?.announcementSendRun.deleteMany({ where: { requestedByUserId: { in: ids } } });
    await prisma?.announcementTestSend.deleteMany({ where: { requestedByUserId: { in: ids } } });
    await prisma?.emailAnnouncement.deleteMany({ where: { createdByUserId: { in: ids } } });
    await prisma?.user.deleteMany({ where: { id: { in: ids } } });
    await app?.get(AnnouncementBroadcastQueue).queue.obliterate({ force: true });
    await app?.get(AnnouncementTestQueue).queue.obliterate({ force: true });
    await app?.close();
  });

  it('the harness refuses any request to Microsoft (no real email can leave a test run)', async () => {
    await expect(fetch('https://graph.microsoft.com/v1.0/users/x/sendMail', { method: 'POST' })).rejects.toThrow(/e2e guard/);
    await expect(fetch('https://login.microsoftonline.com/tenant/oauth2/v2.0/token')).rejects.toThrow(/e2e guard/);
  });

  it('every principal except a fully signed-in SUPER_ADMIN is refused on every Notification centre route; nothing is created', async () => {
    const draftId = (await agents.root.post(api('/admin/announcements')).set('Origin', ORIGIN).send({ name: 'Auth', subject: 'S', body: 'B' }).expect(201)).body.id as string;
    const runId = randomUUID();
    const routes: [string, string, object?][] = [
      ['get', '/admin/announcements'],
      ['get', `/admin/announcements/${draftId}`],
      ['post', '/admin/announcements', { name: 'x', subject: 'x', body: 'x' }],
      ['put', `/admin/announcements/${draftId}`, { name: 'x', subject: 'x', body: 'x', expectedVersion: 1 }],
      ['post', '/admin/announcements/preview', { subject: 'x', body: 'x' }],
      ['get', '/admin/announcements/test-destination'],
      ['post', `/admin/announcements/${draftId}/test-sends`, { clientOperationId: randomUUID(), expectedVersion: 1 }],
      ['get', `/admin/announcements/${draftId}/audience`],
      ['post', `/admin/announcements/${draftId}/broadcast-review`, { expectedVersion: 1 }],
      ['post', `/admin/announcements/${draftId}/broadcasts`, { clientOperationId: randomUUID(), expectedVersion: 1, reviewToken: 'a.b' }],
      ['get', `/admin/announcements/${draftId}/broadcasts/${runId}`],
      ['post', `/admin/announcements/${draftId}/broadcasts/${runId}/cancel`],
    ];
    // Revoked: signed out; demoted to ADMIN; suspended (role and status are re-read on every request).
    await agents.leaver.post(api('/admin-auth/logout')).set('Origin', ORIGIN).expect((r) => expect(r.status).toBeLessThan(300));
    await prisma.user.update({ where: { email: people.demoted }, data: { role: 'ADMIN' } });
    await prisma.user.update({ where: { email: people.suspended }, data: { status: 'SUSPENDED' } });
    const who: [string, Agent][] = [
      ['anonymous', request(app.getHttpServer())],
      ['customer', agents.lisa!],
      ['recipient', agents.recipient!],
      ['trusted contact', agents.trusted!],
      ['ordinary admin', agents.admin!],
      ['super admin without MFA', agents.nomfa!],
      ['signed out', agents.leaver!],
      ['demoted to admin', agents.demoted!],
      ['suspended', agents.suspended!],
    ];
    for (const [label, agent] of who) {
      await resetThrottle();
      for (const [method, path, body] of routes) {
        const req = (agent as unknown as Record<string, (p: string) => request.Test>)[method]!(api(path)).set('Origin', ORIGIN);
        const res = await (body ? req.send(body) : req);
        expect([401, 403], `${label} ${method.toUpperCase()} ${path} → ${res.status}`).toContain(res.status);
      }
    }
    expect(await prisma.emailAnnouncement.count({ where: { createdByUserId: { in: ids } } })).toBe(1);
    expect(await prisma.announcementTestSend.count({ where: { announcementId: draftId } })).toBe(0);
    expect(await prisma.announcementSendRun.count({ where: { announcementId: draftId } })).toBe(0);
    expect(inbox.sent).toHaveLength(0);
    // Unapproved button destinations and header injection are refused at the boundary.
    for (const bad of [
      { ctaLabel: 'Go', ctaDestination: 'https://evil.example' },
      { ctaLabel: 'Go', ctaDestination: '/admin' },
      { subject: 'Hi\r\nBcc: victim@example.test' },
    ]) {
      await agents.root.post(api('/admin/announcements')).set('Origin', ORIGIN).send({ name: 'x', subject: 'x', body: 'x', ...bad }).expect(400);
    }
  });

  it('success flow: draft → saved preview → test to the signed-in super admin → audience → review → confirm → worker → accurate terminal progress', async () => {
    const logs: string[] = [];
    const spies = (['log', 'warn', 'error'] as const).map((m) =>
      vi.spyOn(Logger.prototype, m).mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' '))),
    );
    try {
      const ok = await customer('ok');
      const trialEnded = await customer('trial-ended'); // billing state is not an eligibility rule
      await prisma.customerTrial.create({ data: { userId: trialEnded.id, startedAt: new Date(run - 30 * 86_400_000), endsAt: new Date(run - 23 * 86_400_000) } });
      const unverified = await customer('unverified', { emailVerifiedAt: null });
      const subject = 'Spring <b>notes</b> & news';
      const body = 'Hello <script>alert(1)</script>,\n\nSecond paragraph.';
      // 1–3: create and save the draft.
      const created = (await agents.root.post(api('/admin/announcements')).set('Origin', ORIGIN).send({ name: 'Workflow', subject, body, ctaLabel: 'Open', ctaDestination: 'DASHBOARD' }).expect(201)).body as { id: string; version: number };
      // All eligible customers here (pilot runs: announcement-pilot.e2e-spec.ts).
      await agents.root.put(api(`/admin/announcements/${created.id}/audience-scope`)).set('Origin', ORIGIN).send({ audience: 'ALL_ELIGIBLE' }).expect(200);
      const saved = (await agents.root.get(api(`/admin/announcements/${created.id}`)).expect(200)).body;
      expect(saved).toMatchObject({ subject, body, version: 1, status: 'DRAFT', broadcast: null });
      // 4: preview of the saved content: escaped, approved link only.
      const preview = (await agents.root.post(api('/admin/announcements/preview')).set('Origin', ORIGIN).send({ subject, body, ctaLabel: 'Open', ctaDestination: 'DASHBOARD' }).expect(200)).body as { html: string; subject: string };
      expect(preview.html).toContain('Spring &#60;b&#62;notes&#60;/b&#62; &#38; news'); // the renderer's numeric entities
      expect(preview.html).not.toContain('<b>notes');
      expect(preview.html).not.toContain('<script>');
      expect(preview.html).toContain(`href="${ORIGIN}/dashboard"`);
      // 5–6: the test goes to the signed-in super admin's verified email; the browser cannot name it.
      expect((await agents.root.get(api('/admin/announcements/test-destination')).expect(200)).body).toEqual({ email: people.root });
      await agents.root.post(api(`/admin/announcements/${created.id}/test-sends`)).set('Origin', ORIGIN).send({ clientOperationId: randomUUID(), expectedVersion: 1, to: at('ok') }).expect(400);
      const t = (await agents.root.post(api(`/admin/announcements/${created.id}/test-sends`)).set('Origin', ORIGIN).send({ clientOperationId: randomUUID(), expectedVersion: 1 }).expect(202)).body as { id: string };
      expect(await tests.process({ data: { testSendId: t.id }, attemptsMade: 0, opts: { attempts: 3 } } as unknown as Job<AnnouncementTestJobData>)).toBe('accepted');
      expect(inbox.sent.map((m) => [m.kind, m.to])).toEqual([['announcement-test', people.root]]);
      expect(inbox.sent[0]!.subject).toBe(`[TEST] ${subject}`);
      // 7: audience.
      const aud = (await agents.root.get(api(`/admin/announcements/${created.id}/audience`)).expect(200)).body;
      expect(aud.candidates).toBe(aud.eligible + aud.excluded); // reconciles
      expect(aud.excluded).toBe(Object.values(aud.exclusions as Record<string, number>).reduce((a, b) => a + b, 0));
      // 8: review the exact saved version (same renderer as the preview) and confirm.
      const review = (await agents.root.post(api(`/admin/announcements/${created.id}/broadcast-review`)).set('Origin', ORIGIN).send({ expectedVersion: 1 }).expect(200)).body;
      expect(review.html).toBe(preview.html); // same renderer (preview and review show the inert sample unsubscribe link)
      expect(review.reviewToken).toBeTruthy();
      const queued = await agents.root.post(api(`/admin/announcements/${created.id}/broadcasts`)).set('Origin', ORIGIN).send({ clientOperationId: randomUUID(), expectedVersion: 1, reviewToken: review.reviewToken });
      expect([202, 409]).toContain(queued.status); // 409 only if another suite changed the shared audience in between
      const runId = queued.status === 202 ? (queued.body.id as string) : await (async () => {
        const again = (await agents.root.post(api(`/admin/announcements/${created.id}/broadcast-review`)).set('Origin', ORIGIN).send({ expectedVersion: 1 }).expect(200)).body;
        return (await agents.root.post(api(`/admin/announcements/${created.id}/broadcasts`)).set('Origin', ORIGIN).send({ clientOperationId: randomUUID(), expectedVersion: 1, reviewToken: again.reviewToken }).expect(202)).body.id as string;
      })();
      const before = (await agents.root.get(api(`/admin/announcements/${created.id}/broadcasts/${runId}`)).expect(200)).body;
      expect(before).toMatchObject({ status: 'PREPARING', prepared: 0, audiencePrepared: false, pausedUntil: null });
      // 9–10: worker prepares and sends.
      for (let i = 0; i < 100; i++) {
        if ((await broadcasts.drive(runId)) === 'finished') break;
        await prisma.announcementSendRun.update({ where: { id: runId }, data: { leaseUntil: null } });
      }
      // 11–12: progress = persisted outcomes; accurate terminal state; no "delivered".
      const p = (await agents.root.get(api(`/admin/announcements/${created.id}/broadcasts/${runId}`)).expect(200)).body;
      expect(p.status).toBe('COMPLETED');
      const grouped = await prisma.announcementRunRecipient.groupBy({ by: ['status'], where: { runId }, _count: { _all: true } });
      for (const g of grouped) expect(p.counts[g.status]).toBe(g._count._all);
      expect(p.prepared).toBe(await prisma.announcementRunRecipient.count({ where: { runId } }));
      const row = await prisma.announcementSendRun.findUniqueOrThrow({ where: { id: runId } });
      expect(p.createdAt).toBe(row.createdAt.toISOString());
      expect(p.completedAt).toBe(row.completedAt!.toISOString());
      expect(JSON.stringify(p)).not.toMatch(/deliver|opened/i);
      // Test emails are not part of the run; the super admin is not a recipient.
      const sentToCustomers = inbox.sent.filter((m) => m.kind === 'announcement');
      expect(sentToCustomers).toHaveLength(p.counts.ACCEPTED);
      expect(sentToCustomers.some((m) => m.to === people.root)).toBe(false);
      expect(inbox.sent.filter((m) => m.kind === 'announcement-test')).toHaveLength(1);
      expect(inbox.to(ok.email, 'announcement')).toHaveLength(1);
      expect(inbox.to(trialEnded.email, 'announcement')).toHaveLength(1);
      expect(inbox.to(unverified.email)).toHaveLength(0);
      // One recipient per email; nobody else's address inside it.
      for (const m of sentToCustomers) {
        expect(typeof m.to).toBe('string');
        expect(m.html).not.toMatch(/@example\.test/);
        expect(m.text).not.toMatch(/@example\.test/);
      }
      // Logs and audit: ids, codes and counts only.
      const audit = await prisma.auditLog.findMany({ where: { OR: [{ subjectId: { in: [created.id, runId, t.id] } }, { metadata: { path: ['announcementId'], equals: created.id } }] } });
      const leaks = [subject, 'Second paragraph', review.reviewToken as string, ok.email, trialEnded.email, people.root];
      for (const s of leaks) {
        expect(JSON.stringify(audit)).not.toContain(s);
        expect(logs.join('\n')).not.toContain(s);
      }
      expect(audit.map((a) => a.eventType)).toEqual(
        expect.arrayContaining([
          'ANNOUNCEMENT_DRAFT_CREATED',
          'ANNOUNCEMENT_TEST_REQUESTED',
          'ANNOUNCEMENT_TEST_COMPLETED',
          'ANNOUNCEMENT_AUDIENCE_REVIEWED',
          'ANNOUNCEMENT_BROADCAST_REQUESTED',
          'ANNOUNCEMENT_BROADCAST_QUEUED',
          'ANNOUNCEMENT_BROADCAST_FINISHED',
        ]),
      );
      // Reopening the draft shows the run (the editor opens the progress view).
      expect((await agents.root.get(api(`/admin/announcements/${created.id}`)).expect(200)).body.broadcast).toMatchObject({ id: runId, status: 'COMPLETED' });
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
