import { ConfigModule } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import session from 'express-session';
import { generate } from 'otplib';
import pg from 'pg';
import request from 'supertest';
import { adminSignIn } from './admin-sign-in.js';
import { FakeEmailProvider } from './fake-email.js';
import { isLocalDevelopment, promoteSuperAdmin } from '../scripts/dev-promote-super-admin.js';
import { AdminModule } from '../src/admin/admin.module.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { BillingModule } from '../src/billing/billing.module.js';
import { configureApp } from '../src/config/app.setup.js';
import { EmailProvider } from '../src/email/email-provider.js';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { RedisModule } from '../src/redis/redis.module.js';

// SUPER_ADMIN bootstrap (local maintenance script), Create admin with an
// invitation link, and billing visibility. Real HTTP, sessions, PostgreSQL and
// TOTP; the email provider is a fake inbox. Fictional accounts only.
describe('Admin onboarding and SUPER_ADMIN (e2e, PostgreSQL)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let db: pg.Client;
  const inbox = new FakeEmailProvider();
  const run = Date.now();
  const at = (n: string) => `onboard.${n}.${run}@example.test`;
  const emails = { root: at('root'), admin: at('admin'), lisa: at('lisa'), newbie: at('newbie'), racer: at('racer'), down: at('down') };
  const password = 'StrongPassword123!';
  const ids = {} as Record<string, string>;
  type Agent = ReturnType<typeof request.agent>;
  let root: Agent;
  let rootSecret = '';
  let admin: Agent;
  let lisa: Agent;
  const api = (p: string) => `/api/v1${p}`;
  const query = (text: string, values?: unknown[]) => db.query(text, values);
  const tokenFrom = (email: string) => {
    const last = inbox.to(email, 'admin-invitation').at(-1);
    return last?.text.match(/token=([A-Za-z0-9_%-]+)/)?.[1] ? decodeURIComponent(last.text.match(/token=([A-Za-z0-9_%-]+)/)![1]!) : undefined;
  };
  const accept = (token: string | undefined, newPassword = 'AnotherStrong123!') =>
    request(app.getHttpServer()).post(api('/auth/admin-invitation/accept')).send({ token, newPassword });

  beforeAll(async () => {
    process.env.THROTTLE_KEY_PREFIX = `for_after:test_onboard_throttle:${run}:`;
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule, RedisModule, AuthModule, AdminModule, BillingModule],
    })
      .overrideProvider(EmailProvider)
      .useValue(inbox)
      // Many sign-ins exceed the 5/min login limit; the limits themselves are covered in their own tests.
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app, new session.MemoryStore(), new session.MemoryStore());
    await app.init();
    prisma = app.get(PrismaService);
    db = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    for (const k of ['root', 'admin', 'lisa'] as const) {
      await request(app.getHttpServer()).post(api('/auth/register')).send({ email: emails[k], password, firstName: k, lastName: 'Test' }).expect(201);
      ids[k] = (await prisma.user.findUniqueOrThrow({ where: { email: emails[k] } })).id;
    }
    await prisma.user.updateMany({ where: { id: { in: [ids.root!, ids.admin!, ids.lisa!] } }, data: { emailVerifiedAt: new Date() } });
    await prisma.user.updateMany({ where: { id: { in: [ids.root!, ids.admin!] } }, data: { role: 'ADMIN' } });
    const r = await adminSignIn(app, emails.root, password);
    root = r.agent;
    rootSecret = r.secret;
    admin = (await adminSignIn(app, emails.admin, password)).agent;
    lisa = request.agent(app.getHttpServer());
    await lisa.post(api('/auth/login')).send({ email: emails.lisa, password }).expect(200);
  });

  afterAll(async () => {
    delete process.env.THROTTLE_KEY_PREFIX;
    await prisma?.user.deleteMany({ where: { email: { in: Object.values(emails) } } });
    await db?.end();
    await app?.close();
  });

  it('before promotion an ADMIN cannot create admins or see billing', async () => {
    await root.post(api('/admin/access/admins')).send({ email: emails.newbie, firstName: 'New', lastName: 'Admin' }).expect(403);
    await root.get(api('/admin/billing/accounts')).expect(403);
  });

  it('promotion script: exact id + email, ADMIN only, local only; idempotent; audited; ends sessions; keeps password and MFA', async () => {
    expect(isLocalDevelopment('development', 'postgresql://u:p@localhost:5432/x')).toBe(true);
    expect(isLocalDevelopment('production', 'postgresql://u:p@localhost:5432/x')).toBe(false);
    expect(isLocalDevelopment('development', 'postgresql://u:p@db.railway.internal:5432/x')).toBe(false);
    expect(isLocalDevelopment('development', 'not a url')).toBe(false);

    const before = await prisma.user.findUniqueOrThrow({ where: { id: ids.root! }, include: { adminMfaCredential: true } });
    await expect(promoteSuperAdmin(query, { id: ids.root!, email: emails.admin })).rejects.toThrow(/both this id and this email/);
    await expect(promoteSuperAdmin(query, { id: ids.lisa!, email: emails.lisa })).rejects.toThrow(/only an existing ADMIN/);
    await expect(promoteSuperAdmin(query, { id: 'not-a-uuid', email: emails.root })).rejects.toThrow(/UUID/);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: ids.root! } })).role).toBe('ADMIN');

    expect(await promoteSuperAdmin(query, { id: ids.root!, email: `  ${emails.root.toUpperCase()} ` })).toBe('promoted');
    expect(await promoteSuperAdmin(query, { id: ids.root!, email: emails.root })).toBe('already_super_admin');
    const after = await prisma.user.findUniqueOrThrow({ where: { id: ids.root! }, include: { adminMfaCredential: true } });
    expect(after.role).toBe('SUPER_ADMIN');
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(after.emailVerifiedAt).toEqual(before.emailVerifiedAt);
    expect(after.adminMfaCredential?.enabledAt).toEqual(before.adminMfaCredential?.enabledAt);
    // The revocation time is "now" in UTC: never in the future (that would revoke every later session).
    expect(after.passwordChangedAt!.getTime()).toBeLessThanOrEqual(Date.now());
    expect(after.passwordChangedAt!.getTime()).toBeGreaterThan(Date.now() - 60_000);
    const audit = await prisma.auditLog.findMany({ where: { eventType: 'SUPER_ADMIN_BOOTSTRAPPED', subjectId: ids.root } });
    expect(audit).toHaveLength(1); // the re-run wrote nothing
    expect(audit[0]).toMatchObject({ actorType: 'SYSTEM', actorUserId: null, metadata: expect.objectContaining({ previousRole: 'ADMIN', newRole: 'SUPER_ADMIN' }) });
    expect(JSON.stringify(audit)).not.toMatch(/argon|\$argon2|password|secret/i);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: ids.admin! } })).role).toBe('ADMIN'); // nobody else

    // The old session is gone; a fresh sign-in (password + TOTP) loads the new role.
    await root.get(api('/admin/access/admins')).expect(401);
    const login = await root.post(api('/auth/login')).send({ email: emails.root, password }).expect(200);
    expect(login.body).toMatchObject({ mfaRequired: true, mfaSetupRequired: false });
    await root
      .post(api('/admin-auth/totp/verify'))
      .send({ challengeId: login.body.challengeId, code: await generate({ secret: rootSecret, epoch: Math.floor(Date.now() / 1000) + 30 }) })
      .expect(200);
    expect((await root.get(api('/admin-auth/me')).expect(200)).body.role).toBe('SUPER_ADMIN');
  });

  it('billing: SUPER_ADMIN sees it (no-store); ADMIN, Customer and anonymous do not; ordinary admin access kept', async () => {
    const res = await root.get(api('/admin/billing/accounts')).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({ enabled: false, items: expect.any(Array) }); // billing off locally: honest empty state
    await admin.get(api('/admin/billing/accounts')).expect(403);
    await lisa.get(api('/admin/billing/accounts')).expect(401);
    await request(app.getHttpServer()).get(api('/admin/billing/accounts')).expect(401);
    await root.get(api('/admin/users')).expect(200);
    await root.get(api('/admin/access/admins')).expect(200);
  });

  it('create admin: SUPER_ADMIN only; names + email only; never SUPER_ADMIN; collisions never elevate; concurrent duplicates', async () => {
    await admin.post(api('/admin/access/admins')).send({ email: emails.newbie, firstName: 'New', lastName: 'Admin' }).expect(403);
    await lisa.post(api('/admin/access/admins')).send({ email: emails.newbie, firstName: 'New', lastName: 'Admin' }).expect(401);
    await request(app.getHttpServer()).post(api('/admin/access/admins')).send({ email: emails.newbie, firstName: 'N', lastName: 'A' }).expect(401);
    for (const forged of [{ role: 'SUPER_ADMIN' }, { password: 'x' }, { status: 'ACTIVE' }, { permissions: ['all'] }])
      await root.post(api('/admin/access/admins')).send({ email: emails.newbie, firstName: 'New', lastName: 'Admin', ...forged }).expect(400);
    await root.post(api('/admin/access/admins')).send({ email: 'not-an-email', firstName: 'New', lastName: 'Admin' }).expect(400);
    await root.post(api('/admin/access/admins')).send({ email: emails.newbie, firstName: ' ', lastName: 'Admin' }).expect(400);

    // An existing Customer's address: 409, and that account is untouched.
    const taken = await root.post(api('/admin/access/admins')).send({ email: emails.lisa.toUpperCase(), firstName: 'X', lastName: 'Y' }).expect(409);
    expect(taken.body.message).toBe('An account with this email already exists.');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: ids.lisa! } })).role).toBe('CUSTOMER');

    const results = await Promise.all([1, 2].map(() => root.post(api('/admin/access/admins')).send({ email: emails.racer, firstName: 'Race', lastName: 'Admin' })));
    expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([201, 409]);
    expect(await prisma.user.count({ where: { email: emails.racer } })).toBe(1);

    const created = await root.post(api('/admin/access/admins')).send({ email: emails.newbie, firstName: 'New', lastName: 'Admin' }).expect(201);
    expect(created.body).toEqual({ id: expect.any(String), invitation: 'sent' });
    ids.newbie = created.body.id;
    const row = await prisma.user.findUniqueOrThrow({ where: { id: ids.newbie! } });
    expect(row).toMatchObject({ role: 'ADMIN', status: 'ACTIVE', emailVerifiedAt: null, passwordChangedAt: null });
    const list = (await root.get(api('/admin/access/admins')).query({ search: emails.newbie }).expect(200)).body;
    expect(list.items[0]).toMatchObject({ id: ids.newbie, role: 'ADMIN', invitationPending: true, mfaEnrolled: false });
  });

  it('invitation: no sign-in before accepting; resend supersedes; single use; expiry; then password, then TOTP setup required', async () => {
    const first = tokenFrom(emails.newbie);
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Before accepting, no password works.
    await request(app.getHttpServer()).post(api('/auth/login')).send({ email: emails.newbie, password }).expect(401);

    await root.post(api(`/admin/access/admins/${ids.newbie}/invitation`)).expect(200, { id: ids.newbie, invitation: 'sent' });
    const second = tokenFrom(emails.newbie);
    expect(second).not.toBe(first);
    await accept(first).expect(400); // superseded

    // An expired link is refused.
    await prisma.authToken.updateMany({ where: { userId: ids.newbie, purpose: 'ADMIN_INVITATION', consumedAt: null }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await accept(second).expect(400);
    await root.post(api(`/admin/access/admins/${ids.newbie}/invitation`)).expect(200);
    const third = tokenFrom(emails.newbie);
    await accept(third, 'short').expect(400); // the normal password rule
    await accept(third).expect(200, { success: true });
    await accept(third).expect(400); // single use
    const row = await prisma.user.findUniqueOrThrow({ where: { id: ids.newbie! } });
    expect(row.emailVerifiedAt).not.toBeNull();
    expect(row.role).toBe('ADMIN');

    // The password alone opens nothing: TOTP setup comes next, and no session exists yet.
    const agent = request.agent(app.getHttpServer());
    const login = await agent.post(api('/auth/login')).send({ email: emails.newbie, password: 'AnotherStrong123!' }).expect(200);
    expect(login.body).toMatchObject({ mfaRequired: true, mfaSetupRequired: true });
    await agent.get(api('/admin/users')).expect(401);
    await root.post(api(`/admin/access/admins/${ids.newbie}/invitation`)).expect(409); // already accepted

    // The audit trail has references only: no token, no password.
    const audit = await prisma.auditLog.findMany({ where: { subjectId: ids.newbie, eventType: { in: ['ADMIN_CREATED', 'ADMIN_INVITATION_SENT', 'ADMIN_INVITATION_ACCEPTED'] } } });
    expect(new Set(audit.map((a) => a.eventType))).toEqual(new Set(['ADMIN_CREATED', 'ADMIN_INVITATION_SENT', 'ADMIN_INVITATION_ACCEPTED']));
    expect(audit.find((a) => a.eventType === 'ADMIN_CREATED')).toMatchObject({ actorType: 'SUPER_ADMIN', actorUserId: ids.root, metadata: { role: 'ADMIN' } });
    expect(JSON.stringify(audit)).not.toContain(first!);
    expect(JSON.stringify(audit)).not.toMatch(/AnotherStrong|token/);
  });

  it('a provider failure is reported as not sent (the account exists; resend works)', async () => {
    inbox.failNext(1, 'unknown_error', false);
    const res = await root.post(api('/admin/access/admins')).send({ email: emails.down, firstName: 'Down', lastName: 'Admin' }).expect(201);
    expect(res.body.invitation).toBe('not_sent');
    await root.post(api(`/admin/access/admins/${res.body.id}/invitation`)).expect(200, { id: res.body.id, invitation: 'sent' });
  });
});
