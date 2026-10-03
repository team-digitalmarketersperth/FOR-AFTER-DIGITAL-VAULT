import { ConfigModule } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import { Queue } from 'bullmq';
import { RedisStore } from 'connect-redis';
import { randomUUID } from 'node:crypto';
import { generate } from 'otplib';
import request from 'supertest';
import { adminSignIn } from './admin-sign-in.js';
import { AdminModule } from '../src/admin/admin.module.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { configureApp } from '../src/config/app.setup.js';
import {
  DeathNoticeDelivery,
  type SafetyNoticeInput,
} from '../src/death-verification/death-verification-notice.js';
import { DeathVerificationModule } from '../src/death-verification/death-verification.module.js';
import { releaseJobId } from '../src/message-release/message-release-queue.service.js';
import { MessageReleaseService } from '../src/message-release/message-release.service.js';
import { MessageSchedulesModule } from '../src/message-schedules/message-schedules.module.js';
import { MessagesModule } from '../src/messages/messages.module.js';
import type { OtpDeliveryInput } from '../src/otp-auth/otp-auth.service.js';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { RecipientAuthModule } from '../src/recipient-auth/recipient-auth.module.js';
import { RecipientOtpDelivery } from '../src/recipient-auth/recipient-otp-delivery.js';
import { RecipientPortalModule } from '../src/recipient-portal/recipient-portal.module.js';
import { RecipientsModule } from '../src/recipients/recipients.module.js';
import { RedisModule } from '../src/redis/redis.module.js';
import { RedisService } from '../src/redis/redis.service.js';
import { TrustedContactAuthModule } from '../src/trusted-contact-auth/trusted-contact-auth.module.js';
import { TrustedContactOtpDelivery } from '../src/trusted-contact-auth/trusted-contact-auth.service.js';
import { TrustedContactPortalModule } from '../src/trusted-contact-portal/trusted-contact-portal.module.js';
import { TrustedContactsModule } from '../src/trusted-contacts/trusted-contacts.module.js';

// Step 16 end to end: real HTTP, guards, PostgreSQL, Redis (MFA challenges,
// sessions via connect-redis, rate limits) and both BullMQ queues. TOTP codes
// come from otplib, as from an authenticator app. Fictional data only; test
// users are deleted afterwards (AuditLog rows are append-only and remain).
describe('Admin backend (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let releaseQueue: Queue;
  let deathQueue: Queue;
  const run = Date.now();
  // Random, not the timestamp: parallel e2e files can share a millisecond.
  const tag = randomUUID().slice(0, 8);
  const at = (name: string) => `${name}.${tag}@example.test`;
  const releaseQueueName = `test-admin-release-${run}`;
  const deathQueueName = `test-admin-dv-${run}`;
  const password = 'StrongPassword123!';
  const users = {
    admin: at('adm.ada'),
    admin2: at('adm.ben'),
    admin3: at('adm.cleo'),
    root: at('adm.root'),
    lisa: at('adm.lisa'),
    noah: at('adm.noah'),
    olga: at('adm.olga'),
  };
  const DAVID = at('adm.david');
  const SOFIA = at('adm.sofia');
  const ZERO = '00000000-0000-4000-8000-000000000000';
  const PRIVATE_TEXT = 'Fictional private message text for admin e2e.';

  const notices: SafetyNoticeInput[] = [];
  const otps: OtpDeliveryInput[] = [];
  const otpDelivery = {
    sendOtp: vi.fn(async (input: OtpDeliveryInput) => {
      otps.push(input);
    }),
  };

  type Agent = ReturnType<typeof request.agent>;
  const agents: Record<string, Agent> = {};
  const ids: Record<string, string> = {};
  let secret = '';
  let recoveryCodes: string[] = [];
  const api = (path: string) => `/api/v1${path}`;
  const http = () => request(app.getHttpServer());
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const until = async (check: () => Promise<boolean>, ms = 15_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await check()) return;
      await sleep(200);
    }
    throw new Error('condition not met in time');
  };
  const userId = async (email: string) =>
    (await prisma.user.findUniqueOrThrow({ where: { email } })).id;
  const signIn = async (email: string) => {
    const agent = request.agent(app.getHttpServer());
    await agent.post(api('/auth/login')).send({ email, password }).expect(200);
    return agent;
  };
  const otpSignIn = async (
    base: 'trusted-contact-auth' | 'recipient-auth',
    email: string,
  ) => {
    const { challengeId } = (
      await http()
        .post(api(`/${base}/request-otp`))
        .send({ email })
        .expect(202)
    ).body;
    const agent = request.agent(app.getHttpServer());
    await agent
      .post(api(`/${base}/verify-otp`))
      .send({
        challengeId,
        code: otps.findLast((o) => o.email === email)!.code,
      })
      .expect(200);
    return agent;
  };
  const passwordLogin = async (agent: Agent, email = users.admin) =>
    (await agent.post(api('/auth/login')).send({ email, password }).expect(200))
      .body as { challengeId: string; mfaSetupRequired: boolean };
  // Next 30 s step: inside the ±30 s window and newer than the last one used.
  const nextCode = () =>
    generate({ secret, epoch: Math.floor(Date.now() / 1000) + 30 });
  const auditFor = (subjectId: string, eventType: string) =>
    agents.admin
      .get(api('/admin/audit-logs'))
      .query({ subjectId, eventType })
      .expect(200);

  beforeAll(async () => {
    Object.assign(process.env, {
      RELEASE_QUEUE_NAME: releaseQueueName,
      RELEASE_RECONCILE_INTERVAL_SECONDS: '3600',
      DEATH_VERIFICATION_QUEUE_NAME: deathQueueName,
      DEATH_VERIFICATION_SAFEGUARD_SECONDS: '2',
      DEATH_VERIFICATION_RECONCILE_INTERVAL_SECONDS: '3600',
      TRUSTED_CONTACT_OTP_IP_REQUEST_LIMIT: '10000',
      TRUSTED_CONTACT_OTP_VERIFY_IP_LIMIT: '10000',
      TRUSTED_CONTACT_OTP_REQUEST_LIMIT: '100',
      RECIPIENT_OTP_IP_REQUEST_LIMIT: '10000',
      RECIPIENT_OTP_VERIFY_IP_LIMIT: '10000',
    });
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        RedisModule,
        AuthModule,
        RecipientsModule,
        TrustedContactsModule,
        MessagesModule,
        MessageSchedulesModule,
        RecipientAuthModule,
        RecipientPortalModule,
        TrustedContactAuthModule,
        TrustedContactPortalModule,
        DeathVerificationModule,
        AdminModule,
      ],
    })
      // Many sign-ins exceed the 5/min login limit; the limit itself is
      // covered in auth.controller.spec.ts.
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .overrideProvider(DeathNoticeDelivery)
      .useValue({
        sendAccountHolderSafetyNotice: vi.fn(async (n: SafetyNoticeInput) => {
          notices.push(n);
        }),
      })
      .overrideProvider(TrustedContactOtpDelivery)
      .useValue(otpDelivery)
      .overrideProvider(RecipientOtpDelivery)
      .useValue(otpDelivery)
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    // Real Redis sessions, as in main.ts: Customer and admin sessions under
    // separate prefixes (own prefixes for tests).
    configureApp(
      app,
      new RedisStore({
        client: app.get(RedisService).client,
        prefix: `for_after:test_sess:${run}:`,
      }),
      new RedisStore({
        client: app.get(RedisService).client,
        prefix: `for_after:test_admin_sess:${run}:`,
      }),
    );
    await app.init();
    prisma = app.get(PrismaService);
    releaseQueue = new Queue(releaseQueueName, {
      connection: { url: process.env.REDIS_URL! },
    });
    deathQueue = new Queue(deathQueueName, {
      connection: { url: process.env.REDIS_URL! },
    });

    for (const [key, email] of Object.entries(users)) {
      await http()
        .post(api('/auth/register'))
        .send({ email, password, firstName: key, lastName: 'Test' })
        .expect(201);
    }
    // No admin sign-up exists: an operator sets the role.
    await prisma.user.updateMany({
      where: { email: { in: [users.admin, users.admin2, users.admin3] } },
      data: { role: 'ADMIN' },
    });
    await prisma.user.update({
      where: { email: users.root },
      data: { role: 'SUPER_ADMIN' },
    });
    for (const key of ['lisa', 'noah', 'olga'] as const) {
      agents[key] = await signIn(users[key]);
    }
    for (const key of ['admin2', 'root'] as const) {
      agents[key] = (await adminSignIn(app, users[key], password)).agent;
    }
    ids.lisa = await userId(users.lisa);
    ids.admin = await userId(users.admin);
    ids.admin2 = await userId(users.admin2);
    ids.root = await userId(users.root);
    const mia = (
      await agents.lisa
        .post(api('/recipients'))
        .send({ firstName: 'Mia', privateNote: 'Fictional private note.' })
        .expect(201)
    ).body.id as string;
    ids.lisaMessage = (
      await agents.lisa
        .post(api('/messages'))
        .send({
          title: 'Private',
          textContent: PRIVATE_TEXT,
          recipientIds: [mia],
        })
        .expect(201)
    ).body.id;
  });

  afterAll(async () => {
    await prisma?.user.deleteMany({
      where: { email: { in: Object.values(users) } },
    });
    await app?.close();
    for (const q of [releaseQueue, deathQueue]) {
      await q?.obliterate({ force: true });
      await q?.close();
    }
  });

  describe('admin sign-in: password → MFA → session', () => {
    it('the password alone gives a challenge, no session', async () => {
      const agent = request.agent(app.getHttpServer());
      const res = await agent
        .post(api('/auth/login'))
        .send({ email: users.admin, password })
        .expect(200);
      expect(res.body).toEqual({
        mfaRequired: true,
        mfaSetupRequired: true,
        challengeId: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        expiresInSeconds: 300,
      });
      expect(res.headers['set-cookie']).toBeUndefined();
      await agent.get(api('/admin-auth/me')).expect(401);
      await agent.get(api('/auth/me')).expect(401);
      await agent.get(api('/admin/users')).expect(401);
      ids.firstChallenge = res.body.challengeId;
      agents.admin = agent;
    });

    it('setup returns the secret once; confirm enables MFA and creates the session', async () => {
      const agent = agents.admin;
      const setup = await agent
        .post(api('/admin-auth/totp/setup'))
        .send({ challengeId: ids.firstChallenge })
        .expect(200);
      secret = setup.body.secret;
      expect(secret).toMatch(/^[A-Z2-7]{32}$/);
      expect(setup.body.otpauthUri).toMatch(
        /^otpauth:\/\/totp\/For%20After:.*secret=/,
      );
      const stored = await prisma.adminMfaCredential.findUniqueOrThrow({
        where: { userId: ids.admin },
      });
      expect(stored.enabledAt).toBeNull();
      expect(stored.totpSecretEncrypted).not.toContain(secret);

      await agent
        .post(api('/admin-auth/totp/confirm'))
        .send({ challengeId: ids.firstChallenge, code: 'abc123' })
        .expect(400);
      const confirmed = await agent
        .post(api('/admin-auth/totp/confirm'))
        .send({
          challengeId: ids.firstChallenge,
          code: await generate({ secret }),
        })
        .expect(200);
      // The admin session has its own cookie; the Customer cookie is untouched.
      const cookies = String(confirmed.headers['set-cookie']);
      expect(cookies).toMatch(/^for_after_admin_session=.*HttpOnly/i);
      expect(cookies).not.toMatch(/(^|, )for_after_session=/);
      recoveryCodes = confirmed.body.recoveryCodes;
      expect(recoveryCodes).toHaveLength(10);
      expect(confirmed.body).toMatchObject({
        email: users.admin,
        role: 'ADMIN',
        mfaEnabled: true,
        mfaVerified: true,
      });
      const me = await agent.get(api('/admin-auth/me')).expect(200);
      expect(me.body).toMatchObject({
        id: ids.admin,
        mfaEnabled: true,
        mfaVerified: true,
      });
      expect(JSON.stringify(me.body)).not.toMatch(
        /secret|totp|recovery|passwordHash|sid/i,
      );
      const codes = await prisma.adminMfaRecoveryCode.findMany({
        where: { userId: ids.admin },
      });
      expect(codes).toHaveLength(10);
      expect(JSON.stringify(codes)).not.toContain(recoveryCodes[0]);
      // The challenge was consumed.
      await agent
        .post(api('/admin-auth/totp/setup'))
        .send({ challengeId: ids.firstChallenge })
        .expect(401);
    });

    it('logout, then normal TOTP sign-in; the same code cannot be replayed', async () => {
      const agent = agents.admin;
      await agent.post(api('/admin-auth/logout')).expect(200);
      await agent.get(api('/admin-auth/me')).expect(401);

      const { challengeId, mfaSetupRequired } = await passwordLogin(agent);
      expect(mfaSetupRequired).toBe(false);
      await agent
        .post(api('/admin-auth/totp/setup'))
        .send({ challengeId })
        .expect(409);
      const wrong = await agent
        .post(api('/admin-auth/totp/verify'))
        .send({ challengeId, code: '000000' })
        .expect(401);
      expect(wrong.body.message).toMatch(/invalid or has expired/);
      const code = await nextCode();
      await agent
        .post(api('/admin-auth/totp/verify'))
        .send({ challengeId, code })
        .expect(200);
      await agent.get(api('/admin-auth/me')).expect(200);

      const again = await passwordLogin(request.agent(app.getHttpServer()));
      await http()
        .post(api('/admin-auth/totp/verify'))
        .send({ challengeId: again.challengeId, code })
        .expect(401);
    });

    it('recovery code signs in once; reuse fails; usage audited', async () => {
      const other = request.agent(app.getHttpServer());
      const first = await passwordLogin(other);
      await other
        .post(api('/admin-auth/recovery/verify'))
        .send({
          challengeId: first.challengeId,
          recoveryCode: recoveryCodes[0],
        })
        .expect(200);
      await other.get(api('/admin-auth/me')).expect(200);
      const second = await passwordLogin(request.agent(app.getHttpServer()));
      await http()
        .post(api('/admin-auth/recovery/verify'))
        .send({
          challengeId: second.challengeId,
          recoveryCode: recoveryCodes[0],
        })
        .expect(401);
      const audit = await auditFor(ids.admin, 'ADMIN_RECOVERY_CODE_USED');
      expect(audit.body.items).toHaveLength(1);
      expect(JSON.stringify(audit.body)).not.toContain(recoveryCodes[0]);
    });

    it('5 wrong codes invalidate the challenge', async () => {
      const { challengeId } = await passwordLogin(
        request.agent(app.getHttpServer()),
      );
      for (let i = 0; i < 5; i++) {
        await http()
          .post(api('/admin-auth/totp/verify'))
          .send({ challengeId, code: '000000' })
          .expect(401);
      }
      await http()
        .post(api('/admin-auth/totp/verify'))
        .send({ challengeId, code: await nextCode() })
        .expect(401);
    });

    it('sign-in steps are audited without secrets', async () => {
      const res = await agents.admin
        .get(api('/admin/audit-logs'))
        .query({ actorUserId: ids.admin, limit: 100 })
        .expect(200);
      const events = res.body.items.map(
        (e: { eventType: string }) => e.eventType,
      );
      for (const e of [
        'ADMIN_PASSWORD_AUTH_SUCCEEDED',
        'ADMIN_MFA_SETUP_COMPLETED',
        'ADMIN_MFA_VERIFIED',
        'ADMIN_MFA_FAILED',
        'ADMIN_LOGIN',
        'ADMIN_LOGOUT',
      ]) {
        expect(events).toContain(e);
      }
      const text = JSON.stringify(res.body);
      for (const s of [secret, password, ...recoveryCodes]) {
        expect(text).not.toContain(s);
      }
    });
  });

  describe('Customer and admin sessions in one browser (separate cookies)', () => {
    const cookieValue = (agent: Agent, name: string) =>
      // supertest agents keep a cookie jar like a browser profile.
      (
        agent as unknown as {
          jar: { getCookie: (n: string, o: object) => { value: string } };
        }
      ).jar.getCookie(name, {
        domain: '127.0.0.1',
        path: '/',
        secure: false,
        script: false,
      })?.value;

    it('both stay signed in; each logout ends only its own session', async () => {
      // "Tab 2": admin password + TOTP. "Tab 1": a Customer login, same jar.
      const { agent } = await adminSignIn(app, users.admin3, password);
      await agent
        .post(api('/auth/login'))
        .send({ email: users.noah, password })
        .expect(200);
      expect((await agent.get(api('/auth/me')).expect(200)).body.email).toBe(
        users.noah,
      );
      const me = await agent.get(api('/admin-auth/me')).expect(200);
      expect(me.body).toMatchObject({ email: users.admin3, mfaVerified: true });
      await agent.get(api('/admin/dashboard')).expect(200);
      await agent.get(api('/recipients')).expect(200);

      // Customer logout → admin unaffected.
      const out = await agent.post(api('/auth/logout')).expect(200);
      expect(String(out.headers['set-cookie'])).toMatch(/^for_after_session=;/);
      await agent.get(api('/auth/me')).expect(401);
      await agent.get(api('/admin-auth/me')).expect(200);

      // Customer back in; admin logout → Customer unaffected, audited.
      await agent
        .post(api('/auth/login'))
        .send({ email: users.noah, password })
        .expect(200);
      const adminOut = await agent.post(api('/admin-auth/logout')).expect(200);
      expect(String(adminOut.headers['set-cookie'])).toMatch(
        /^for_after_admin_session=;/,
      );
      await agent.get(api('/admin-auth/me')).expect(401);
      await agent.get(api('/admin/dashboard')).expect(401);
      await agent.get(api('/auth/me')).expect(200);
      const admin3 = await userId(users.admin3);
      expect(
        await prisma.auditLog.count({
          where: { eventType: 'ADMIN_LOGOUT', actorUserId: admin3 },
        }),
      ).toBe(1);
    });

    it('a cookie only works under its own name (no cross-presentation)', async () => {
      const customer = await signIn(users.olga);
      const sid = cookieValue(customer, 'for_after_session');
      expect(sid).toBeTruthy();
      // The Customer session id sent as the admin cookie finds nothing.
      await http()
        .get(api('/admin-auth/me'))
        .set('Cookie', `for_after_admin_session=${sid}`)
        .expect(401);
      const adminSid = cookieValue(agents.admin2, 'for_after_admin_session');
      expect(adminSid).toBeTruthy();
      // And an MFA-verified admin session sent as the Customer cookie.
      await http()
        .get(api('/auth/me'))
        .set('Cookie', `for_after_session=${adminSid}`)
        .expect(401);
      await http()
        .get(api('/admin-auth/me'))
        .set('Cookie', `for_after_admin_session=${adminSid}`)
        .expect(200);
    });

    it('the admin password alone sets no cookie and opens nothing', async () => {
      const agent = request.agent(app.getHttpServer());
      const login = await agent
        .post(api('/auth/login'))
        .send({ email: users.admin2, password })
        .expect(200);
      expect(login.headers['set-cookie']).toBeUndefined();
      expect(login.body).toMatchObject({ mfaRequired: true });
      await agent.get(api('/admin-auth/me')).expect(401);
      await agent.get(api('/admin/users')).expect(401);
      await agent.get(api('/auth/me')).expect(401);
    });
  });

  describe('other principals never reach admin routes', () => {
    it('Customer: 401 on admin APIs (its cookie is never read there); no challenge to use for MFA routes', async () => {
      for (const path of [
        '/admin/users',
        '/admin/dashboard',
        '/admin/audit-logs',
        '/admin/system/queues',
        '/admin/death-verifications',
        '/admin-auth/me',
      ]) {
        // The Customer cookie is never read on admin routes: no admin session.
        await agents.lisa.get(api(path)).expect(401);
      }
      await agents.lisa
        .post(api(`/admin/users/${ids.lisa}/suspend`))
        .send({ reason: 'x' })
        .expect(401);
      const fake = 'A'.repeat(43);
      await agents.lisa
        .post(api('/admin-auth/totp/setup'))
        .send({ challengeId: fake })
        .expect(401);
      // Customer login still returns the user and a session, never a challenge.
      const login = await http()
        .post(api('/auth/login'))
        .send({ email: users.lisa, password })
        .expect(200);
      expect(login.body).toMatchObject({ email: users.lisa, role: 'CUSTOMER' });
      expect(login.body).not.toHaveProperty('challengeId');
    });

    it('Trusted Contact session: 401 on admin APIs and MFA routes', async () => {
      await agents.lisa
        .post(api('/trusted-contacts'))
        .send({ firstName: 'David', email: DAVID })
        .expect(201);
      agents.david = await otpSignIn('trusted-contact-auth', DAVID);
      await agents.david.get(api('/admin/users')).expect(401);
      await agents.david.get(api('/admin-auth/me')).expect(401);
      await agents.david
        .post(api('/admin-auth/totp/setup'))
        .send({ challengeId: 'A'.repeat(43) })
        .expect(401);
    });

    it('unauthenticated: 401 everywhere', async () => {
      await http().get(api('/admin/users')).expect(401);
      await http().get(api('/admin/system/queues')).expect(401);
    });
  });

  describe('users', () => {
    it('lists with search, filters and bounded pagination; safe fields only', async () => {
      const res = await agents.admin
        .get(api('/admin/users'))
        .query({ search: `adm.lisa.${tag}`, limit: 5 })
        .expect(200);
      expect(res.body.pagination).toEqual({
        page: 1,
        limit: 5,
        total: 1,
        pages: 1,
      });
      expect(res.body.items[0]).toEqual({
        id: ids.lisa,
        email: users.lisa,
        firstName: 'lisa',
        lastName: 'Test',
        role: 'CUSTOMER',
        status: 'ACTIVE',
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      });
      const upper = await agents.admin
        .get(api('/admin/users'))
        .query({ search: `ADM.LISA.${tag}` })
        .expect(200);
      expect(upper.body.items).toHaveLength(1);
      const admins = await agents.admin
        .get(api('/admin/users'))
        .query({ search: `.${tag}@`, role: 'ADMIN' })
        .expect(200);
      expect(
        admins.body.items.map((u: { email: string }) => u.email).sort(),
      ).toEqual([users.admin, users.admin2, users.admin3].sort());
      const page2 = await agents.admin
        .get(api('/admin/users'))
        .query({ search: `.${tag}@`, limit: 2, page: 2 })
        .expect(200);
      expect(page2.body.pagination).toEqual({
        page: 2,
        limit: 2,
        total: 7,
        pages: 4,
      });
      expect(page2.body.items).toHaveLength(2);
      await agents.admin.get(api('/admin/users?limit=101')).expect(400);
      await agents.admin.get(api('/admin/users?status=GONE')).expect(400);
      await agents.admin.get(api('/admin/users?role=OWNER')).expect(400);
      await agents.admin.get(api('/admin/users?password=x')).expect(400);
    });

    it('detail: counts, no private content; view audited; 400 / 404', async () => {
      const res = await agents.admin
        .get(api(`/admin/users/${ids.lisa}`))
        .expect(200);
      expect(res.body).toMatchObject({
        id: ids.lisa,
        mfaEnabled: false,
        counts: {
          recipientCount: 1,
          trustedContactCount: 1,
          messageCount: 1,
          releasedMessageCount: 0,
          memoryVaultCount: 0,
        },
        deathVerification: null,
      });
      const text = JSON.stringify(res.body);
      expect(text).not.toContain(PRIVATE_TEXT);
      expect(text).not.toMatch(
        /passwordHash|argon2|privateNote|textContent|Fictional private note/,
      );
      const audit = await auditFor(ids.lisa, 'ADMIN_VIEWED_USER');
      expect(audit.body.items[0]).toMatchObject({
        actorType: 'ADMIN',
        actorUserId: ids.admin,
        subjectType: 'User',
      });
      await agents.admin.get(api('/admin/users/not-a-uuid')).expect(400);
      await agents.admin.get(api(`/admin/users/${ZERO}`)).expect(404);
    });

    it('suspension locks the Customer out at once; reactivation lets them back in', async () => {
      await agents.lisa.get(api('/auth/me')).expect(200);
      await agents.admin
        .post(api(`/admin/users/${ids.lisa}/suspend`))
        .send({})
        .expect(400);
      await agents.admin
        .post(api(`/admin/users/${ids.lisa}/suspend`))
        .send({ reason: 'x'.repeat(1001) })
        .expect(400);
      const res = await agents.admin
        .post(api(`/admin/users/${ids.lisa}/suspend`))
        .send({ reason: '  Administrative suspension.  ', status: 'PASSED' })
        .expect(400); // unknown field
      expect(res.body.message).toBeDefined();
      const ok = await agents.admin
        .post(api(`/admin/users/${ids.lisa}/suspend`))
        .send({ reason: '  Administrative suspension.  ' })
        .expect(200);
      expect(ok.body).toMatchObject({ id: ids.lisa, status: 'SUSPENDED' });
      // Existing session: denied on the next request. New login: denied.
      await agents.lisa.get(api('/auth/me')).expect(401);
      await agents.lisa.get(api('/messages')).expect(401);
      await http()
        .post(api('/auth/login'))
        .send({ email: users.lisa, password })
        .expect(403);
      await agents.admin
        .post(api(`/admin/users/${ids.lisa}/suspend`))
        .send({ reason: 'again' })
        .expect(409);

      const audit = await auditFor(ids.lisa, 'USER_SUSPENDED');
      expect(audit.body.items).toHaveLength(1);
      const entry = audit.body.items[0];
      expect(entry).toMatchObject({
        actorType: 'ADMIN',
        actorUserId: ids.admin,
        subjectType: 'User',
        subjectId: ids.lisa,
        metadata: {
          previousStatus: 'ACTIVE',
          newStatus: 'SUSPENDED',
          reason: 'Administrative suspension.',
        },
      });
      expect(entry.ipPrefix === null || /\/(24|48)$/.test(entry.ipPrefix)).toBe(
        true,
      );
      const detail = await agents.admin
        .get(api(`/admin/audit-logs/${entry.id}`))
        .expect(200);
      expect(detail.body).toEqual(entry);
      expect(JSON.stringify(detail.body)).not.toMatch(
        new RegExp(`${password}|passwordHash|${PRIVATE_TEXT}`),
      );

      await agents.admin
        .post(api(`/admin/users/${ids.lisa}/reactivate`))
        .send({ reason: 'Issue resolved.' })
        .expect(200);
      agents.lisa = await signIn(users.lisa);
      await agents.lisa.get(api('/auth/me')).expect(200);
      await agents.admin
        .post(api(`/admin/users/${ids.lisa}/reactivate`))
        .send({})
        .expect(409);
      expect(
        (await auditFor(ids.lisa, 'USER_REACTIVATED')).body.items,
      ).toHaveLength(1);
    });

    it('role safety: no self-suspension; ADMIN cannot touch admins; SUPER_ADMIN can suspend an ADMIN', async () => {
      await agents.admin
        .post(api(`/admin/users/${ids.admin}/suspend`))
        .send({ reason: 'x' })
        .expect(403);
      await agents.admin
        .post(api(`/admin/users/${ids.root}/suspend`))
        .send({ reason: 'x' })
        .expect(403);
      await agents.admin
        .post(api(`/admin/users/${ids.admin2}/suspend`))
        .send({ reason: 'x' })
        .expect(403);
      await agents.root
        .post(api(`/admin/users/${ids.root}/suspend`))
        .send({ reason: 'x' })
        .expect(403);
      await agents.root
        .post(api(`/admin/users/${ids.admin2}/suspend`))
        .send({ reason: 'Fictional access review.' })
        .expect(200);
      await agents.admin2.get(api('/admin/users')).expect(401);
      const audit = await auditFor(ids.admin2, 'USER_SUSPENDED');
      expect(audit.body.items[0]).toMatchObject({
        actorType: 'SUPER_ADMIN',
        actorUserId: ids.root,
      });
    });
  });

  describe('audit log', () => {
    it('filters by event, actor, subject type and date; bounded; 400/404', async () => {
      const from = new Date(run - 60_000).toISOString();
      const res = await agents.admin
        .get(api('/admin/audit-logs'))
        .query({
          eventType: 'USER_SUSPENDED',
          subjectType: 'User',
          actorUserId: ids.root,
          from,
          to: new Date(Date.now() + 60_000).toISOString(),
        })
        .expect(200);
      expect(res.body.items).toHaveLength(1);
      const none = await agents.admin
        .get(api('/admin/audit-logs'))
        .query({ actorUserId: ids.root, to: from })
        .expect(200);
      expect(none.body.items).toEqual([]);
      await agents.admin
        .get(api('/admin/audit-logs?eventType=NOPE'))
        .expect(400);
      await agents.admin.get(api('/admin/audit-logs?limit=500')).expect(400);
      await agents.admin.get(api(`/admin/audit-logs/${ZERO}`)).expect(404);
      await agents.admin.get(api('/admin/audit-logs/not-a-uuid')).expect(400);
    });

    it('rows are append-only: no API route, and PostgreSQL refuses UPDATE/DELETE', async () => {
      const { id } = await prisma.auditLog.findFirstOrThrow({
        where: { subjectId: ids.lisa },
      });
      await agents.admin
        .patch(api(`/admin/audit-logs/${id}`))
        .send({})
        .expect(404);
      await agents.admin.delete(api(`/admin/audit-logs/${id}`)).expect(404);
      await expect(
        prisma.auditLog.update({ where: { id }, data: { subjectId: 'x' } }),
      ).rejects.toThrow();
      await expect(prisma.auditLog.delete({ where: { id } })).rejects.toThrow();
    });
  });

  describe('queues', () => {
    it('summary lists only the queues the API owns; arbitrary names 404', async () => {
      const res = await agents.admin
        .get(api('/admin/system/queues'))
        .expect(200);
      expect(res.body.map((q: { name: string }) => q.name)).toEqual([
        'message-release',
        'death-verification',
      ]);
      expect(res.body[0]).toEqual({
        name: 'message-release',
        waiting: expect.any(Number),
        active: expect.any(Number),
        delayed: expect.any(Number),
        prioritized: expect.any(Number),
        failed: expect.any(Number),
        completed: expect.any(Number),
      });
      expect(JSON.stringify(res.body)).not.toMatch(/redis:|localhost|6379/);
      await agents.admin
        .get(api(`/admin/system/queues/${releaseQueueName}/failed`))
        .expect(404);
      await agents.admin
        .get(api('/admin/system/queues/bull/failed'))
        .expect(404);
    });

    it('a failed job is listed sanitized; retry re-queues it and the worker re-checks PostgreSQL', async () => {
      // One transient failure inside the real worker (e.g. a DB/Redis blip).
      const release = vi
        .spyOn(app.get(MessageReleaseService), 'release')
        .mockRejectedValueOnce(
          new Error(
            'connect ECONNREFUSED redis://default:s3cr3t@cache.internal:6379\n  at stack',
          ),
        );
      const jobId = releaseJobId(ids.lisaMessage);
      await releaseQueue.add(
        'release',
        { messageId: ids.lisaMessage },
        { jobId, attempts: 1 },
      );
      await until(
        async () => (await releaseQueue.getJob(jobId))?.failedReason != null,
      );

      const failed = await agents.admin
        .get(api('/admin/system/queues/message-release/failed'))
        .expect(200);
      const job = failed.body.items.find(
        (j: { jobId: string }) => j.jobId === jobId,
      );
      expect(job).toMatchObject({
        queue: 'message-release',
        attemptsMade: 1,
        maxAttempts: 1,
        failedReasonSanitized: 'connect ECONNREFUSED [url]',
        payload: { messageId: ids.lisaMessage },
      });
      expect(JSON.stringify(failed.body)).not.toMatch(/s3cr3t|stack|internal/);
      const dash = await agents.admin.get(api('/admin/dashboard')).expect(200);
      expect(dash.body.queues.failed).toBeGreaterThanOrEqual(1);

      await agents.admin
        .post(
          api('/admin/system/queues/message-release/jobs/not%20valid/retry'),
        )
        .expect(400);
      await agents.admin
        .post(
          api(
            '/admin/system/queues/message-release/jobs/message-release-x/retry',
          ),
        )
        .expect(404);
      await agents.lisa
        .post(api(`/admin/system/queues/message-release/jobs/${jobId}/retry`))
        .expect(401);
      await agents.admin
        .post(api(`/admin/system/queues/message-release/jobs/${jobId}/retry`))
        .expect(200);
      await until(
        async () =>
          (await releaseQueue.getJob(jobId))?.finishedOn != null &&
          (await (await releaseQueue.getJob(jobId))!.getState()) ===
            'completed',
      );

      // The worker ran release() again; the DRAFT message stayed unreleased.
      expect(release).toHaveBeenCalledTimes(2);
      const msg = await prisma.message.findUniqueOrThrow({
        where: { id: ids.lisaMessage },
        include: { release: true },
      });
      expect(msg.status).toBe('DRAFT');
      expect(msg.release).toBeNull();
      // Only failed jobs can be retried.
      await agents.admin
        .post(api(`/admin/system/queues/message-release/jobs/${jobId}/retry`))
        .expect(409);
      const audit = await auditFor(jobId, 'FAILED_JOB_RETRIED');
      expect(audit.body.items).toHaveLength(1);
      expect(audit.body.items[0]).toMatchObject({
        subjectType: 'Job',
        metadata: { queue: 'message-release', attemptsMade: 1 },
      });
      release.mockRestore();
    });
  });

  describe('Step 15 routes inside the admin backend (regression)', () => {
    const setupDeathCase = async (key: 'noah' | 'olga') => {
      const customer = agents[key];
      const tcId = (
        await customer
          .post(api('/trusted-contacts'))
          .send({ firstName: 'David', email: DAVID })
          .expect(201)
      ).body.id as string;
      const recipientId = (
        await customer
          .post(api('/recipients'))
          .send({ firstName: 'Sofia', email: SOFIA })
          .expect(201)
      ).body.id as string;
      const messageId = (
        await customer
          .post(api('/messages'))
          .send({
            title: 'On death',
            textContent: 'Fictional death-trigger text.',
            recipientIds: [recipientId],
          })
          .expect(201)
      ).body.id as string;
      await customer
        .post(api(`/messages/${messageId}/schedule`))
        .send({ triggerType: 'ON_DEATH' })
        .expect(201);
      agents.david = await otpSignIn('trusted-contact-auth', DAVID);
      const { caseId } = (
        await agents.david
          .post(api(`/trusted-contact/accounts/${tcId}/death-reports`))
          .send({ confirmReport: true, reportedDateOfDeath: '2026-09-01' })
          .expect(201)
      ).body;
      await until(
        async () =>
          (
            await prisma.deathVerificationCase.findUniqueOrThrow({
              where: { id: caseId },
            })
          ).status === 'READY_FOR_REVIEW',
      );
      return { caseId: caseId as string, messageId };
    };

    it('list (paginated) → detail (audited) → verify → PASSED → release → grant; PASSED cannot be reactivated', async () => {
      const { caseId, messageId } = await setupDeathCase('noah');
      const list = await agents.admin
        .get(api('/admin/death-verifications'))
        .query({ status: 'READY_FOR_REVIEW', limit: 100 })
        .expect(200);
      expect(list.body.pagination).toMatchObject({ page: 1, limit: 100 });
      expect(
        list.body.items.map((c: { caseId: string }) => c.caseId),
      ).toContain(caseId);
      await agents.admin
        .get(api('/admin/death-verifications?limit=0'))
        .expect(400);

      const detail = await agents.admin
        .get(api(`/admin/death-verifications/${caseId}`))
        .expect(200);
      expect(detail.body.status).toBe('READY_FOR_REVIEW');
      expect(JSON.stringify(detail.body)).not.toContain(
        'Fictional death-trigger text.',
      );
      expect(
        (await auditFor(caseId, 'ADMIN_VIEWED_DEATH_CASE')).body.items,
      ).toHaveLength(1);

      const dash = await agents.admin.get(api('/admin/dashboard')).expect(200);
      expect(dash.body.deathVerification.readyForReview).toBeGreaterThanOrEqual(
        1,
      );

      await agents.admin
        .post(api(`/admin/death-verifications/${caseId}/verify`))
        .send({
          verifiedDeathAt: new Date(Date.now() - 86_400_000).toISOString(),
          confirmVerification: true,
        })
        .expect(200);
      const verified = await auditFor(caseId, 'DEATH_VERIFICATION_VERIFIED');
      expect(verified.body.items[0]).toMatchObject({
        actorUserId: ids.admin,
        subjectType: 'DeathVerificationCase',
      });
      const noah = await prisma.user.findUniqueOrThrow({
        where: { email: users.noah },
      });
      expect(noah.status).toBe('PASSED');
      await until(
        async () =>
          (await prisma.message.findUniqueOrThrow({ where: { id: messageId } }))
            .status === 'RELEASED',
      );
      expect(
        await prisma.recipientMessageAccessGrant.count({
          where: { messageId },
        }),
      ).toBe(1);

      // Admins cannot override a verified death.
      await agents.admin
        .post(api(`/admin/users/${noah.id}/reactivate`))
        .send({ reason: 'x' })
        .expect(409);
      await agents.root
        .post(api(`/admin/users/${noah.id}/suspend`))
        .send({ reason: 'x' })
        .expect(409);
      const detailUser = await agents.admin
        .get(api(`/admin/users/${noah.id}`))
        .expect(200);
      expect(detailUser.body).toMatchObject({
        status: 'PASSED',
        counts: { releasedMessageCount: 1 },
        deathVerification: { caseId, status: 'VERIFIED' },
      });

      // A Recipient session (now eligible) still never reaches admin routes.
      const sofia = await otpSignIn('recipient-auth', SOFIA);
      await sofia.get(api('/recipient/messages')).expect(200);
      await sofia.get(api('/admin/users')).expect(401);
      await sofia.get(api('/admin-auth/me')).expect(401);
    });

    it('reject still works and is audited', async () => {
      const { caseId } = await setupDeathCase('olga');
      await agents.admin
        .post(api(`/admin/death-verifications/${caseId}/reject`))
        .send({ confirmRejection: true })
        .expect(200);
      expect(
        (await auditFor(caseId, 'DEATH_VERIFICATION_REJECTED')).body.items,
      ).toHaveLength(1);
      await agents.olga.get(api('/auth/me')).expect(200);
    });
  });

  it('dashboard: real aggregates only (no billing or delivery data)', async () => {
    const res = await agents.admin.get(api('/admin/dashboard')).expect(200);
    expect(Object.keys(res.body).sort()).toEqual([
      'deathVerification',
      'queues',
      'users',
    ]);
    expect(res.body.users.passed).toBeGreaterThanOrEqual(1);
    expect(res.body.users.total).toBeGreaterThanOrEqual(6);
  });
});
