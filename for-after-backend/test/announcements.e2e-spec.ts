import { ConfigModule } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import session from 'express-session';
import request from 'supertest';
import { adminSignIn } from './admin-sign-in.js';
import { FakeEmailProvider } from './fake-email.js';
import { AnnouncementsModule } from '../src/announcements/announcements.module.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { configureApp } from '../src/config/app.setup.js';
import { EmailProvider } from '../src/email/email-provider.js';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { RedisModule } from '../src/redis/redis.module.js';

// Notification centre Step 1 on real HTTP, sessions, PostgreSQL and Redis
// throttling. Drafts and previews only: the fake inbox (registration emails
// come from AuthModule) proves saving and previewing send nothing.
// Fictional people and content only.
describe('Email announcement drafts (e2e, PostgreSQL)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const inbox = new FakeEmailProvider();
  const run = Date.now();
  const at = (n: string) => `announce.${n}.${run}@example.test`;
  const emails = { cara: at('cara'), admin: at('admin'), root: at('root'), root2: at('root2') };
  const password = 'StrongPassword123!';
  type Agent = ReturnType<typeof request.agent>;
  const agents = {} as Record<keyof typeof emails, Agent>;
  const ids = {} as Record<string, string>;
  const api = (p: string) => `/api/v1${p}`;
  const ORIGIN = 'https://app.example.test';
  const draft = {
    name: 'Spring update',
    subject: 'A note from For After',
    body: 'First paragraph.\nSecond line.\n\nSecond <b>paragraph</b> & more.',
  };
  const ENV = ['EMAIL_PROVIDER', 'APP_BASE_URL', 'EMAIL_FROM_NAME', 'EMAIL_FROM_ADDRESS', 'FRONTEND_URL', 'THROTTLE_KEY_PREFIX'];

  beforeAll(async () => {
    Object.assign(process.env, {
      EMAIL_PROVIDER: 'disabled',
      APP_BASE_URL: ORIGIN,
      EMAIL_FROM_NAME: 'For After',
      EMAIL_FROM_ADDRESS: 'hello@example.test',
      FRONTEND_URL: ORIGIN,
      THROTTLE_KEY_PREFIX: `for_after:test_announce_throttle:${run}:`,
    });
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
    for (const [k, email] of Object.entries(emails)) {
      await request(app.getHttpServer()).post(api('/auth/register')).send({ email, password, firstName: k, lastName: 'Test' }).expect(201);
      ids[k] = (await prisma.user.findUniqueOrThrow({ where: { email } })).id;
    }
    await prisma.user.updateMany({ where: { email: { in: Object.values(emails) } }, data: { emailVerifiedAt: new Date() } });
    await prisma.user.update({ where: { id: ids.admin }, data: { role: 'ADMIN' } });
    await prisma.user.updateMany({ where: { id: { in: [ids.root, ids.root2] } }, data: { role: 'SUPER_ADMIN' } });
    agents.cara = request.agent(app.getHttpServer());
    await agents.cara.post(api('/auth/login')).send({ email: emails.cara, password }).expect(200);
    agents.admin = (await adminSignIn(app, emails.admin, password)).agent;
    agents.root = (await adminSignIn(app, emails.root, password)).agent;
    agents.root2 = (await adminSignIn(app, emails.root2, password)).agent;
  });

  afterAll(async () => {
    for (const k of ENV) delete process.env[k];
    const mine = { createdByUserId: { in: Object.values(ids) } };
    await prisma?.emailAnnouncement.deleteMany({ where: mine });
    // AuditLog rows are append-only (a DB trigger); they stay, as in every e2e.
    await prisma?.user.deleteMany({ where: { email: { in: Object.values(emails) } } });
    await app?.close();
  });

  const create = (agent: Agent, body: object = draft) => agent.post(api('/admin/announcements')).set('Origin', ORIGIN).send(body);

  it('SUPER_ADMIN only: anonymous 401, Customer 401/403, ordinary admin 403, password-only admin challenge 401', async () => {
    const anon = request(app.getHttpServer());
    await anon.get(api('/admin/announcements')).expect(401);
    await anon.post(api('/admin/announcements/preview')).send(draft).expect(401);
    for (const agent of [agents.cara, agents.admin]) {
      const list = await agent.get(api('/admin/announcements'));
      expect([401, 403]).toContain(list.status);
      expect((await create(agent)).status).toBeGreaterThanOrEqual(401);
      expect((await agent.post(api('/admin/announcements/preview')).send(draft)).status).toBeGreaterThanOrEqual(401);
    }
    expect((await agents.admin.get(api('/admin/announcements'))).status).toBe(403);
    // A password without the second factor never reaches the route.
    const half = request.agent(app.getHttpServer());
    await half.post(api('/auth/login')).send({ email: emails.root, password }).expect(200);
    await half.get(api('/admin/announcements')).expect(401);
    expect(await prisma.emailAnnouncement.count({ where: { createdByUserId: { in: [ids.cara, ids.admin] } } })).toBe(0);
  });

  it('create → reopen → edit by another super admin keeps the creator; audited without content; no-store', async () => {
    const created = await create(agents.root).expect(201);
    expect(created.body).toMatchObject({ ...draft, status: 'DRAFT', version: 1, ctaLabel: null, ctaDestination: null });
    expect(created.body.createdBy).toEqual({ id: ids.root, firstName: 'root', lastName: 'Test', email: emails.root });
    const id = created.body.id as string;

    const reopened = await agents.root2.get(api(`/admin/announcements/${id}`)).expect(200);
    expect(reopened.headers['cache-control']).toBe('no-store');
    expect(reopened.body).toMatchObject(draft);

    const edited = await agents.root2
      .put(api(`/admin/announcements/${id}`))
      .set('Origin', ORIGIN)
      .send({ ...draft, subject: 'A new subject', ctaLabel: 'Open your dashboard', ctaDestination: 'DASHBOARD', expectedVersion: 1 })
      .expect(200);
    expect(edited.body).toMatchObject({ version: 2, subject: 'A new subject', ctaDestination: 'DASHBOARD' });
    expect(edited.body.createdBy.id).toBe(ids.root);
    expect(edited.body.updatedBy.id).toBe(ids.root2);

    const audits = await prisma.auditLog.findMany({ where: { subjectId: id }, orderBy: { createdAt: 'asc' } });
    expect(audits.map((a) => [a.eventType, a.actorUserId, a.actorType])).toEqual([
      ['ANNOUNCEMENT_DRAFT_CREATED', ids.root, 'SUPER_ADMIN'],
      ['ANNOUNCEMENT_DRAFT_UPDATED', ids.root2, 'SUPER_ADMIN'],
    ]);
    expect(audits[1]!.metadata).toEqual({ version: 2, changedFields: 'subject,ctaLabel,ctaDestination' });
    const auditText = JSON.stringify(audits);
    for (const secret of ['Spring update', 'A note from For After', 'A new subject', 'First paragraph', 'Open your dashboard']) {
      expect(auditText).not.toContain(secret);
    }

    const list = await agents.root.get(api('/admin/announcements?limit=100')).expect(200);
    const row = list.body.items.find((d: { id: string }) => d.id === id);
    expect(row).toMatchObject({ name: 'Spring update', subject: 'A new subject', status: 'DRAFT', version: 2 });
    expect(row.body).toBeUndefined(); // the list never carries the message
    await agents.root.get(api('/admin/announcements?limit=101')).expect(400);
    expect(inbox.sent.filter((m) => m.kind !== 'verify-email')).toEqual([]); // saving sends nothing
  });

  it('a stale edit is a 409 and changes nothing, including under two concurrent saves', async () => {
    const id = (await create(agents.root).expect(201)).body.id as string;
    const save = (agent: Agent, subject: string, expectedVersion: number) =>
      agent.put(api(`/admin/announcements/${id}`)).set('Origin', ORIGIN).send({ ...draft, subject, expectedVersion });
    const [a, b] = await Promise.all([save(agents.root, 'From root', 1), save(agents.root2, 'From root2', 1)]);
    expect([a.status, b.status].sort((x, y) => x - y)).toEqual([200, 409]);
    const winner = a.status === 200 ? 'From root' : 'From root2';
    const stale = await save(agents.root, 'Too late', 1).expect(409);
    expect(stale.body.message).toMatch(/changed by someone else/);
    const now = await prisma.emailAnnouncement.findUniqueOrThrow({ where: { id } });
    expect([now.subject, now.version]).toEqual([winner, 2]);
    await save(agents.root, 'Fine', 2).expect(200);
    await agents.root.put(api('/admin/announcements/00000000-0000-4000-8000-000000000000')).set('Origin', ORIGIN).send({ ...draft, expectedVersion: 1 }).expect(404);
  });

  it('validation: required, trimmed lengths, single-line subject, paired allowlisted button, no unknown fields', async () => {
    const bad = async (body: object) => {
      const res = await create(agents.root, body);
      expect(res.status).toBe(400);
    };
    await bad({ ...draft, name: '   ' });
    await bad({ ...draft, name: 'n'.repeat(121) });
    await bad({ ...draft, subject: '' });
    await bad({ ...draft, subject: 's'.repeat(151) });
    await bad({ ...draft, subject: 'Hello\r\nBcc: someone@example.test' });
    await bad({ ...draft, subject: 'Line\u2028break' });
    await bad({ ...draft, body: ' \n ' });
    await bad({ ...draft, body: 'b'.repeat(5001) });
    await bad({ ...draft, ctaLabel: 'Open' }); // label without destination
    await bad({ ...draft, ctaDestination: 'DASHBOARD' }); // destination without label
    await bad({ ...draft, ctaLabel: 'l'.repeat(61), ctaDestination: 'DASHBOARD' });
    for (const url of ['https://evil.example', 'javascript:alert(1)', '//evil.example', '/admin', '/dashboard?next=x', 'dashboard']) {
      await bad({ ...draft, ctaLabel: 'Open', ctaDestination: url });
    }
    await bad({ ...draft, html: '<p>x</p>' });
    await bad({ ...draft, to: 'someone@example.test' });
    await bad({ ...draft, createdByUserId: ids.cara });
    await bad({ ...draft, subject: 42 });
    // Boundaries pass, trimmed.
    const ok = await create(agents.root, { name: ` ${'n'.repeat(120)} `, subject: 's'.repeat(150), body: 'b'.repeat(5000), ctaLabel: 'l'.repeat(60), ctaDestination: 'SUPPORT' }).expect(201);
    expect(ok.body.name).toBe('n'.repeat(120));
    // A cross-site Origin is refused before the route.
    await agents.root.post(api('/admin/announcements')).set('Origin', 'https://evil.example').send(draft).expect(403);
  });

  it('preview renders unsaved content safely, stores nothing, and has no way to send', async () => {
    const sent = inbox.sent.length;
    // Only this admin's rows: suites running in parallel on the shared test database write drafts and audit rows too.
    const rootId = (await prisma.user.findUniqueOrThrow({ where: { email: emails.root } })).id;
    const before = await prisma.emailAnnouncement.count({ where: { createdByUserId: rootId } });
    const audits = await prisma.auditLog.count({ where: { actorUserId: rootId } });
    const res = await agents.root
      .post(api('/admin/announcements/preview'))
      .set('Origin', ORIGIN)
      .send({ subject: 'Unsaved <subject>', body: draft.body, ctaLabel: 'Get help', ctaDestination: 'SUPPORT' })
      .expect(200);
    expect(res.body.from).toEqual({ name: 'For After', address: 'hello@example.test' });
    expect(res.body.subject).toBe('Unsaved <subject>');
    expect(res.body.html).toContain('First paragraph.<br>Second line.');
    expect(res.body.html).toContain('Second &#60;b&#62;paragraph&#60;/b&#62; &#38; more.');
    expect(res.body.html).not.toContain('<b>paragraph');
    expect(res.body.html).toContain(`href="${ORIGIN}/support"`);
    expect(res.body.text).toContain(`Get help: ${ORIGIN}/support`);
    expect(await prisma.emailAnnouncement.count({ where: { createdByUserId: rootId } })).toBe(before);
    expect(await prisma.auditLog.count({ where: { actorUserId: rootId } })).toBe(audits);
    expect(inbox.sent.length).toBe(sent); // preview never reaches the provider
    await agents.root.post(api('/admin/announcements/some-id/send')).set('Origin', ORIGIN).send({}).expect(404);
  });
});
