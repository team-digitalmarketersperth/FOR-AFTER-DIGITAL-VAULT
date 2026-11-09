import { Logger } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import session from 'express-session';
import request from 'supertest';
import { adminSignIn } from './admin-sign-in.js';
import { FakeEmailProvider } from './fake-email.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { configureApp } from '../src/config/app.setup.js';
import { EmailProvider } from '../src/email/email-provider.js';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { RedisModule } from '../src/redis/redis.module.js';
import { RedisService } from '../src/redis/redis.service.js';

// Admin account settings (own profile, password, current-email verification,
// security/session summary) over real HTTP, sessions, MFA and PostgreSQL. The
// email provider is the fake inbox. Fictional admins only; no real account is
// touched.
describe('Admin account settings (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const inbox = new FakeEmailProvider();
  const run = Date.now();
  const at = (n: string) => `acct-admin.${n}.${run}@example.test`;
  const people = { admin: at('admin'), root: at('root'), other: at('other'), cara: at('cara'), half: at('half') };
  const password = 'StrongPassword123!';
  const newPassword = 'A brand new long passphrase 42';
  type Agent = ReturnType<typeof request.agent>;
  const agents = {} as Record<string, Agent>;
  const ids = {} as Record<string, string>;
  let adminCodes: string[] = [];
  const api = (p: string) => `/api/v1${p}`;
  const ORIGIN = 'https://app.example.test';
  const ENV = ['EMAIL_PROVIDER', 'APP_BASE_URL', 'FRONTEND_URL'];
  const resetThrottle = async () => {
    const redis = app.get(RedisService).client;
    for (const key of await redis.keys(`${process.env.THROTTLE_KEY_PREFIX}*`)) await redis.del(key);
  };

  beforeAll(async () => {
    Object.assign(process.env, { EMAIL_PROVIDER: 'disabled', APP_BASE_URL: ORIGIN, FRONTEND_URL: ORIGIN });
    const moduleRef = await Test.createTestingModule({ imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule, RedisModule, AuthModule] })
      .overrideProvider(EmailProvider)
      .useValue(inbox)
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app, new session.MemoryStore(), new session.MemoryStore());
    await app.init();
    prisma = app.get(PrismaService);
    for (const [k, email] of Object.entries(people)) {
      await resetThrottle();
      await request(app.getHttpServer()).post(api('/auth/register')).send({ email, password, firstName: k, lastName: 'Test' }).expect(201);
      ids[k] = (await prisma.user.findUniqueOrThrow({ where: { email } })).id;
    }
    await prisma.user.updateMany({ where: { id: { in: [ids.admin!, ids.root!, ids.other!, ids.cara!, ids.half!] } }, data: { emailVerifiedAt: new Date() } });
    await prisma.user.updateMany({ where: { id: { in: [ids.admin!, ids.other!, ids.half!] } }, data: { role: 'ADMIN' } });
    await prisma.user.update({ where: { id: ids.root! }, data: { role: 'SUPER_ADMIN', emailVerifiedAt: null } }); // unverified on purpose
    for (const k of ['admin', 'root', 'other'] as const) {
      await resetThrottle();
      const signedIn = await adminSignIn(app, people[k], password);
      agents[k] = signedIn.agent;
      if (k === 'admin') adminCodes = signedIn.recoveryCodes;
    }
    await resetThrottle();
    agents.cara = request.agent(app.getHttpServer());
    await agents.cara.post(api('/auth/login')).send({ email: people.cara, password }).expect(200);
    agents.half = request.agent(app.getHttpServer()); // password only, two-factor never completed
    await agents.half.post(api('/auth/login')).send({ email: people.half, password }).expect(200);
    inbox.sent.length = 0;
  });

  beforeEach(resetThrottle);

  afterAll(async () => {
    for (const k of ENV) delete process.env[k];
    await prisma?.user.deleteMany({ where: { id: { in: Object.values(ids) } } });
    await app?.close();
  });

  it('only a signed-in ADMIN or SUPER_ADMIN with completed two-factor reaches it; each sees only their own account', async () => {
    const routes: [string, string, object?][] = [
      ['get', '/admin/account'],
      ['patch', '/admin/account/profile', { firstName: 'X' }],
      ['post', '/admin/account/password', { currentPassword: password, newPassword }],
      ['post', '/admin/account/verification'],
    ];
    for (const [label, agent] of [
      ['anonymous', request(app.getHttpServer())],
      ['customer', agents.cara!],
      ['admin without two-factor', agents.half!],
    ] as const) {
      for (const [method, path, body] of routes) {
        const req = (agent as unknown as Record<string, (p: string) => request.Test>)[method]!(api(path)).set('Origin', ORIGIN);
        const res = await (body ? req.send(body) : req);
        expect([401, 403], `${label} ${method} ${path}`).toContain(res.status);
      }
    }
    for (const k of ['admin', 'root'] as const) {
      const res = await agents[k]!.get(api('/admin/account')).expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body.profile.email).toBe(people[k]);
    }
    // Nothing (query, body) can point it at another account.
    const res = await agents.admin!.get(api(`/admin/account?id=${ids.other}&userId=${ids.other}`));
    expect([200, 400]).toContain(res.status);
    if (res.status === 200) expect(res.body.profile.email).toBe(people.admin);
  });

  it('summary: real verification, two-factor and session facts; never hashes, secrets, codes, session ids or cookies', async () => {
    const mine = (await agents.admin!.get(api('/admin/account')).expect(200)).body;
    expect(mine.profile).toEqual({ firstName: 'admin', lastName: 'Test', email: people.admin, emailVerified: true, role: 'ADMIN' });
    expect(mine.security).toMatchObject({ twoFactorEnabled: true, recoveryCodesRemaining: 10, passwordChangedAt: null });
    expect(mine.session.signedInAt).toBeTruthy();
    expect(mine.session.twoFactorAt).toBeTruthy();
    expect(mine.session.idleTimeoutMinutes).toBeGreaterThan(0);
    expect(mine.recentSignIns.length).toBeGreaterThanOrEqual(1);
    expect(Object.keys(mine.recentSignIns[0]).sort()).toEqual(['at', 'device', 'network']);
    expect((await agents.root!.get(api('/admin/account')).expect(200)).body.profile).toMatchObject({ emailVerified: false, role: 'SUPER_ADMIN' });
    const text = JSON.stringify(mine);
    expect(text).not.toMatch(/passwordHash|totpSecret|codeHash|argon2|sid|connect\.|cookie"/i);
    for (const code of adminCodes) expect(text).not.toContain(code);
  });

  it('profile: name only; role, email, status, verification, MFA or another id → 400 and nothing changes; header identity updates', async () => {
    for (const extra of [{ role: 'SUPER_ADMIN' }, { email: at('evil') }, { status: 'ACTIVE' }, { emailVerifiedAt: new Date().toISOString() }, { twoFactorEnabled: false }, { id: ids.other }, { userId: ids.other }]) {
      await agents.admin!.patch(api('/admin/account/profile')).set('Origin', ORIGIN).send({ firstName: 'Ada', ...extra }).expect(400);
    }
    // Blank names are refused; the stored name is kept.
    await agents.admin!.patch(api('/admin/account/profile')).set('Origin', ORIGIN).send({ firstName: '   ' }).expect(400);
    await agents.admin!.patch(api('/admin/account/profile')).set('Origin', 'https://evil.example').send({ firstName: 'Ada' }).expect(403);
    let row = await prisma.user.findUniqueOrThrow({ where: { id: ids.admin! } });
    expect(row).toMatchObject({ role: 'ADMIN', email: people.admin, firstName: 'admin' });
    const saved = await agents.admin!.patch(api('/admin/account/profile')).set('Origin', ORIGIN).send({ firstName: ' Ada ', lastName: 'Lovelace' }).expect(200);
    expect(saved.body).toEqual({ firstName: 'Ada', lastName: 'Lovelace' });
    expect((await agents.admin!.get(api('/admin-auth/me')).expect(200)).body).toMatchObject({ firstName: 'Ada', lastName: 'Lovelace' });
    row = await prisma.user.findUniqueOrThrow({ where: { id: ids.admin! } });
    expect(row.role).toBe('ADMIN');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: ids.other! } })).firstName).toBe('other'); // untouched
    expect(await prisma.customerActivity.count({ where: { userId: ids.admin! } })).toBe(0); // not a Customer history event
  });

  it('password: needs the current password; on success this session stays (with its two-factor), every other session of the account ends', async () => {
    // A second browser for the same admin (recovery code: a fresh TOTP step is not available yet).
    const login = await request(app.getHttpServer()).post(api('/auth/login')).send({ email: people.admin, password }).expect(200);
    const second = request.agent(app.getHttpServer());
    await second.post(api('/admin-auth/recovery/verify')).send({ challengeId: login.body.challengeId, recoveryCode: adminCodes[0] }).expect(200);
    await second.get(api('/admin/account')).expect(200);

    const wrong = await agents.admin!.post(api('/admin/account/password')).set('Origin', ORIGIN).send({ currentPassword: 'wrong-password-123', newPassword });
    expect(wrong.status).toBe(400);
    expect(wrong.body.message).toMatch(/current password is incorrect/);
    await agents.admin!.post(api('/admin/account/password')).set('Origin', ORIGIN).send({ currentPassword: password, newPassword: 'short' }).expect(400);
    await agents.admin!.post(api('/admin/account/password')).set('Origin', ORIGIN).send({ currentPassword: password, newPassword, userId: ids.other }).expect(400);

    const ok = await agents.admin!.post(api('/admin/account/password')).set('Origin', ORIGIN).send({ currentPassword: password, newPassword }).expect(200);
    expect(ok.body).toEqual({ success: true });
    await agents.admin!.get(api('/admin/account')).expect(200); // still signed in, MFA kept
    await second.get(api('/admin/account')).expect(401); // the other session is gone server-side
    await agents.other!.get(api('/admin/account')).expect(200); // another admin's session is untouched
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { eventType: 'PASSWORD_CHANGED', subjectId: ids.admin! }, orderBy: { createdAt: 'desc' } });
    expect(audit.actorType).toBe('ADMIN');
    expect(JSON.stringify(audit)).not.toContain(newPassword);
    expect(await prisma.user.findUniqueOrThrow({ where: { id: ids.other! }, select: { passwordChangedAt: true } })).toEqual({ passwordChangedAt: null });
    // The new password works for the next sign-in.
    await request(app.getHttpServer()).post(api('/auth/login')).send({ email: people.admin, password: newPassword }).expect(200);
  });

  it('verification: an unverified admin gets the existing link at their OWN address only; a verified one is told so; nothing is marked verified', async () => {
    await agents.admin!.post(api('/admin/account/verification')).set('Origin', ORIGIN).expect(409);
    const logs: string[] = [];
    const spies = (['log', 'warn', 'error'] as const).map((m) =>
      vi.spyOn(Logger.prototype, m).mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' '))),
    );
    try {
      await agents.root!.post(api('/admin/account/verification')).set('Origin', ORIGIN).send({ email: at('elsewhere') }).expect(202);
      await vi.waitFor(() => expect(inbox.sent.some((m) => m.kind === 'verify-email')).toBe(true));
    } finally {
      for (const s of spies) s.mockRestore();
    }
    expect(inbox.sent.map((m) => [m.kind, m.to])).toEqual([['verify-email', people.root]]);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: ids.root! } })).emailVerifiedAt).toBeNull();
    const link = inbox.sent[0]!.text.match(/token=([\w-]+)/)?.[1];
    expect(link).toBeTruthy();
    expect(logs.join('\n')).not.toContain(link!); // tokens never logged
  });
});
