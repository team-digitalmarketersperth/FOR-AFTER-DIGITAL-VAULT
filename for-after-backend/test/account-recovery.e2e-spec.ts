import { ConfigModule } from '@nestjs/config';
import type { LoggerService } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import { createHash, randomUUID } from 'node:crypto';
import session from 'express-session';
import request from 'supertest';
import { FakeEmailProvider } from './fake-email.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { configureApp } from '../src/config/app.setup.js';
import { EmailProvider } from '../src/email/email-provider.js';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { RedisModule } from '../src/redis/redis.module.js';
import { RedisService } from '../src/redis/redis.service.js';

// Phase 04 end to end: real PostgreSQL, Redis and HTTP stack; only the email
// provider is a fake inbox. Fictional data only; test users are deleted.
describe('Email verification, password reset, Redis throttling (e2e)', () => {
  const inbox = new FakeEmailProvider();
  const logs: string[] = [];
  const logger: LoggerService = {
    log: (...a: unknown[]) => void logs.push(a.map(String).join(' ')),
    error: (...a: unknown[]) => void logs.push(a.map(String).join(' ')),
    warn: (...a: unknown[]) => void logs.push(a.map(String).join(' ')),
  };
  const run = Date.now();
  const at = (name: string) => `${name}.${run}@example.test`;
  const PASSWORD = 'Fictional-Password-123';
  const NEW_PASSWORD = 'Another-Fictional-Pass-456';
  const api = (path: string) => `/api/v1${path}`;
  const sha256 = (t: string) => createHash('sha256').update(t).digest('hex');
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const until = async (check: () => boolean, ms = 5000) => {
    const end = Date.now() + ms;
    while (Date.now() < end && !check()) await sleep(50);
    if (!check()) throw new Error('condition not met in time');
  };
  const tokenIn = (email: string, kind: 'verify-email' | 'reset-password') =>
    inbox
      .to(email, kind)
      .at(-1)
      ?.text.match(/token=([A-Za-z0-9_-]{43})/)?.[1];
  const tokensSeen: string[] = [];
  const apps: NestExpressApplication[] = [];
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const http = (a = app) => request(a.getHttpServer());

  const boot = async () => {
    const ref = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        RedisModule,
        AuthModule,
      ],
    })
      .overrideProvider(EmailProvider)
      .useValue(inbox)
      .compile();
    const instance = ref.createNestApplication<NestExpressApplication>({
      logger,
    });
    configureApp(instance, new session.MemoryStore());
    await instance.init();
    apps.push(instance);
    return instance;
  };
  // This file's own throttle namespace (test/setup-e2e.ts): a clean window.
  const resetThrottle = async () => {
    const redis = app.get(RedisService).client;
    for (const key of await redis.keys(`${process.env.THROTTLE_KEY_PREFIX}*`))
      await redis.del(key);
  };
  const register = (email: string, a = app) =>
    http(a)
      .post(api('/auth/register'))
      .send({ email, password: PASSWORD, firstName: 'Fia', lastName: 'Test' })
      .expect(201);

  beforeAll(async () => {
    process.env.APP_BASE_URL = 'http://app.test';
    app = await boot();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await prisma?.user.deleteMany({
      where: { email: { endsWith: `.${run}@example.test` } },
    });
    for (const a of apps) await a.close();
  });

  describe('email verification', () => {
    const FIA = at('fia');
    let token: string;

    it('registration emails a single-use link; only its hash is stored', async () => {
      const { body: user } = await register(FIA);
      expect(user.emailVerifiedAt).toBeNull();
      await until(() => !!tokenIn(FIA, 'verify-email'));
      token = tokenIn(FIA, 'verify-email')!;
      tokensSeen.push(token);
      const [email] = inbox.to(FIA, 'verify-email');
      expect(email.subject).toBe('Verify your For After email');
      expect(email.text).toContain('Hi Fia,');
      expect(email.text).toContain(
        `http://app.test/verify-email?token=${token}`,
      );
      expect(email.text).not.toContain(PASSWORD);
      const rows = await prisma.authToken.findMany({
        where: { user: { email: FIA } },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        purpose: 'EMAIL_VERIFICATION',
        tokenHash: sha256(token),
        consumedAt: null,
      });
      expect(JSON.stringify(rows)).not.toContain(token);
      // 24 hours by default.
      const ttl = rows[0].expiresAt.getTime() - rows[0].createdAt.getTime();
      expect(Math.abs(ttl - 86_400_000)).toBeLessThan(5000);
    });

    it('policy unchanged: an unverified Customer can sign in; /auth/me shows the state', async () => {
      const agent = request.agent(app.getHttpServer());
      await agent
        .post(api('/auth/login'))
        .send({ email: FIA, password: PASSWORD })
        .expect(200);
      const { body } = await agent.get(api('/auth/me')).expect(200);
      expect(body.emailVerifiedAt).toBeNull();
      expect(JSON.stringify(body)).not.toMatch(/token/i);
    });

    it('malformed links are 400; a valid one verifies once, concurrently too', async () => {
      await http()
        .post(api('/auth/verify-email'))
        .send({ token: 'short' })
        .expect(400);
      await http()
        .post(api('/auth/verify-email'))
        .send({ token: 'A'.repeat(43) })
        .expect(400, {
          statusCode: 400,
          message: 'This link is invalid or has expired.',
          error: 'Bad Request',
        });
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          http().post(api('/auth/verify-email')).send({ token }),
        ),
      );
      expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([
        200, 400, 400, 400, 400,
      ]);
      const user = await prisma.user.findUniqueOrThrow({
        where: { email: FIA },
      });
      expect(user.emailVerifiedAt).not.toBeNull();
      expect(
        await prisma.auditLog.count({
          where: { eventType: 'EMAIL_VERIFIED', subjectId: user.id },
        }),
      ).toBe(1);
    });

    it('resend: same answer for anyone; nothing for verified or unknown accounts', async () => {
      const unknown = await http()
        .post(api('/auth/resend-verification'))
        .send({ email: at('nobody') })
        .expect(202);
      const verified = await http()
        .post(api('/auth/resend-verification'))
        .send({ email: FIA })
        .expect(202);
      expect(verified.body).toEqual(unknown.body);
      await sleep(300);
      expect(inbox.to(FIA, 'verify-email')).toHaveLength(1);
      expect(inbox.to(at('nobody'))).toHaveLength(0);
    });

    it('resend supersedes the old link, expired links fail, and each account gets at most 3 an hour', async () => {
      const GUS = at('gus');
      await register(GUS);
      await until(() => inbox.to(GUS, 'verify-email').length === 1);
      const first = tokenIn(GUS, 'verify-email')!;
      await http()
        .post(api('/auth/resend-verification'))
        .send({ email: `  ${GUS.toUpperCase()} ` })
        .expect(202);
      await until(() => inbox.to(GUS, 'verify-email').length === 2);
      const second = tokenIn(GUS, 'verify-email')!;
      tokensSeen.push(first, second);
      expect(second).not.toBe(first);
      await http()
        .post(api('/auth/verify-email'))
        .send({ token: first })
        .expect(400);
      // Expiry (test-only clock: move the row's expiry into the past).
      await prisma.authToken.update({
        where: { tokenHash: sha256(second) },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      await http()
        .post(api('/auth/verify-email'))
        .send({ token: second })
        .expect(400);
      // Third email this hour is sent, the fourth is not (same 202 answer).
      for (let i = 0; i < 2; i++)
        await http()
          .post(api('/auth/resend-verification'))
          .send({ email: GUS })
          .expect(202);
      await sleep(500);
      expect(inbox.to(GUS, 'verify-email')).toHaveLength(3);
      expect(
        await prisma.authToken.count({
          where: { user: { email: GUS }, consumedAt: null },
        }),
      ).toBe(1);
      tokensSeen.push(tokenIn(GUS, 'verify-email')!);
    });
  });

  describe('password reset', () => {
    const HAL = at('hal');
    let token: string;

    it('forgot-password answers the same for unknown and known emails; only the account gets a link', async () => {
      await register(HAL);
      const unknown = await http()
        .post(api('/auth/forgot-password'))
        .send({ email: at('ghost') })
        .expect(202);
      const known = await http()
        .post(api('/auth/forgot-password'))
        .send({ email: HAL })
        .expect(202);
      expect(known.body).toEqual(unknown.body);
      expect(known.body.message).toBe(
        'If an account exists for that email, password reset instructions have been sent.',
      );
      await until(() => !!tokenIn(HAL, 'reset-password'));
      token = tokenIn(HAL, 'reset-password')!;
      tokensSeen.push(token);
      expect(inbox.to(at('ghost'))).toHaveLength(0);
      const [email] = inbox.to(HAL, 'reset-password');
      expect(email.subject).toBe('Reset your For After password');
      expect(email.text).toContain(
        `http://app.test/reset-password?token=${token}`,
      );
      const row = await prisma.authToken.findFirstOrThrow({
        where: { user: { email: HAL }, purpose: 'PASSWORD_RESET' },
      });
      expect(row.tokenHash).toBe(sha256(token));
      // 60 minutes by default.
      expect(
        Math.abs(row.expiresAt.getTime() - row.createdAt.getTime() - 3_600_000),
      ).toBeLessThan(5000);
    });

    it('the registration password rule applies; a bad link is one generic 400', async () => {
      await http()
        .post(api('/auth/reset-password'))
        .send({ token, newPassword: 'short' })
        .expect(400);
      await http()
        .post(api('/auth/reset-password'))
        .send({ token: 'B'.repeat(43), newPassword: NEW_PASSWORD })
        .expect(400, {
          statusCode: 400,
          message: 'This link is invalid or has expired.',
          error: 'Bad Request',
        });
    });

    it('a valid link resets once (races too), ends every session, and creates none', async () => {
      await resetThrottle();
      const before = request.agent(app.getHttpServer());
      await before
        .post(api('/auth/login'))
        .send({ email: HAL, password: PASSWORD })
        .expect(200);
      await before.get(api('/auth/me')).expect(200);
      const changedBefore = (
        await prisma.user.findUniqueOrThrow({ where: { email: HAL } })
      ).passwordChangedAt;

      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          http()
            .post(api('/auth/reset-password'))
            .send({ token, newPassword: NEW_PASSWORD }),
        ),
      );
      expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([
        200, 400, 400, 400,
      ]);
      const ok = results.find((r) => r.status === 200)!;
      expect(ok.body).toEqual({ success: true });
      expect(ok.headers['set-cookie']).toBeUndefined();

      const user = await prisma.user.findUniqueOrThrow({
        where: { email: HAL },
      });
      expect(user.passwordHash).toMatch(/^\$argon2id\$/);
      expect(user.passwordChangedAt).not.toEqual(changedBefore);
      expect(
        await prisma.auditLog.count({
          where: { eventType: 'PASSWORD_RESET_COMPLETED', subjectId: user.id },
        }),
      ).toBe(1);
      // The old session is gone; the old password no longer works.
      await before.get(api('/auth/me')).expect(401);
      await http()
        .post(api('/auth/login'))
        .send({ email: HAL, password: PASSWORD })
        .expect(401);
      await http()
        .post(api('/auth/login'))
        .send({ email: HAL, password: NEW_PASSWORD })
        .expect(200);
      // Used links stay dead.
      await http()
        .post(api('/auth/reset-password'))
        .send({ token, newPassword: 'Yet-Another-Password-789' })
        .expect(400);
    });

    it('an expired reset link is rejected', async () => {
      await resetThrottle();
      await http().post(api('/auth/forgot-password')).send({ email: HAL });
      await until(() => inbox.to(HAL, 'reset-password').length === 2);
      const fresh = tokenIn(HAL, 'reset-password')!;
      tokensSeen.push(fresh);
      await prisma.authToken.update({
        where: { tokenHash: sha256(fresh) },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      await http()
        .post(api('/auth/reset-password'))
        .send({ token: fresh, newPassword: 'Yet-Another-Password-789' })
        .expect(400);
    });

    it('no token or password ever reaches the logs', () => {
      const all = logs.join('\n');
      expect(tokensSeen.length).toBeGreaterThan(4);
      for (const secret of [...tokensSeen, PASSWORD, NEW_PASSWORD])
        expect(all).not.toContain(secret);
      expect(all).toContain('password_reset_completed user');
    });
  });

  describe('Redis-backed throttling', () => {
    it('two API instances share one counter: 5 logins a minute in total', async () => {
      const second = await boot();
      const login = (a: NestExpressApplication) =>
        http(a)
          .post(api('/auth/login'))
          .send({ email: at('throttle'), password: PASSWORD });
      // A clean window: the earlier logins above count too.
      await resetThrottle();
      const redis = app.get(RedisService).client;
      const prefix = process.env.THROTTLE_KEY_PREFIX!;

      const statuses: number[] = [];
      for (const a of [app, second, app, second, app, second])
        statuses.push((await login(a)).status);
      expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
      // The counter lives in Redis, under the namespace, with the route's TTL.
      const keys = await redis.keys(`${prefix}*`);
      expect(keys.length).toBeGreaterThan(0);
      const ttl = await redis.pTTL(keys[0]);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(60_000);
      // Other routes keep their own counters.
      await http(second)
        .post(api('/auth/forgot-password'))
        .send({ email: at('throttle') })
        .expect(202);
    });

    it('the window resets after its TTL', async () => {
      const storage = app.get<ThrottlerStorage>(ThrottlerStorage);
      const key = `ttl-check-${randomUUID()}`;
      const hit = () => storage.increment(key, 1000, 2, 1000, 'default');
      expect((await hit()).isBlocked).toBe(false);
      expect((await hit()).isBlocked).toBe(false);
      expect(await hit()).toMatchObject({ totalHits: 3, isBlocked: true });
      await sleep(1200);
      expect(await hit()).toMatchObject({ totalHits: 1, isBlocked: false });
    });

    it('forgot-password is limited per IP (10 an hour)', async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 11; i++)
        statuses.push(
          (
            await http()
              .post(api('/auth/forgot-password'))
              .send({ email: at(`flood${i}`) })
          ).status,
        );
      // One request was already made from this IP in the previous test.
      expect(statuses.filter((s) => s === 202)).toHaveLength(9);
      expect(statuses.at(-1)).toBe(429);
    });
  });
});
