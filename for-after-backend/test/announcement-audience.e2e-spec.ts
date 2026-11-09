import { ConfigModule } from '@nestjs/config';
import { emailHash } from '../src/communications/communications.service.js';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import session from 'express-session';
import request from 'supertest';
import { adminSignIn } from './admin-sign-in.js';
import { FakeEmailProvider } from './fake-email.js';
import { AnnouncementAudienceService } from '../src/announcements/announcement-audience.service.js';
import { AnnouncementTestQueue } from '../src/announcements/announcement-test-queue.service.js';
import { AnnouncementsModule } from '../src/announcements/announcements.module.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { configureApp } from '../src/config/app.setup.js';
import { EmailProvider } from '../src/email/email-provider.js';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { RedisModule } from '../src/redis/redis.module.js';

// Notification centre Step 3: the read-only audience review on real HTTP,
// sessions and PostgreSQL. The test DB is shared with other suites, so every
// assertion is a difference against a review taken before this file's
// fictional customers exist. Nothing is sent; no addresses leave the API.
describe('Announcement audience review (e2e, PostgreSQL)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const inbox = new FakeEmailProvider();
  const run = Date.now();
  const at = (n: string) => `audience.${n}.${run}@example.test`;
  const staff = { admin: at('admin'), root: at('root') };
  const password = 'StrongPassword123!';
  type Agent = ReturnType<typeof request.agent>;
  let root: Agent;
  let admin: Agent;
  let customer: Agent;
  const ids: string[] = [];
  const api = (p: string) => `/api/v1${p}`;
  const ORIGIN = 'https://app.example.test';
  let draftId = '';
  type Review = {
    candidates: number;
    eligible: number | null;
    excluded: number;
    exclusions: {
      accountUnavailable: number;
      emailInvalid: number;
      emailNotVerified: number;
      openDeathReport: number;
      suppressed: number;
      noConsent: number;
    };
  };
  const suppressedHashes: string[] = [];
  const review = async () => (await root.get(api(`/admin/announcements/${draftId}/audience`)).expect(200)).body as Review & Record<string, unknown>;
  const customerRow = (n: string, over: Record<string, unknown> = {}) =>
    // Opted in to product news unless a test says otherwise (Step 7: consent is a rule).
    prisma.user.create({ data: { email: at(n), passwordHash: 'x', role: 'CUSTOMER', emailVerifiedAt: new Date(), marketingConsentAt: new Date(), ...over }, select: { id: true } });

  beforeAll(async () => {
    Object.assign(process.env, { EMAIL_PROVIDER: 'disabled', APP_BASE_URL: ORIGIN, FRONTEND_URL: ORIGIN, THROTTLE_KEY_PREFIX: `for_after:test_audience_throttle:${run}:` });
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule, RedisModule, AuthModule, AnnouncementsModule],
    })
      .overrideProvider(EmailProvider)
      .useValue(inbox)
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app, new session.MemoryStore(), new session.MemoryStore());
    await app.init();
    prisma = app.get(PrismaService);
    for (const email of Object.values(staff)) {
      await request(app.getHttpServer()).post(api('/auth/register')).send({ email, password, firstName: 'Staff', lastName: 'Test' }).expect(201);
    }
    await prisma.user.updateMany({ where: { email: { in: Object.values(staff) } }, data: { emailVerifiedAt: new Date() } });
    await prisma.user.update({ where: { email: staff.admin }, data: { role: 'ADMIN' } });
    await prisma.user.update({ where: { email: staff.root }, data: { role: 'SUPER_ADMIN' } });
    ids.push(...(await prisma.user.findMany({ where: { email: { in: Object.values(staff) } }, select: { id: true } })).map((u) => u.id));
    admin = (await adminSignIn(app, staff.admin, password)).agent;
    root = (await adminSignIn(app, staff.root, password)).agent;
    draftId = (await root.post(api('/admin/announcements')).set('Origin', ORIGIN).send({ name: 'Audience', subject: 'Hello', body: 'Body' }).expect(201)).body.id;
    // These counts are about every Customer (drafts start as pilot-only).
    await root.put(api(`/admin/announcements/${draftId}/audience-scope`)).set('Origin', ORIGIN).send({ audience: 'ALL_ELIGIBLE' }).expect(200);
  });

  afterAll(async () => {
    for (const k of ['EMAIL_PROVIDER', 'APP_BASE_URL', 'FRONTEND_URL', 'THROTTLE_KEY_PREFIX']) delete process.env[k];
    await prisma?.emailSuppression.deleteMany({ where: { emailHash: { in: suppressedHashes } } });
    await prisma?.emailAnnouncement.deleteMany({ where: { createdByUserId: { in: ids } } });
    await prisma?.user.deleteMany({ where: { id: { in: ids } } });
    await app?.close();
  });

  it('access: anonymous 401, Customer 401/403, ordinary admin 403, password-only admin 401; unknown draft 404', async () => {
    await request(app.getHttpServer()).get(api(`/admin/announcements/${draftId}/audience`)).expect(401);
    const c = await customerRow('signedin');
    ids.push(c.id);
    await prisma.user.update({ where: { id: c.id }, data: { passwordHash: (await prisma.user.findUniqueOrThrow({ where: { email: staff.root } })).passwordHash } });
    customer = request.agent(app.getHttpServer());
    await customer.post(api('/auth/login')).send({ email: at('signedin'), password }).expect(200);
    expect((await customer.get(api(`/admin/announcements/${draftId}/audience`))).status).toBeGreaterThanOrEqual(401);
    await admin.get(api(`/admin/announcements/${draftId}/audience`)).expect(403);
    const half = request.agent(app.getHttpServer());
    await half.post(api('/auth/login')).send({ email: staff.root, password }).expect(200);
    await half.get(api(`/admin/announcements/${draftId}/audience`)).expect(401);
    await root.get(api('/admin/announcements/00000000-0000-4000-8000-000000000000/audience')).expect(404);
    await root.get(api('/admin/announcements/not-a-uuid/audience')).expect(400);
  });

  it('one primary reason per customer; totals reconcile; admins never counted; billing is not a rule; open death reports flagged separately', async () => {
    const before = await review();
    const made = await Promise.all([
      customerRow('ok'),
      customerRow('unverified', { emailVerifiedAt: null }),
      customerRow('suspended', { status: 'SUSPENDED' }),
      customerRow('passed', { status: 'PASSED' }),
      // Deleted AND unverified: counted once, under the first reason (account unavailable).
      customerRow('deleted', { status: 'DELETED', deletedAt: new Date(), emailVerifiedAt: null }),
      prisma.user.create({ data: { email: `not-an-address-${run}`, passwordHash: 'x', role: 'CUSTOMER', emailVerifiedAt: new Date() }, select: { id: true } }),
      customerRow('expiredtrial'),
      customerRow('neverpaid'),
      customerRow('reported'),
      customerRow('noconsent', { marketingConsentAt: null }),
      customerRow('suppressed'),
      prisma.user.create({ data: { email: at('extra-admin'), passwordHash: 'x', role: 'ADMIN', emailVerifiedAt: new Date() }, select: { id: true } }),
    ]);
    ids.push(...made.map((m) => m.id));
    const [, , , , , , expired, , reported] = made;
    suppressedHashes.push(emailHash(at('suppressed')));
    await prisma.emailSuppression.create({ data: { emailHash: suppressedHashes[0]!, reason: 'HARD_BOUNCE' } });
    await prisma.customerTrial.create({ data: { userId: expired!.id, startedAt: new Date(run - 30 * 86_400_000), endsAt: new Date(run - 23 * 86_400_000) } });
    await prisma.deathVerificationCase.create({ data: { ownerUserId: reported!.id, status: 'PENDING_VERIFICATION' } });

    const after = await review();
    const d = (k: keyof Review['exclusions']) => after.exclusions[k] - before.exclusions[k];
    expect(after.candidates - before.candidates).toBe(11); // the ADMIN row is not a candidate
    expect(after.eligible! - before.eligible!).toBe(3); // ok, expired trial, never paid (billing is not a rule)
    expect(d('accountUnavailable')).toBe(3);
    expect(d('emailInvalid')).toBe(1);
    expect(d('emailNotVerified')).toBe(1);
    expect(d('openDeathReport')).toBe(1); // excluded until the report is resolved
    expect(d('suppressed')).toBe(1);
    expect(d('noConsent')).toBe(1); // registration alone is not consent
    for (const r of [before, after]) {
      expect(r.eligible! + r.excluded).toBe(r.candidates);
      expect(r.excluded).toBe(Object.values(r.exclusions).reduce((a, b) => a + b, 0));
    }
  });

  it('policy decided (Step 7): optional product news, every rule implemented, so the state is confirmed with a real eligible count', async () => {
    const r = await review();
    expect(r).toMatchObject({ announcementId: draftId, version: 1, audience: 'ALL_ELIGIBLE', purpose: 'OPTIONAL_PRODUCT_NEWS', state: 'CONFIRMED' });
    expect(typeof r.eligible).toBe('number');
    expect(r.blockers).toEqual([]);
    expect(Date.parse(r.checkedAt as string)).toBeGreaterThan(run);
  });

  it('counts only: no addresses or names; no-store; nothing sent, queued or recorded except one audit row', async () => {
    const tests = await prisma.announcementTestSend.count();
    const sent = inbox.sent.length;
    const jobs = await app.get(AnnouncementTestQueue).queue.getJobCounts();
    const res = await root.get(api(`/admin/announcements/${draftId}/audience`)).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(JSON.stringify(res.body)).not.toMatch(/@|audience\.|Staff|Test/);
    expect(await prisma.announcementTestSend.count()).toBe(tests);
    expect(inbox.sent.length).toBe(sent);
    expect(await app.get(AnnouncementTestQueue).queue.getJobCounts()).toEqual(jobs);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { eventType: 'ANNOUNCEMENT_AUDIENCE_REVIEWED', subjectId: draftId }, orderBy: { createdAt: 'desc' } });
    expect(audit).toMatchObject({ actorType: 'SUPER_ADMIN', subjectType: 'EmailAnnouncement' });
    expect(audit.metadata).toEqual({ version: 1, outcome: 'completed', audience: 'ALL_ELIGIBLE' });
  });

  it('a failing query is "unavailable" (503), never zero', async () => {
    const svc = app.get(AnnouncementAudienceService);
    const prismaInSvc = (svc as unknown as { prisma: PrismaService }).prisma;
    const spy = vi.spyOn(prismaInSvc, '$queryRaw').mockRejectedValueOnce(Object.assign(new Error('db down'), { code: 'P1001' }));
    const res = await root.get(api(`/admin/announcements/${draftId}/audience`)).expect(503);
    expect(res.body.message).toMatch(/unavailable/);
    expect(JSON.stringify(res.body)).not.toMatch(/candidates|eligible/);
    spy.mockRestore();
  });
});
