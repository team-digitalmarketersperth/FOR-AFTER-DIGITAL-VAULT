import { ConfigModule } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import session from 'express-session';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { adminSignIn } from './admin-sign-in.js';
import { FakeEmailProvider } from './fake-email.js';
import { AnnouncementBroadcastProcessor } from '../src/announcements/announcement-broadcast.processor.js';
import { AnnouncementBroadcastQueue } from '../src/announcements/announcement-broadcast-queue.service.js';
import { AnnouncementsModule } from '../src/announcements/announcements.module.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { CommunicationsModule } from '../src/communications/communications.module.js';
import { CommunicationsService, emailHash } from '../src/communications/communications.service.js';
import { configureApp } from '../src/config/app.setup.js';
import { EmailProvider, EmailSendError } from '../src/email/email-provider.js';
import { EmailModule } from '../src/email/email.module.js';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { RedisModule } from '../src/redis/redis.module.js';
import { RedisService } from '../src/redis/redis.service.js';

// Notification centre Step 7 on real HTTP, sessions, PostgreSQL, Redis and the
// broadcast worker (driven by hand), with the REAL communication policy (no test
// override) and the gate in "pilot" mode. Consent, suppression, unsubscribe and
// the pilot audience. The email provider is the fake inbox. Fictional people only.
describe('Announcement consent, suppression and pilot audience (e2e, Step 7, provider mocked)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let processor: AnnouncementBroadcastProcessor;
  const inbox = new FakeEmailProvider();
  const run = Date.now();
  const at = (n: string) => `pilot.${n}.${run}@example.test`;
  const password = 'StrongPassword123!';
  type Agent = ReturnType<typeof request.agent>;
  const agents = {} as Record<string, Agent>;
  const ids = {} as Record<string, string>;
  const api = (p: string) => `/api/v1${p}`;
  const ORIGIN = 'https://app.example.test';
  const ENV = ['EMAIL_PROVIDER', 'APP_BASE_URL', 'FRONTEND_URL', 'ANNOUNCEMENT_BROADCAST_ENABLED', 'ANNOUNCEMENT_BROADCAST_QUEUE_NAME', 'ANNOUNCEMENT_BROADCAST_DAILY_LIMIT'];
  const hashes: string[] = [];
  const resetThrottle = async () => {
    const redis = app.get(RedisService).client;
    for (const key of await redis.keys(`${process.env.THROTTLE_KEY_PREFIX}*`)) await redis.del(key);
  };
  const customer = async (n: string, over: Record<string, unknown> = {}) => {
    const u = await prisma.user.create({
      // Stored lower-case, as registration does.
      data: { email: at(n).toLowerCase(), passwordHash: 'x', role: 'CUSTOMER', emailVerifiedAt: new Date(), marketingConsentAt: new Date(), ...over },
      select: { id: true, email: true },
    });
    ids[n] = u.id;
    hashes.push(emailHash(u.email));
    return u;
  };
  const root = () => agents.root!;
  const newDraft = async () =>
    (await root().post(api('/admin/announcements')).set('Origin', ORIGIN).send({ name: `Pilot ${randomUUID()}`, subject: 'News from For After', body: 'Hello.\n\nThank you.' }).expect(201))
      .body as { id: string; version: number; audience: string };
  const addPilot = (id: string, email: string, agent = root()) => agent.post(api(`/admin/announcements/${id}/pilot`)).set('Origin', ORIGIN).send({ email });
  const review = (id: string, version: number) => root().post(api(`/admin/announcements/${id}/broadcast-review`)).set('Origin', ORIGIN).send({ expectedVersion: version });
  const confirm = (id: string, body: object) => root().post(api(`/admin/announcements/${id}/broadcasts`)).set('Origin', ORIGIN).send(body);
  const driveAll = async (runId: string) => {
    for (let i = 0; i < 100; i++) {
      const { status } = await prisma.announcementSendRun.findUniqueOrThrow({ where: { id: runId } });
      if (!['PREPARING', 'SENDING'].includes(status)) return;
      await processor.drive(runId);
      await prisma.announcementSendRun.update({ where: { id: runId }, data: { leaseUntil: null } });
    }
    throw new Error('run did not finish');
  };
  const recipient = (runId: string, userId: string) => prisma.announcementRunRecipient.findUnique({ where: { runId_userId: { runId, userId } } });

  beforeAll(async () => {
    Object.assign(process.env, {
      EMAIL_PROVIDER: 'disabled',
      APP_BASE_URL: ORIGIN,
      FRONTEND_URL: ORIGIN,
      ANNOUNCEMENT_BROADCAST_ENABLED: 'pilot', // this test process only
      ANNOUNCEMENT_BROADCAST_QUEUE_NAME: `announcement-broadcast-pilot-${run}`,
      ANNOUNCEMENT_BROADCAST_DAILY_LIMIT: '10000',
    });
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule, RedisModule, AuthModule, AnnouncementsModule, EmailModule, CommunicationsModule],
      providers: [AnnouncementBroadcastProcessor],
    })
      .overrideProvider(EmailProvider)
      .useValue(inbox)
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app, new session.MemoryStore(), new session.MemoryStore());
    await app.init();
    prisma = app.get(PrismaService);
    processor = app.get(AnnouncementBroadcastProcessor);
    await (processor as unknown as { worker: { close: () => Promise<void> } }).worker.close();
    vi.spyOn(processor as unknown as { pause(ms: number): Promise<void> }, 'pause').mockResolvedValue(undefined);
    for (const [k, role] of [['root', 'SUPER_ADMIN'], ['admin', 'ADMIN'], ['cara', 'CUSTOMER']] as const) {
      await resetThrottle();
      await request(app.getHttpServer()).post(api('/auth/register')).send({ email: at(k), password, firstName: k, lastName: 'Test' }).expect(201);
      ids[k] = (await prisma.user.findUniqueOrThrow({ where: { email: at(k) } })).id;
      hashes.push(emailHash(at(k)));
      await prisma.user.update({ where: { id: ids[k] }, data: { role, emailVerifiedAt: new Date() } });
    }
    await resetThrottle();
    agents.root = (await adminSignIn(app, at('root'), password)).agent;
    await resetThrottle();
    agents.admin = (await adminSignIn(app, at('admin'), password)).agent;
    await resetThrottle();
    agents.cara = request.agent(app.getHttpServer());
    await agents.cara.post(api('/auth/login')).send({ email: at('cara'), password }).expect(200);
    inbox.sent.length = 0;
  });

  beforeEach(async () => {
    await resetThrottle();
    process.env.ANNOUNCEMENT_BROADCAST_ENABLED = 'pilot';
    inbox.failuresFor.clear();
  });

  afterAll(async () => {
    for (const k of ENV) delete process.env[k];
    const all = Object.values(ids);
    const runs = await prisma?.announcementSendRun.findMany({ where: { requestedByUserId: { in: all } }, select: { id: true } });
    await prisma?.announcementRunRecipient.deleteMany({ where: { runId: { in: runs?.map((r) => r.id) ?? [] } } });
    await prisma?.announcementSendRun.deleteMany({ where: { requestedByUserId: { in: all } } });
    await prisma?.emailAnnouncement.deleteMany({ where: { createdByUserId: { in: all } } });
    await prisma?.emailSuppression.deleteMany({ where: { emailHash: { in: hashes } } });
    await prisma?.deathVerificationCase.deleteMany({ where: { ownerUserId: { in: all } } });
    await prisma?.user.deleteMany({ where: { id: { in: all } } });
    await app?.get(AnnouncementBroadcastQueue).queue.obliterate({ force: true });
    await app?.close();
  });

  it('consent: off by default (registration is not consent); only the Customer changes it; every change audited without content', async () => {
    const pref = () => agents.cara!.get(api('/users/me/communication-preferences'));
    expect((await pref().expect(200)).body).toEqual({ productNews: false, since: null });
    await request(app.getHttpServer()).get(api('/users/me/communication-preferences')).expect(401);
    expect([401, 403]).toContain((await agents.root!.get(api('/users/me/communication-preferences'))).status);
    await agents.cara!.put(api('/users/me/communication-preferences')).set('Origin', ORIGIN).send({ productNews: true, userId: ids.root }).expect(400);
    await agents.cara!.put(api('/users/me/communication-preferences')).set('Origin', 'https://evil.example').send({ productNews: true }).expect(403);
    const on = await agents.cara!.put(api('/users/me/communication-preferences')).set('Origin', ORIGIN).send({ productNews: true }).expect(200);
    expect(on.body.productNews).toBe(true);
    await agents.cara!.put(api('/users/me/communication-preferences')).set('Origin', ORIGIN).send({ productNews: true }).expect(200); // no-op
    await agents.cara!.put(api('/users/me/communication-preferences')).set('Origin', ORIGIN).send({ productNews: false }).expect(200);
    const events = await prisma.auditLog.findMany({ where: { subjectId: ids.cara, eventType: { in: ['MARKETING_CONSENT_GRANTED', 'MARKETING_CONSENT_WITHDRAWN'] } }, orderBy: { createdAt: 'asc' } });
    expect(events.map((e) => [e.eventType, e.actorType])).toEqual([
      ['MARKETING_CONSENT_GRANTED', 'CUSTOMER'],
      ['MARKETING_CONSENT_WITHDRAWN', 'CUSTOMER'],
    ]);
    expect(events[0]!.metadata).toEqual({ source: 'account_settings', wording: 'product-news-v1' });
  });

  it('pilot group: SUPER_ADMIN only, Customers only by exact address, at most 10, per-member status; audit ids not addresses', async () => {
    const d = await newDraft();
    expect(d.audience).toBe('PILOT'); // safe default
    const ok = await customer('ok');
    const noConsent = await customer('noconsent', { marketingConsentAt: null });
    const suppressed = await customer('suppressed');
    await prisma.emailSuppression.create({ data: { emailHash: emailHash(suppressed.email), reason: 'UNSUBSCRIBED' } });
    const reported = await customer('reported');
    await prisma.deathVerificationCase.create({ data: { ownerUserId: reported.id, status: 'PENDING_VERIFICATION' } });
    const unverified = await customer('unverified', { emailVerifiedAt: null });

    await addPilot(d.id, ok.email, agents.admin!).expect(403);
    expect((await addPilot(d.id, at('root'))).status).toBe(404); // an admin is not a Customer
    expect((await addPilot(d.id, at('nobody'))).status).toBe(404);
    await addPilot(d.id, 'not-an-email').expect(400);
    for (const c of [ok, noConsent, suppressed, reported, unverified]) await addPilot(d.id, c.email.toUpperCase()).expect(200);
    const list = (await addPilot(d.id, ok.email).expect(200)).body as { members: { userId: string; status: string }[]; max: number };
    expect(list.max).toBe(10);
    expect(Object.fromEntries(list.members.map((m) => [m.userId, m.status]))).toEqual({
      [ok.id]: 'pass',
      [noConsent.id]: 'no_consent',
      [suppressed.id]: 'suppressed',
      [reported.id]: 'open_death_report',
      [unverified.id]: 'email_not_verified',
    });
    // Limit: 10 members.
    for (let i = 0; i < 5; i++) await addPilot(d.id, (await customer(`fill${i}`)).email).expect(200);
    expect((await addPilot(d.id, (await customer('eleventh')).email)).status).toBe(409);
    await root().delete(api(`/admin/announcements/${d.id}/pilot/${ids.fill0}`)).set('Origin', ORIGIN).expect(200);
    const audit = await prisma.auditLog.findMany({ where: { subjectId: d.id, eventType: 'ANNOUNCEMENT_AUDIENCE_UPDATED' } });
    expect(audit.length).toBe(11); // 10 adds + 1 removal; repeats and refusals write nothing
    expect(JSON.stringify(audit)).not.toContain('@');
    // Review counts only the pilot group, with the real reasons.
    const r = (await review(d.id, d.version).expect(200)).body;
    expect(r).toMatchObject({ audience: 'PILOT', purpose: 'OPTIONAL_PRODUCT_NEWS', candidates: 9, eligible: 5, blockers: [] });
    expect(r.exclusions).toMatchObject({ noConsent: 1, suppressed: 1, openDeathReport: 1, emailNotVerified: 1 });
    expect(r.reviewToken).toBeTruthy();
  });

  it('gate "pilot": all-eligible is refused at review, confirmation and in the worker; pilot runs are prepared at confirmation and recheck every rule per email', async () => {
    const d = await newDraft();
    const okA = await customer('okA');
    const bounce = await customer('bounce');
    const withdraws = await customer('withdraws');
    const reports = await customer('reports');
    const unsubscribed = await customer('unsubscribed');
    const outsider = await customer('outsider'); // eligible, never in the pilot
    for (const c of [okA, bounce, withdraws, reports, unsubscribed]) await addPilot(d.id, c.email).expect(200);

    // All-eligible under "pilot": no token.
    await root().put(api(`/admin/announcements/${d.id}/audience-scope`)).set('Origin', ORIGIN).send({ audience: 'ALL_ELIGIBLE' }).expect(200);
    const all = (await review(d.id, d.version).expect(200)).body;
    expect(all.reviewToken).toBeNull();
    expect(all.blockers.map((b: { code: string }) => b.code)).toContain('pilot_only');
    await root().put(api(`/admin/announcements/${d.id}/audience-scope`)).set('Origin', ORIGIN).send({ audience: 'PILOT' }).expect(200);

    // The pilot changes between review and confirmation → review again.
    const stale = (await review(d.id, d.version).expect(200)).body;
    const extra = await customer('late-added');
    await addPilot(d.id, extra.email).expect(200);
    expect((await confirm(d.id, { clientOperationId: randomUUID(), expectedVersion: d.version, reviewToken: stale.reviewToken }).expect(409)).body.message).toMatch(/audience changed/);
    await root().delete(api(`/admin/announcements/${d.id}/pilot/${extra.id}`)).set('Origin', ORIGIN).expect(200);

    const fresh = (await review(d.id, d.version).expect(200)).body;
    expect(fresh.eligible).toBe(5);
    const queued = (await confirm(d.id, { clientOperationId: randomUUID(), expectedVersion: d.version, reviewToken: fresh.reviewToken }).expect(202)).body;
    // Prepared at confirmation: exactly the 5 eligible pilot members, already SENDING.
    expect(queued).toMatchObject({ status: 'SENDING', audience: 'PILOT', audiencePrepared: true, prepared: 5 });
    expect(await recipient(queued.id, outsider.id)).toBeNull();
    // The pilot group is frozen once a run exists.
    expect((await addPilot(d.id, outsider.email)).status).toBe(409);
    expect((await root().put(api(`/admin/announcements/${d.id}/audience-scope`)).set('Origin', ORIGIN).send({ audience: 'ALL_ELIGIBLE' })).status).toBe(409);

    // Changes after confirmation, before the send.
    const comms = app.get(CommunicationsService);
    await comms.setProductNews(withdraws.id, false, { type: 'CUSTOMER', userId: withdraws.id });
    await prisma.deathVerificationCase.create({ data: { ownerUserId: reports.id, status: 'PENDING_VERIFICATION' } });
    await prisma.emailSuppression.create({ data: { emailHash: emailHash(unsubscribed.email), reason: 'UNSUBSCRIBED' } });
    inbox.failuresFor.set(bounce.email, [new EmailSendError('ErrorInvalidRecipients', false)]);
    await driveAll(queued.id);

    expect(await recipient(queued.id, okA.id)).toMatchObject({ status: 'ACCEPTED' });
    expect(await recipient(queued.id, bounce.id)).toMatchObject({ status: 'FAILED', reasonCode: 'ErrorInvalidRecipients' });
    expect(await recipient(queued.id, withdraws.id)).toMatchObject({ status: 'SKIPPED', reasonCode: 'no_consent' });
    expect(await recipient(queued.id, reports.id)).toMatchObject({ status: 'SKIPPED', reasonCode: 'open_death_report' });
    expect(await recipient(queued.id, unsubscribed.id)).toMatchObject({ status: 'SKIPPED', reasonCode: 'suppressed' });
    expect(inbox.sent.filter((m) => m.kind === 'announcement').map((m) => m.to)).toEqual([okA.email]);
    // A hard bounce is suppressed for every future announcement.
    expect(await prisma.emailSuppression.findUnique({ where: { emailHash: emailHash(bounce.email) } })).toMatchObject({ reason: 'HARD_BOUNCE', userId: bounce.id });

    // Unsubscribe from the email's own link: consent withdrawn, address suppressed, idempotent, audited.
    const mail = inbox.to(okA.email, 'announcement')[0]!;
    const token = /unsubscribe\?token=([\w-]+\.[\w-]+)/.exec(mail.html)![1]!;
    expect(mail.text).toContain(`/unsubscribe?token=${token}`);
    await request(app.getHttpServer()).post(api('/communications/unsubscribe')).send({ token: `${token}x` }).expect(400);
    await request(app.getHttpServer()).post(api('/communications/unsubscribe')).send({ token }).expect(200);
    await request(app.getHttpServer()).post(api('/communications/unsubscribe')).send({ token }).expect(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: okA.id } })).marketingConsentAt).toBeNull();
    expect(await prisma.emailSuppression.findUnique({ where: { emailHash: emailHash(okA.email) } })).toMatchObject({ reason: 'UNSUBSCRIBED' });
    const unsubAudit = await prisma.auditLog.findMany({ where: { subjectId: okA.id, eventType: 'MARKETING_CONSENT_WITHDRAWN' } });
    expect(unsubAudit).toHaveLength(1);
    expect(unsubAudit[0]!.metadata).toMatchObject({ source: 'unsubscribe_link' });

    // Opting in again lifts the Customer's own unsubscribe, never a hard bounce.
    await comms.setProductNews(okA.id, true, { type: 'CUSTOMER', userId: okA.id });
    expect(await prisma.emailSuppression.findUnique({ where: { emailHash: emailHash(okA.email) } })).toBeNull();
    await comms.setProductNews(bounce.id, false, { type: 'CUSTOMER', userId: bounce.id });
    await comms.setProductNews(bounce.id, true, { type: 'CUSTOMER', userId: bounce.id });
    expect(await prisma.emailSuppression.findUnique({ where: { emailHash: emailHash(bounce.email) } })).toMatchObject({ reason: 'HARD_BOUNCE' });
    const runAudit = JSON.stringify(await prisma.auditLog.findMany({ where: { OR: [{ subjectId: queued.id }, { eventType: 'EMAIL_SUPPRESSED', createdAt: { gte: new Date(run) } }] } }));
    expect(runAudit).not.toContain('@');
  });

  it('an all-eligible run confirmed under "true" is stopped by the worker once the gate is "pilot" (BLOCKED, nothing sent)', async () => {
    process.env.ANNOUNCEMENT_BROADCAST_ENABLED = 'true';
    await customer('wide');
    const d = await newDraft();
    await root().put(api(`/admin/announcements/${d.id}/audience-scope`)).set('Origin', ORIGIN).send({ audience: 'ALL_ELIGIBLE' }).expect(200);
    const r = (await review(d.id, d.version).expect(200)).body;
    const res = await confirm(d.id, { clientOperationId: randomUUID(), expectedVersion: d.version, reviewToken: r.reviewToken });
    expect(res.status).toBe(202);
    process.env.ANNOUNCEMENT_BROADCAST_ENABLED = 'pilot';
    const sent = inbox.sent.length;
    await driveAll(res.body.id);
    const runRow = await prisma.announcementSendRun.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(runRow).toMatchObject({ status: 'BLOCKED', finishReason: 'broadcast_disabled', audience: 'ALL_ELIGIBLE' });
    expect(inbox.sent.length).toBe(sent);
  });
});
