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
import { BillingModule } from '../src/billing/billing.module.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { ConfigService } from '@nestjs/config';
import { SNAPSHOT_MS, SystemHealthService } from '../src/admin/system-health.service.js';
import { configureApp } from '../src/config/app.setup.js';
import { AssistantMetrics } from '../src/assistant/assistant-metrics.js';
import { StorageQuota } from '../src/media/storage-quota.service.js';
import { WorkerHeartbeat } from '../src/health/worker-heartbeat.js';
import {
  DeathNoticeDelivery,
  type SafetyNoticeInput,
} from '../src/death-verification/death-verification-notice.js';
import { DeathVerificationModule } from '../src/death-verification/death-verification.module.js';
import { MessageReleaseQueue, releaseJobId } from '../src/message-release/message-release-queue.service.js';
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
import { QueueWorkersModule } from '../src/worker.module.js';

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
        // Phase 17B: the worker process's consumers, started explicitly.
        QueueWorkersModule,
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
        BillingModule,
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
          // Untrusted outside production (no trust proxy): never the recorded source.
          .set('X-Forwarded-For', '198.51.100.77')
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
        '/admin/releases',
        `/admin/releases/${ids.lisaMessage}`,
        '/admin/deliveries',
        '/admin/system/health',
        '/admin/security/events',
        `/admin/security/events/${ids.lisaMessage}`,
        '/admin/storage/assets',
        `/admin/storage/assets/${ids.lisaMessage}`,
        '/admin/system/ai',
        '/admin/access/admins',
        `/admin/access/admins/${ids.admin}`,
        `/admin/deliveries/release-emails/${ids.lisaMessage}`,
        `/admin/deliveries/safety-notices/${ids.lisaMessage}`,
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
      await agents.david.get(api('/admin/releases')).expect(401);
      await agents.david.get(api('/admin/deliveries')).expect(401);
      await agents.david.get(api('/admin/system/health')).expect(401);
      await agents.david.get(api('/admin/security/events')).expect(401);
      await agents.david.get(api('/admin/storage/assets')).expect(401);
      await agents.david.get(api('/admin/system/ai')).expect(401);
      await agents.david.get(api('/admin/access/admins')).expect(401);
      await agents.david.get(api('/admin-auth/me')).expect(401);
      await agents.david
        .post(api('/admin-auth/totp/setup'))
        .send({ challengeId: 'A'.repeat(43) })
        .expect(401);
    });

    it('unauthenticated: 401 everywhere', async () => {
      await http().get(api('/admin/users')).expect(401);
      await http().get(api('/admin/system/queues')).expect(401);
      await http().get(api('/admin/releases')).expect(401);
      await http().get(api(`/admin/releases/${ids.lisaMessage}`)).expect(401);
      await http().get(api('/admin/deliveries')).expect(401);
      await http().get(api('/admin/system/health')).expect(401);
      await http().get(api('/admin/security/events')).expect(401);
      await http().get(api('/admin/storage/assets')).expect(401);
      await http().get(api('/admin/system/ai')).expect(401);
      await http().get(api('/admin/access/admins')).expect(401);
      await http().get(api(`/admin/deliveries/safety-notices/${ids.lisaMessage}`)).expect(401);
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
        'email-delivery',
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
      await sofia.get(api('/admin/releases')).expect(401);
      await sofia.get(api('/admin/deliveries')).expect(401);
      await sofia.get(api('/admin/system/health')).expect(401);
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

  it('dashboard: counts and statuses only; reading it releases and sends nothing', async () => {
    const before = await Promise.all([
      prisma.messageRelease.count(),
      prisma.releaseNotification.count(),
      prisma.messageRecipientRelease.count({ where: { releasedAt: { not: null } } }),
    ]);
    const res = await agents.admin.get(api('/admin/dashboard')).expect(200);
    await agents.admin.get(api('/admin/dashboard')).expect(200);
    expect(Object.keys(res.body).sort()).toEqual([
      'customers',
      'deadLetters',
      'deathVerification',
      'generatedAt',
      'queues',
      'releaseEmails',
      'releases',
      'security',
      'services',
    ]);
    expect(Date.parse(res.body.generatedAt)).not.toBeNaN();
    // Recorded rows (this run's wrong codes), never null while PostgreSQL is up.
    expect(res.body.security.adminMfaFailuresLast7Days).toBeGreaterThan(0);
    expect(res.body.customers).toEqual({
      total: expect.any(Number),
      active: expect.any(Number),
      suspended: expect.any(Number),
      passed: expect.any(Number),
      deleted: expect.any(Number),
      newLast7Days: expect.any(Number),
    });
    expect(res.body.customers.passed).toBeGreaterThanOrEqual(1);
    // Customers only: never more than the CUSTOMER rows (admins excluded).
    expect(res.body.customers.total).toBeLessThan(await prisma.user.count());
    // Messages, counted exactly as /admin/releases?pastDue=true lists them.
    expect(res.body.releases).toEqual({ pastDue: expect.any(Number) });
    expect(res.body.releaseEmails).toEqual({ retrying: expect.any(Number), failed: expect.any(Number) });
    expect(res.body.queues).toEqual({
      waiting: expect.any(Number),
      active: expect.any(Number),
      delayed: expect.any(Number),
      failed: expect.any(Number),
    });
    expect(res.body.deadLetters).toEqual({ open: expect.any(Number) });
    // The System Health snapshot (scanner: a closed port in e2e; no worker reports on this suite's queue).
    expect(res.body.services).toEqual({
      database: 'ok',
      redis: 'ok',
      worker: 'missing',
      malwareScanner: 'failed',
    });
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(PRIVATE_TEXT);
    expect(body).not.toMatch(/@example\.test|"id"|textContent|privateNote|[Tt]oken|[Uu]rl|payload/);
    expect(
      await Promise.all([
        prisma.messageRelease.count(),
        prisma.releaseNotification.count(),
        prisma.messageRecipientRelease.count({ where: { releasedAt: { not: null } } }),
      ]),
    ).toEqual(before);
  });

  it('releases: read-only metadata with current assessments; never content; no-store', async () => {
    const lisaRecipient = (
      await agents.lisa.post(api('/recipients')).send({ firstName: 'Ruth' }).expect(201)
    ).body.id as string;
    const make = async (title: string) =>
      (
        await agents.lisa
          .post(api('/messages'))
          .send({ title, textContent: PRIVATE_TEXT, recipientIds: [lisaRecipient] })
          .expect(201)
      ).body.id as string;
    const future = await make('Fictional future title');
    const onDeath = await make('Fictional on-death title');
    await agents.lisa
      .post(api(`/messages/${future}/schedule`))
      .send({ triggerType: 'FIXED_DATE', scheduledFor: new Date(Date.now() + 30 * 86_400_000).toISOString() })
      .expect(201);
    // Created long ago or not, an after-death schedule is never "past due".
    await agents.lisa.post(api(`/messages/${onDeath}/schedule`)).send({ triggerType: 'ON_DEATH' }).expect(201);
    const released = await prisma.message.findFirstOrThrow({
      where: { owner: { email: users.noah }, status: 'RELEASED' },
      select: { id: true },
    });
    const before = await Promise.all([
      prisma.messageRelease.count(),
      prisma.releaseNotification.count(),
      prisma.recipientMessageAccessGrant.count(),
      prisma.message.groupBy({ by: ['status'], where: { ownerUserId: ids.lisa }, _count: { _all: true } }),
    ]);

    const list = await agents.admin.get(api(`/admin/releases?accountId=${ids.lisa}&sort=createdAt&dir=asc`)).expect(200);
    expect(list.headers['cache-control']).toBe('no-store');
    expect(list.body.items.map((i: { reference: string }) => i.reference)).toEqual([future, onDeath]);
    expect(list.body.items[0]).toMatchObject({
      accountId: ids.lisa,
      status: 'SCHEDULED',
      triggerType: 'FIXED_DATE',
      assessment: 'scheduled',
    });
    expect(list.body.items[1]).toMatchObject({ triggerType: 'ON_DEATH', assessment: 'awaiting_death_verification' });
    // The draft is not release work.
    expect(JSON.stringify(list.body)).not.toContain(ids.lisaMessage);
    const pastDue = await agents.admin.get(api(`/admin/releases?accountId=${ids.lisa}&pastDue=true`)).expect(200);
    expect(pastDue.body.items).toEqual([]);
    // The Overview counts exactly what the Releases filter lists.
    const [dash, allPastDue] = await Promise.all([
      agents.admin.get(api('/admin/dashboard')).expect(200),
      agents.admin.get(api('/admin/releases?pastDue=true&limit=1')).expect(200),
    ]);
    expect(allPastDue.body.pagination.total).toBe(dash.body.releases.pastDue);

    const one = await agents.admin.get(api(`/admin/releases?reference=${released.id}`)).expect(200);
    expect(one.body.items).toEqual([expect.objectContaining({ status: 'RELEASED', assessment: 'released' })]);
    const detail = await agents.admin.get(api(`/admin/releases/${released.id}`)).expect(200);
    expect(detail.headers['cache-control']).toBe('no-store');
    expect(detail.body).toMatchObject({
      reference: released.id,
      status: 'RELEASED',
      assessment: 'released',
      release: { triggerType: 'ON_DEATH', accessGrants: 1 },
      deathActivation: { triggerType: 'ON_DEATH' },
      deathCase: { status: 'VERIFIED' },
    });
    expect(detail.body.history.map((h: { event: string }) => h.event)).toEqual(
      expect.arrayContaining(['released', 'death_trigger_activated', 'schedule_saved']),
    );

    for (const body of [list.body, one.body, detail.body]) {
      const text = JSON.stringify(body);
      expect(text).not.toContain(PRIVATE_TEXT);
      expect(text).not.toMatch(/Fictional (future|on-death) title|On death|@example\.test|textContent|privateNote|errorMessage/);
    }

    await agents.admin.get(api('/admin/releases/not-a-uuid')).expect(400);
    await agents.admin.get(api(`/admin/releases/${ZERO}`)).expect(404);
    await agents.admin.get(api(`/admin/releases/${ids.lisaMessage}`)).expect(404);
    await agents.admin.get(api('/admin/releases?sort=title')).expect(400);
    await agents.admin.get(api('/admin/releases?status=DRAFT')).expect(400);
    await agents.admin
      .get(api('/admin/releases?scheduledFrom=2026-11-01T00:00:00Z&scheduledTo=2026-10-01T00:00:00Z'))
      .expect(400);

    // Reading released, queued, sent and changed nothing.
    expect(
      await Promise.all([
        prisma.messageRelease.count(),
        prisma.releaseNotification.count(),
        prisma.recipientMessageAccessGrant.count(),
        prisma.message.groupBy({ by: ['status'], where: { ownerUserId: ids.lisa }, _count: { _all: true } }),
      ]),
    ).toEqual(before);
  });

  it('deliveries: stored records only; accepted is not delivered; no addresses; reading changes nothing', async () => {
    const released = await prisma.message.findFirstOrThrow({
      where: { owner: { email: users.noah }, status: 'RELEASED' },
      select: { id: true },
    });
    const kase = await prisma.deathVerificationCase.findFirstOrThrow({
      where: { owner: { email: users.noah } },
      select: { id: true },
    });
    const before = await Promise.all([
      prisma.releaseNotification.groupBy({ by: ['status', 'attemptCount'], _count: { _all: true } }),
      prisma.deathVerificationCase.findUniqueOrThrow({
        where: { id: kase.id },
        select: { safetyNoticeAttemptCount: true, safetyNoticeSentAt: true, status: true },
      }),
      prisma.messageRelease.count(),
    ]);

    const list = await agents.admin
      .get(api(`/admin/deliveries?category=release_email&releaseReference=${released.id}`))
      .expect(200);
    expect(list.headers['cache-control']).toBe('no-store');
    expect(list.body.items).toHaveLength(1);
    const [row] = list.body.items;
    expect(row).toMatchObject({ channel: 'EMAIL', releaseReference: released.id });
    expect(['queued', 'retrying', 'provider_accepted', 'failed']).toContain(row.status);
    // Masked by the API: first character only, top-level domain kept.
    expect(row.destination).toBe('a***@e***.test'); // adm.sofia.<tag>@example.test
    expect(row.recipientReference).toMatch(/^[0-9a-f-]{36}$/);
    // Email is disabled in tests: never "accepted", let alone delivered.
    expect(row.status).not.toBe('provider_accepted');

    const detail = await agents.admin.get(api(`/admin/deliveries/release-emails/${row.reference}`)).expect(200);
    expect(detail.body).toMatchObject({ reference: row.reference, releaseReference: released.id, category: 'release_email' });
    expect(detail.body.history.map((h: { event: string }) => h.event)).toContain('intent_created');

    const notices = await agents.admin
      .get(api(`/admin/deliveries?category=safety_notice&reference=${kase.id}`))
      .expect(200);
    expect(notices.body.items).toEqual([
      expect.objectContaining({ reference: kase.id, status: 'provider_accepted', channel: 'EMAIL' }),
    ]);
    const notice = await agents.admin.get(api(`/admin/deliveries/safety-notices/${kase.id}`)).expect(200);
    expect(notice.body.caseEvents.length).toBeGreaterThanOrEqual(1);

    for (const body of [list.body, detail.body, notices.body, notice.body]) {
      const text = JSON.stringify(body);
      expect(text).not.toContain(SOFIA);
      expect(text).not.toMatch(/@example\.test|https?:|"(subject|html|text|token|tokenHash|payload|errorMessage|lastErrorCode)":/);
    }

    // The Overview counts exactly what these filters list.
    const [dash, retrying, failed] = await Promise.all([
      agents.admin.get(api('/admin/dashboard')).expect(200),
      agents.admin.get(api('/admin/deliveries?status=retrying&limit=1')).expect(200),
      agents.admin.get(api('/admin/deliveries?status=failed&limit=1')).expect(200),
    ]);
    expect(retrying.body.pagination.total).toBe(dash.body.releaseEmails.retrying);
    expect(failed.body.pagination.total).toBe(dash.body.releaseEmails.failed);

    await agents.admin.get(api('/admin/deliveries?category=sms')).expect(400);
    await agents.admin.get(api('/admin/deliveries?category=safety_notice&status=retrying')).expect(400);
    await agents.admin.get(api('/admin/deliveries?errorCategory=raw_provider_text')).expect(400);
    await agents.admin.get(api('/admin/deliveries/release-emails/not-a-uuid')).expect(400);
    await agents.admin.get(api(`/admin/deliveries/release-emails/${ZERO}`)).expect(404);
    await agents.admin.get(api(`/admin/deliveries/safety-notices/${ZERO}`)).expect(404);

    expect(
      await Promise.all([
        prisma.releaseNotification.groupBy({ by: ['status', 'attemptCount'], _count: { _all: true } }),
        prisma.deathVerificationCase.findUniqueOrThrow({
          where: { id: kase.id },
          select: { safetyNoticeAttemptCount: true, safetyNoticeSentAt: true, status: true },
        }),
        prisma.messageRelease.count(),
      ]),
    ).toEqual(before);
  });

  it('Cache-Control: no-store on every admin JSON response (errors too), not on Customer routes', async () => {
    for (const path of [
      '/admin/dashboard',
      '/admin/users',
      `/admin/users/${ids.lisa}`,
      '/admin/audit-logs',
      '/admin/system/queues',
      '/admin/system/dead-letters',
      '/admin/death-verifications',
      '/admin/releases',
      '/admin/deliveries',
      '/admin/system/health',
      '/admin/security/events',
      '/admin/storage/assets',
      '/admin/system/ai',
      '/admin/access/admins',
      '/admin-auth/me',
    ]) {
      const res = await agents.admin.get(api(path)).expect(200);
      expect([path, res.headers['cache-control']]).toEqual([path, 'no-store']);
    }
    // Error responses on admin routes are private too.
    expect((await http().get(api('/admin/users')).expect(401)).headers['cache-control']).toBe('no-store');
    expect((await agents.admin.get(api(`/admin/releases/${ZERO}`)).expect(404)).headers['cache-control']).toBe('no-store');
    // Not global: a Customer route keeps its own (no) caching policy.
    expect((await agents.lisa.get(api('/auth/me')).expect(200)).headers['cache-control']).toBeUndefined();
  });

  it('security activity: recorded security rows only, explicit fields, verified accounts, bounded; reading writes nothing', async () => {
    const before = await prisma.auditLog.count();
    const res = await agents.admin
      .get(api('/admin/security/events'))
      .query({ category: 'mfa_failure', limit: 100 })
      .expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    // This run's wrong codes, attributed to the password-verified admin.
    const mine = res.body.items.filter((e: { accountId: string }) => e.accountId === ids.admin);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine[0]).toEqual({
      reference: expect.any(String),
      recordedAt: expect.any(String),
      eventType: 'ADMIN_MFA_FAILED',
      category: 'mfa_failure',
      outcome: 'failed',
      actorType: 'ADMIN',
      actorUserId: ids.admin,
      accountId: ids.admin,
      network: expect.stringMatching(/\/(24|48)$/),
      // Attribution is unset in this suite: no row is trusted.
      sourceTrusted: false,
      reason: { method: expect.any(String), code: expect.any(String), challengeInvalidated: expect.any(Boolean) },
    });
    expect(res.body.counts.mfa_failure).toBeGreaterThanOrEqual(mine.length);
    const text = JSON.stringify(res.body);
    for (const s of [secret, password, ...recoveryCodes, 'userAgent', 'metadata', '198.51.100.']) expect(text).not.toContain(s);
    // Suspension reasons (free text) never appear; the row is still listed.
    const status = await agents.admin.get(api('/admin/security/events')).query({ category: 'account_status', accountId: ids.lisa }).expect(200);
    expect(status.body.items.length).toBeGreaterThan(0);
    expect(status.body.items.every((e: { reason: unknown }) => e.reason === null)).toBe(true);
    // Detail of a security row; a non-security audit row (a page view) is 404.
    await agents.admin.get(api(`/admin/security/events/${mine[0].reference}`)).expect(200);
    const view = await prisma.auditLog.findFirstOrThrow({ where: { eventType: 'ADMIN_VIEWED_USER' } });
    await agents.admin.get(api(`/admin/security/events/${view.id}`)).expect(404);
    // Exact reference; stable newest-first order with an id tie-breaker.
    const one = await agents.admin.get(api('/admin/security/events')).query({ reference: mine[0].reference }).expect(200);
    expect(one.body.items.map((e: { reference: string }) => e.reference)).toEqual([mine[0].reference]);
    const all = (await agents.admin.get(api('/admin/security/events')).query({ limit: 100 }).expect(200)).body.items as { recordedAt: string; reference: string }[];
    for (let i = 1; i < all.length; i++) {
      const [a, b] = [all[i - 1]!, all[i]!];
      expect(a.recordedAt > b.recordedAt || (a.recordedAt === b.recordedAt && a.reference > b.reference)).toBe(true);
    }
    // Validation and bounds.
    await agents.admin.get(api('/admin/security/events')).query({ category: 'brute_force' }).expect(400);
    await agents.admin.get(api('/admin/security/events')).query({ email: users.lisa }).expect(400);
    await agents.admin.get(api('/admin/security/events')).query({ limit: 101 }).expect(400);
    await agents.admin
      .get(api('/admin/security/events'))
      .query({ from: '2024-01-01T00:00:00Z', to: '2026-01-01T00:00:00Z' })
      .expect(400);
    await agents.admin.get(api('/admin/security/events/not-a-uuid')).expect(400);
    // Reading is not an audited action and changes nothing.
    expect(await prisma.auditLog.count()).toBe(before);
  });

  it('storage & scans: stored-file metadata only, quota-consistent bytes, honest states; reading changes nothing', async () => {
    // Fictional rows on Lisa's draft (no files exist anywhere; this app has no media provider at all).
    const base = { ownerUserId: ids.lisa, messageId: ids.lisaMessage, kind: 'PHOTO' as const, mimeType: 'image/png' };
    const mk = (over: object) =>
      prisma.mediaAsset.create({
        data: { ...base, storageKey: `test/${run}/${randomUUID()}`, originalFileName: 'Grandma secret.png', sizeBytes: 1, ...over },
        select: { id: true },
      });
    const ready = await mk({ status: 'READY', sizeBytes: 1000, uploadedAt: new Date(), providerFileId: 'pf-secret' });
    const pending = await mk({ status: 'PENDING_UPLOAD', sizeBytes: 300 });
    const failed = await mk({ status: 'FAILED', sizeBytes: 50 });
    const removing = await mk({ status: 'READY', sizeBytes: 70, deletedAt: new Date() });
    const removed = await mk({ status: 'READY', sizeBytes: 90, deletedAt: new Date(), storageDeletedAt: new Date() });
    try {
      const snapshot = () => prisma.mediaAsset.findMany({ where: { ownerUserId: ids.lisa }, orderBy: { id: 'asc' } });
      const before = await snapshot();
      const res = await agents.admin.get(api('/admin/storage/assets')).query({ accountId: ids.lisa, limit: 100 }).expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const byRef = Object.fromEntries(res.body.items.map((i: { reference: string }) => [i.reference, i]));
      expect(byRef[ready.id]).toMatchObject({ source: 'MESSAGE', uploadState: 'ready', sizeBytes: 1000, sizeVerified: true, deletion: 'active' });
      // Declared (reserved) size, not verified; no scan outcome implied.
      expect(byRef[pending.id]).toMatchObject({ uploadState: 'pending', sizeVerified: false, verifiedAt: null });
      expect(byRef[pending.id]).not.toHaveProperty('scan');
      // FAILED is failed verification (reason not stored), queued for removal; not "malware".
      expect(byRef[failed.id]).toMatchObject({ uploadState: 'failed', deletion: 'pending' });
      // Soft delete is "removal pending"; only storageDeletedAt is "removal recorded".
      expect(byRef[removing.id]).toMatchObject({ deletion: 'pending', storageDeletedAt: null });
      expect(byRef[removed.id]).toMatchObject({ deletion: 'confirmed' });
      const text = JSON.stringify(res.body);
      for (const s of ['Grandma', 'pf-secret', `test/${run}`, 'storageKey', 'image/png', 'http']) expect(text).not.toContain(s);
      // Same definitions as the customer quota: live READY = used, live PENDING_UPLOAD = reserved.
      const usage = await new StorageQuota(prisma, app.get(ConfigService)).usage(ids.lisa);
      const items = res.body.items as { uploadState: string; deletedAt: string | null; sizeBytes: number }[];
      const live = (state: string) => items.filter((i) => i.uploadState === state && !i.deletedAt).reduce((n, i) => n + i.sizeBytes, 0);
      expect(live('ready')).toBe(usage.usedBytes);
      expect(live('pending')).toBe(usage.reservedBytes);
      // Platform summary includes these rows, each counted once.
      expect(res.body.summary.MESSAGE.verifiedBytes).toBeGreaterThanOrEqual(1000);
      expect(res.body.summary.MESSAGE.deletionConfirmed).toBeGreaterThanOrEqual(1);
      // Filters, detail, validation.
      const failedOnly = await agents.admin.get(api('/admin/storage/assets')).query({ accountId: ids.lisa, uploadState: 'failed' }).expect(200);
      expect(failedOnly.body.items.map((i: { reference: string }) => i.reference)).toEqual([failed.id]);
      await agents.admin.get(api(`/admin/storage/assets/${ready.id}`)).expect(200);
      await agents.admin.get(api(`/admin/storage/assets/${ZERO}`)).expect(404);
      await agents.admin.get(api('/admin/storage/assets')).query({ fileName: 'Grandma' }).expect(400);
      await agents.admin.get(api('/admin/storage/assets')).query({ uploadState: 'infected' }).expect(400);
      await agents.admin.get(api('/admin/storage/assets')).query({ from: '2024-01-01T00:00:00Z', to: '2026-01-01T00:00:00Z' }).expect(400);
      // Stable newest-first order with an id tie-breaker.
      const all = (await agents.admin.get(api('/admin/storage/assets')).query({ limit: 100 }).expect(200)).body.items as { createdAt: string; reference: string }[];
      for (let i = 1; i < all.length; i++) {
        const [a, b] = [all[i - 1]!, all[i]!];
        expect(a.createdAt > b.createdAt || (a.createdAt === b.createdAt && a.reference > b.reference)).toBe(true);
      }
      // Reading changed no row (status, dates, deletion markers).
      expect(await snapshot()).toEqual(before);
    } finally {
      await prisma.mediaAsset.deleteMany({ where: { id: { in: [ready, pending, failed, removing, removed].map((r) => r.id) } } });
    }
  });

  it('AI operations: shared Redis aggregates from two replicas; settings without the key; no provider call; no-store', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const get = async (query: object = {}) => {
      const res = await agents.admin.get(api('/admin/system/ai')).query(query).expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      return res.body;
    };
    const before = await get({ area: 'memory-vault' });
    expect(before.monitoring).toBe('available');
    // Two recorders on the same Redis, as two API instances would be.
    const [a, b] = [new AssistantMetrics(app.get(RedisService)), new AssistantMetrics(app.get(RedisService))];
    await a.request('memory-vault', 'caption', 'reply', 1000);
    await b.request('memory-vault', 'caption', 'provider_failure', 3000);
    await a.attempt('memory-vault', 'caption', 'ok', 900, false, { input: 10, output: 5, total: 15 });
    await b.attempt('memory-vault', 'caption', 'provider_5xx', 2000, false);
    await b.attempt('memory-vault', 'caption', 'network', 900, true);
    const after = await get({ area: 'memory-vault' });
    expect(after.requests.total - before.requests.total).toBe(2);
    expect(after.requests.byOutcome.provider_failure - before.requests.byOutcome.provider_failure).toBe(1);
    expect(after.attempts.total - before.attempts.total).toBe(3);
    expect(after.attempts.retries - before.attempts.retries).toBe(1);
    expect(after.tokens.reportedAttempts - before.tokens.reportedAttempts).toBe(1);
    expect(after.tokens.unknownAttempts - before.tokens.unknownAttempts).toBe(2);
    expect(Date.parse(after.period.from)).toBeLessThan(Date.parse(after.period.to));
    expect(after.lastReplyAt).not.toBeNull();
    // Configuration presence and limits only: never the key or anything derived from it.
    const key = app.get(ConfigService).get<string>('GROQ_API_KEY') ?? '';
    expect(after.configuration).toEqual({
      configured: key.trim() !== '',
      provider: 'Groq',
      model: expect.any(String),
      perUserHour: expect.any(Number),
      globalAttemptsPerMinute: expect.any(Number),
      maxConcurrent: expect.any(Number),
      budgetMs: 25_000,
      maxAttempts: 2,
      maxCompletionTokens: 700,
    });
    if (key.trim()) expect(JSON.stringify(after)).not.toContain(key.trim().slice(0, 6));
    await agents.admin.get(api('/admin/system/ai')).query({ window: '30d' }).expect(400);
    await agents.admin.get(api('/admin/system/ai')).query({ area: 'admin' }).expect(400);
    await agents.admin.get(api('/admin/system/ai')).query({ userId: ids.lisa }).expect(400);
    expect((await get({ window: '7d' })).window).toBe('7d');
    // Opening or refreshing the page never calls the AI provider.
    expect(fetchSpy.mock.calls.filter(([url]) => (url instanceof Request ? url.url : String(url as string | URL)).includes('groq'))).toHaveLength(0);
    fetchSpy.mockRestore();
  });

  it('admin access: read-only list/detail of admin accounts; permissions from the enforcing rules; no secrets; no mutation route', async () => {
    // A fictional admin that never finished sign-in: not enrolled, no sign-in recorded.
    const fresh = await prisma.user.create({
      data: { email: `adm.fresh.${run}@example.test`, passwordHash: 'not-a-real-hash', firstName: 'Fresh', lastName: 'Admin', role: 'ADMIN', status: 'ACTIVE' },
      select: { id: true },
    });
    try {
      const list = await agents.admin.get(api('/admin/access/admins')).query({ limit: 100 }).expect(200);
      expect(list.headers['cache-control']).toBe('no-store');
      const byId = Object.fromEntries(list.body.items.map((a: { id: string }) => [a.id, a]));
      // Admin roles only: Customers never appear.
      expect(list.body.items.every((a: { role: string }) => ['ADMIN', 'SUPER_ADMIN'].includes(a.role))).toBe(true);
      expect(byId[ids.lisa]).toBeUndefined();
      expect(byId[ids.admin]).toMatchObject({ role: 'ADMIN', status: 'ACTIVE', mfaEnrolled: true, lastSignInAt: expect.any(String) });
      expect(byId[fresh.id]).toMatchObject({ mfaEnrolled: false, lastSignInAt: null });
      expect(Object.keys(byId[ids.admin]).sort()).toEqual(['createdAt', 'email', 'firstName', 'id', 'invitationPending', 'lastName', 'lastSignInAt', 'mfaEnrolled', 'role', 'status']);
      const text = JSON.stringify(list.body);
      for (const s of [secret, password, ...recoveryCodes, 'passwordHash', 'totpSecret', 'codeHash', 'not-a-real-hash']) expect(text).not.toContain(s);

      // Filters, bounds, validation.
      const notEnrolled = await agents.admin.get(api('/admin/access/admins')).query({ mfa: 'not_enrolled', limit: 100 }).expect(200);
      expect(notEnrolled.body.items.map((a: { id: string }) => a.id)).toContain(fresh.id);
      expect(notEnrolled.body.items.map((a: { id: string }) => a.id)).not.toContain(ids.admin);
      const supers = await agents.admin.get(api('/admin/access/admins')).query({ role: 'SUPER_ADMIN' }).expect(200);
      expect(supers.body.items.map((a: { id: string }) => a.id)).toEqual([ids.root]);
      await agents.admin.get(api('/admin/access/admins')).query({ role: 'CUSTOMER' }).expect(400);
      await agents.admin.get(api('/admin/access/admins')).query({ role: 'OWNER' }).expect(400);
      await agents.admin.get(api('/admin/access/admins')).query({ sort: 'passwordHash' }).expect(400);
      await agents.admin.get(api('/admin/access/admins')).query({ limit: 101 }).expect(400);

      // Detail: effective permissions come from the enforcing rules; history is explicit fields only.
      const admin2 = (await agents.admin.get(api(`/admin/access/admins/${ids.admin2}`)).expect(200)).body;
      expect(admin2.permissions).toEqual({ adminPortal: true, manageCustomerAccounts: true, manageAdminAccounts: false, manageSuperAdminAccounts: false, changeRoles: false });
      expect(admin2.status).toBe('SUSPENDED'); // suspended by the SUPER_ADMIN earlier in this run
      expect(admin2.history[0]).toEqual({
        reference: expect.any(String),
        eventType: 'USER_SUSPENDED',
        actorType: 'SUPER_ADMIN',
        actorUserId: ids.root,
        previousStatus: 'ACTIVE',
        newStatus: 'SUSPENDED',
        recordedAt: expect.any(String),
      });
      expect(JSON.stringify(admin2)).not.toContain('Fictional access review'); // the free-text reason stays on the audit log
      // Whether the viewer may manage this account on the Users page: the Users page's own rule.
      expect(admin2.viewerCanManage).toBe(false); // ADMIN viewing an ADMIN
      expect((await agents.root.get(api(`/admin/access/admins/${ids.admin2}`)).expect(200)).body.viewerCanManage).toBe(true);
      expect((await agents.root.get(api(`/admin/access/admins/${ids.root}`)).expect(200)).body).toMatchObject({
        viewerCanManage: false, // never yourself
        permissions: { manageAdminAccounts: true, manageSuperAdminAccounts: false, changeRoles: false },
      });
      const freshDetail = (await agents.admin.get(api(`/admin/access/admins/${fresh.id}`)).expect(200)).body;
      expect(freshDetail).toMatchObject({ mfaEnrolled: false, mfaEnrolledAt: null, lastSignInAt: null, history: [] });
      // Customers are not administrators here; malformed ids are 400.
      await agents.admin.get(api(`/admin/access/admins/${ids.lisa}`)).expect(404);
      await agents.admin.get(api('/admin/access/admins/not-a-uuid')).expect(400);

      // Read-only: no write route exists on this resource.
      for (const method of ['post', 'patch', 'put', 'delete'] as const) {
        await agents.root[method](api(`/admin/access/admins/${ids.admin}`)).send({ role: 'SUPER_ADMIN' }).expect(404);
      }
      expect((await prisma.user.findUniqueOrThrow({ where: { id: ids.admin } })).role).toBe('ADMIN');
    } finally {
      await prisma.user.delete({ where: { id: fresh.id } });
    }
  });

  it('system health: real checks from this API instance; statuses and times only; no-store', async () => {
    const res = await agents.admin.get(api('/admin/system/health')).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(Object.keys(res.body).sort()).toEqual(['api', 'checkedAt', 'database', 'malwareScanner', 'redis', 'worker']);
    expect(res.body.api).toEqual({ status: 'ok', checkedAt: expect.any(String) });
    expect(res.body.database).toEqual({ status: 'ok', checkedAt: expect.any(String), durationMs: expect.any(Number) });
    expect(res.body.redis).toMatchObject({ status: 'ok' });
    // The e2e config points the scanner at a closed local port: an honest failure, never a fake success.
    expect(res.body.malwareScanner).toMatchObject({ status: 'failed', durationMs: expect.any(Number) });
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/127\.0\.0\.1|localhost|redis:\/\/|postgres|for_after:|worker-heartbeats|CLAMAV|password|stack/i);
    // The Overview reads the same snapshot.
    const dash = await agents.admin.get(api('/admin/dashboard')).expect(200);
    expect(dash.body.services).toEqual({
      database: res.body.database.status,
      redis: res.body.redis.status,
      worker: res.body.worker.status,
      malwareScanner: res.body.malwareScanner.status,
    });
  });

  it('worker heartbeat round trip through real Redis: recent while beating, missing after shutdown', async () => {
    const health = app.get(SystemHealthService);
    const heartbeat = new WorkerHeartbeat(app.get(MessageReleaseQueue), app.get(ConfigService));
    // Each read past the previous snapshot window, so it is a new probe.
    let shift = 0;
    const fresh = () => health.check(Date.now() + (shift += 2 * SNAPSHOT_MS));
    // This suite's own queue name: no real worker ever reports here.
    expect((await fresh()).worker).toMatchObject({ status: 'missing', reportingWorkers: 0, lastSeenAt: null });
    await heartbeat.beat();
    const second = new WorkerHeartbeat(app.get(MessageReleaseQueue), app.get(ConfigService));
    await second.beat();
    const beating = (await fresh()).worker;
    expect(beating).toMatchObject({ status: 'ok', reportingWorkers: 2, staleAfterSeconds: 45 });
    expect(Date.parse(beating.lastSeenAt!)).toBeGreaterThan(Date.now() - 10_000);
    await heartbeat.onModuleDestroy();
    await second.onModuleDestroy();
    expect((await fresh()).worker).toMatchObject({ status: 'missing', reportingWorkers: 0 });
  });
});
