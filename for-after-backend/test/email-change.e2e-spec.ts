import type { LoggerService } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { createHash } from 'node:crypto';
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

// Phase 08 end to end: real PostgreSQL, Redis and HTTP stack; only the email
// provider is a fake inbox. Fictional data only; test users are deleted.
describe('Change email with verification (e2e)', () => {
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
  const api = (path: string) => `/api/v1${path}`;
  const sha256 = (t: string) => createHash('sha256').update(t).digest('hex');
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const until = async (check: () => boolean, ms = 5000) => {
    const end = Date.now() + ms;
    while (Date.now() < end && !check()) await sleep(50);
    if (!check()) throw new Error('condition not met in time');
  };
  const tokens: string[] = [];
  const linkTo = (email: string) => {
    const token = inbox
      .to(email, 'change-email')
      .at(-1)
      ?.text.match(/verify-email-change\?token=([A-Za-z0-9_-]{43})/)?.[1];
    if (token) tokens.push(token);
    return token;
  };
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const http = () => request(app.getHttpServer());
  type Agent = ReturnType<typeof request.agent>;

  const resetThrottle = async () => {
    const redis = app.get(RedisService).client;
    for (const key of await redis.keys(`${process.env.THROTTLE_KEY_PREFIX}*`))
      await redis.del(key);
  };
  const signIn = async (email: string) => {
    const agent = request.agent(app.getHttpServer());
    await agent
      .post(api('/auth/login'))
      .send({ email, password: PASSWORD })
      .expect(200);
    return agent;
  };
  const customer = async (name: string) => {
    const email = at(name);
    await http()
      .post(api('/auth/register'))
      .send({ email, password: PASSWORD, firstName: name, lastName: 'Test' })
      .expect(201);
    return { email, agent: await signIn(email) };
  };
  const requestChange = (agent: Agent, newEmail: string, password = PASSWORD) =>
    agent
      .post(api('/auth/change-email'))
      .send({ newEmail, currentPassword: password });
  const confirm = (token: string) =>
    http().post(api('/auth/change-email/confirm')).send({ token });
  const emailOf = async (id: string) =>
    (await prisma.user.findUniqueOrThrow({ where: { id } })).email;

  beforeAll(async () => {
    process.env.APP_BASE_URL = 'http://app.test';
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
    app = ref.createNestApplication<NestExpressApplication>({ logger });
    configureApp(app, new session.MemoryStore());
    await app.init();
    prisma = app.get(PrismaService);
  });
  beforeEach(resetThrottle);
  afterAll(async () => {
    await prisma?.user.deleteMany({
      where: { email: { endsWith: `.${run}@example.test` } },
    });
    await app?.close();
  });

  describe('request', () => {
    let lisa: { email: string; agent: Agent; id: string };

    beforeAll(async () => {
      const c = await customer('lisa');
      lisa = {
        ...c,
        id: (await prisma.user.findUniqueOrThrow({ where: { email: c.email } }))
          .id,
      };
      await customer('bob');
    });

    it('needs a Customer session', () =>
      http()
        .post(api('/auth/change-email'))
        .send({ newEmail: at('x'), currentPassword: PASSWORD })
        .expect(401));

    it('refuses a wrong password, the same address, a used address and a bad one: nothing issued or sent', async () => {
      await requestChange(lisa.agent, at('new'), 'Wrong-Password-000')
        .expect(400)
        .expect((r) =>
          expect(r.body.message).toBe('Your current password is incorrect.'),
        );
      await requestChange(lisa.agent, lisa.email.toUpperCase())
        .expect(400)
        .expect((r) =>
          expect(r.body.message).toBe('This is already your email address.'),
        );
      await requestChange(lisa.agent, at('bob')).expect(409);
      await requestChange(lisa.agent, 'not-an-email').expect(400);
      expect(
        await prisma.authToken.count({
          where: { userId: lisa.id, purpose: 'EMAIL_CHANGE' },
        }),
      ).toBe(0);
      expect(inbox.sent.filter((m) => m.kind === 'change-email')).toHaveLength(
        0,
      );
    });

    it('a valid request emails the NEW address only; User.email is unchanged; only a hash is stored', async () => {
      const NEW = at('lisa-new');
      const res = await requestChange(
        lisa.agent,
        `  ${NEW.toUpperCase()} `,
      ).expect(202);
      expect(res.body).toEqual({
        pendingEmail: NEW.replace(/^(.)[^@]*@/, '$1***@'),
      });
      await until(() => !!linkTo(NEW));
      const token = tokens.at(-1)!;
      expect(inbox.to(lisa.email, 'change-email')).toHaveLength(0);
      const [mail] = inbox.to(NEW, 'change-email');
      expect(mail.subject).toBe('Verify your new For After email');
      expect(mail.text).toContain(
        `http://app.test/settings/verify-email-change?token=${token}`,
      );
      expect(mail.text).not.toContain(PASSWORD);
      expect(await emailOf(lisa.id)).toBe(lisa.email);
      const rows = await prisma.authToken.findMany({
        where: { userId: lisa.id, purpose: 'EMAIL_CHANGE' },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        newEmail: NEW,
        tokenHash: sha256(token),
        consumedAt: null,
      });
      expect(JSON.stringify(rows)).not.toContain(token);
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { eventType: 'EMAIL_CHANGE_REQUESTED', subjectId: lisa.id },
      });
      expect(JSON.stringify(audit)).not.toMatch(/@example\.test/);
    });

    it('a new request or a resend supersedes the previous link', async () => {
      const first = tokens.at(-1)!;
      const NEWER = at('lisa-newer');
      await requestChange(lisa.agent, NEWER).expect(202);
      await until(() => inbox.to(NEWER, 'change-email').length === 1);
      const second = linkTo(NEWER)!;
      await lisa.agent.post(api('/auth/change-email/resend')).expect(202);
      await until(() => inbox.to(NEWER, 'change-email').length === 2);
      const third = linkTo(NEWER)!;
      expect(new Set([first, second, third]).size).toBe(3);
      await confirm(first).expect(400);
      await confirm(second).expect(400);
      expect(
        await prisma.authToken.count({
          where: { userId: lisa.id, purpose: 'EMAIL_CHANGE', consumedAt: null },
        }),
      ).toBe(1);
    });

    it("another Customer cannot resend or cancel Lisa's request", async () => {
      const bob = await signIn(at('bob'));
      await bob
        .post(api('/auth/change-email/resend'))
        .expect(400)
        .expect((r) =>
          expect(r.body.message).toBe(
            'There is no email change waiting to be verified.',
          ),
        );
      await bob.post(api('/auth/change-email/cancel')).expect(200);
      expect(
        await prisma.authToken.count({
          where: { userId: lisa.id, purpose: 'EMAIL_CHANGE', consumedAt: null },
        }),
      ).toBe(1);
    });

    it('cancel kills the pending link', async () => {
      const live = tokens.at(-1)!;
      await lisa.agent.post(api('/auth/change-email/cancel')).expect(200);
      await confirm(live).expect(400);
      expect(await emailOf(lisa.id)).toBe(lisa.email);
    });
  });

  describe('confirm', () => {
    it('one of several concurrent confirms wins; every session ends; old address refused, new accepted; old inbox told once', async () => {
      const mia = await customer('mia');
      const second = await signIn(mia.email);
      const id = (
        await prisma.user.findUniqueOrThrow({ where: { email: mia.email } })
      ).id;
      // A reset link waiting in the old inbox must die with the change.
      await http()
        .post(api('/auth/forgot-password'))
        .send({ email: mia.email });
      await until(() => inbox.to(mia.email, 'reset-password').length === 1);
      const resetToken = inbox
        .to(mia.email, 'reset-password')[0]
        .text.match(/token=([A-Za-z0-9_-]{43})/)![1];
      tokens.push(resetToken);

      const NEW = at('mia-new');
      await requestChange(mia.agent, NEW).expect(202);
      await until(() => !!linkTo(NEW));
      const token = tokens.at(-1)!;
      const results = await Promise.all(
        Array.from({ length: 4 }, () => confirm(token)),
      );
      expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([
        200, 400, 400, 400,
      ]);

      const user = await prisma.user.findUniqueOrThrow({ where: { id } });
      expect(user.email).toBe(NEW);
      expect(user.emailVerifiedAt).not.toBeNull();
      expect(user.emailChangedAt).not.toBeNull();
      await mia.agent.get(api('/auth/me')).expect(401);
      await second.get(api('/auth/me')).expect(401);
      await http()
        .post(api('/auth/login'))
        .send({ email: mia.email, password: PASSWORD })
        .expect(401);
      const fresh = await signIn(NEW);
      const { body: me } = await fresh.get(api('/auth/me')).expect(200);
      expect(me.email).toBe(NEW);
      expect(me.emailVerifiedAt).not.toBeNull();

      await http()
        .post(api('/auth/reset-password'))
        .send({ token: resetToken, newPassword: 'Another-Password-456' })
        .expect(400);
      await until(() => inbox.to(mia.email, 'email-changed').length === 1);
      const [notice] = inbox.to(mia.email, 'email-changed');
      expect(notice.subject).toBe('Your For After email address was changed');
      expect(`${notice.text}${notice.html}`).not.toContain(NEW);
      // A used link changes nothing and tells nobody again.
      await confirm(token).expect(400);
      await sleep(300);
      expect(inbox.to(mia.email, 'email-changed')).toHaveLength(1);
      expect(
        await prisma.auditLog.count({
          where: { eventType: 'EMAIL_CHANGED', subjectId: id },
        }),
      ).toBe(1);
    });

    it('an expired link changes nothing', async () => {
      const ned = await customer('ned');
      const NEW = at('ned-new');
      await requestChange(ned.agent, NEW).expect(202);
      await until(() => !!linkTo(NEW));
      const token = tokens.at(-1)!;
      await prisma.authToken.update({
        where: { tokenHash: sha256(token) },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      await confirm(token)
        .expect(400)
        .expect((r) =>
          expect(r.body.message).toBe('This link is invalid or has expired.'),
        );
      await ned.agent.get(api('/auth/me')).expect(200);
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { email: ned.email } }))
          .email,
      ).toBe(ned.email);
    });

    it('two Customers racing for one address: the database lets only one have it', async () => {
      const cara = await customer('cara');
      const dan = await customer('dan');
      const WANTED = at('wanted');
      await requestChange(cara.agent, WANTED).expect(202);
      await until(() => inbox.to(WANTED, 'change-email').length === 1);
      const caraToken = linkTo(WANTED)!;
      await requestChange(dan.agent, WANTED).expect(202);
      await until(() => inbox.to(WANTED, 'change-email').length === 2);
      const danToken = linkTo(WANTED)!;

      const [a, b] = await Promise.all([confirm(caraToken), confirm(danToken)]);
      expect([a.status, b.status].sort((x, y) => x - y)).toEqual([200, 409]);
      const owners = await prisma.user.findMany({ where: { email: WANTED } });
      expect(owners).toHaveLength(1);
      // The loser keeps its old address and its session.
      const loser = a.status === 200 ? dan : cara;
      expect(await prisma.user.count({ where: { email: loser.email } })).toBe(
        1,
      );
      await loser.agent.get(api('/auth/me')).expect(200);
    });

    it('a malformed link is a 400', () => confirm('short').expect(400));

    it('no token or password ever reaches the logs', () => {
      const all = logs.join('\n');
      expect(tokens.length).toBeGreaterThan(5);
      for (const secret of [...tokens, PASSWORD])
        expect(all).not.toContain(secret);
      expect(all).toContain('email_changed user');
    });
  });
});
