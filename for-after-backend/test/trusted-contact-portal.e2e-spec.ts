import { ConfigModule } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';
import session from 'express-session';
import request from 'supertest';
import { releaseJobId } from '../src/message-release/message-release-queue.service.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { configureApp } from '../src/config/app.setup.js';
import {
  ALREADY_REPORTED,
  REPORT_RECEIVED,
} from '../src/death-verification/death-verification.service.js';
import { MediaModule } from '../src/media/media.module.js';
import { MediaStorage } from '../src/media/storage/media-storage.service.js';
import { FakeMediaStorage } from './fake-media-storage.js';
import { MessageSchedulesModule } from '../src/message-schedules/message-schedules.module.js';
import { MessagesModule } from '../src/messages/messages.module.js';
import { MemoryVaultModule } from '../src/memory-vault/memory-vault.module.js';
import { MyStoryModule } from '../src/my-story/my-story.module.js';
import { MyWishesModule } from '../src/my-wishes/my-wishes.module.js';
import {
  INVALID_CODE,
  type OtpDeliveryInput,
} from '../src/otp-auth/otp-auth.service.js';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { RecipientAuthModule } from '../src/recipient-auth/recipient-auth.module.js';
import {
  RECIPIENT_SESSION_COOKIE,
  RecipientAuthService,
} from '../src/recipient-auth/recipient-auth.service.js';
import { RecipientOtpDelivery } from '../src/recipient-auth/recipient-otp-delivery.js';
import { RecipientPortalModule } from '../src/recipient-portal/recipient-portal.module.js';
import { RecipientsModule } from '../src/recipients/recipients.module.js';
import { RedisModule } from '../src/redis/redis.module.js';
import { TrustedContactAuthModule } from '../src/trusted-contact-auth/trusted-contact-auth.module.js';
import {
  TRUSTED_CONTACT_OTP_REQUESTED,
  TRUSTED_CONTACT_SESSION_COOKIE,
  TrustedContactOtpDelivery,
} from '../src/trusted-contact-auth/trusted-contact-auth.service.js';
import { TrustedContactPortalModule } from '../src/trusted-contact-portal/trusted-contact-portal.module.js';
import { TrustedContactsModule } from '../src/trusted-contacts/trusted-contacts.module.js';

// Step 14 end to end: real HTTP, validation, guards, PostgreSQL and Redis
// (OTP challenges, sessions, rate limits). OTP delivery is a fake that
// captures codes in memory; object storage is mocked. Fictional data only;
// test users (and through them all Step 14 rows) are removed afterwards.
describe('Trusted Contact auth + death report intake (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let queue: Queue;
  const run = Date.now();
  const queueName = `test-trusted-contact-${run}`;
  const at = (name: string) => `${name}.${run}@example.test`;
  const LISA = at('tc.lisa');
  const JOHN = at('tc.john');
  const DAVID = at('david');
  const SARAH = at('sarah');
  const GHOST = at('ghost');
  const password = 'StrongPassword123!';
  const ZERO = '00000000-0000-4000-8000-000000000000';

  const sent: OtpDeliveryInput[] = [];
  const delivery = {
    sendOtp: vi.fn(async (input: OtpDeliveryInput) => {
      sent.push(input);
    }),
  };
  const storage = new FakeMediaStorage();

  type Agent = ReturnType<typeof request.agent>;
  let lisa: Agent;
  let john: Agent;
  let david: Agent;
  const ids: Record<string, string> = {};
  const api = (path: string) => `/api/v1${path}`;
  const http = () => request(app.getHttpServer());

  const signIn = async (email: string) => {
    const agent = request.agent(app.getHttpServer());
    await agent.post(api('/auth/login')).send({ email, password }).expect(200);
    return agent;
  };
  const addContact = async (agent: Agent, body: object) =>
    (await agent.post(api('/trusted-contacts')).send(body).expect(201)).body
      .id as string;
  const requestOtp = (email: string) =>
    http().post(api('/trusted-contact-auth/request-otp')).send({ email });
  const verify = (challengeId: string, code: string, agent?: Agent) =>
    (agent ?? http())
      .post(api('/trusted-contact-auth/verify-otp'))
      .send({ challengeId, code });
  // Full OTP sign-in; the code comes from the fake delivery only.
  const contactSignIn = async (email: string) => {
    const { challengeId } = (await requestOtp(email).expect(202)).body;
    const agent = request.agent(app.getHttpServer());
    await verify(
      challengeId,
      sent.findLast((s) => s.email === email)!.code,
      agent,
    ).expect(200);
    return agent;
  };
  const report = (agent: Agent, id: string, body: object = {}) =>
    agent.post(api(`/trusted-contact/accounts/${id}/death-reports`)).send({
      reportedDateOfDeath: '2026-09-28',
      note: 'Fictional test report.',
      confirmReport: true,
      ...body,
    });
  // Release-side state of Lisa's messages, compared before/after reports.
  const releaseState = async () => ({
    messages: await prisma.message.findMany({
      where: { owner: { email: LISA } },
      select: { id: true, status: true, schedule: true },
      orderBy: { id: 'asc' },
    }),
    releases: await prisma.messageRelease.count({
      where: { message: { owner: { email: LISA } } },
    }),
    grants: await prisma.recipientMessageAccessGrant.count({
      where: { message: { owner: { email: LISA } } },
    }),
    lisa: await prisma.user.findUnique({
      where: { email: LISA },
      select: { status: true, passedAt: true },
    }),
  });

  beforeAll(async () => {
    process.env.RELEASE_QUEUE_NAME = queueName;
    process.env.RELEASE_RECONCILE_INTERVAL_SECONDS = '3600';
    // Local runs repeat within the 15 min window from one IP.
    process.env.TRUSTED_CONTACT_OTP_IP_REQUEST_LIMIT = '10000';
    process.env.TRUSTED_CONTACT_OTP_VERIFY_IP_LIMIT = '10000';
    process.env.TRUSTED_CONTACT_OTP_REQUEST_LIMIT = '10';
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
        MediaModule,
        MemoryVaultModule,
        MyStoryModule,
        MyWishesModule,
        RecipientAuthModule,
        RecipientPortalModule,
        TrustedContactAuthModule,
        TrustedContactPortalModule,
      ],
    })
      .overrideProvider(MediaStorage)
      .useValue(storage)
      .overrideProvider(TrustedContactOtpDelivery)
      .useValue(delivery)
      .overrideProvider(RecipientOtpDelivery)
      .useValue({ sendOtp: async () => undefined })
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app, new session.MemoryStore());
    await app.init();
    prisma = app.get(PrismaService);
    queue = new Queue(queueName, {
      connection: { url: process.env.REDIS_URL! },
    });

    for (const [email, firstName] of [
      [LISA, 'Lisa'],
      [JOHN, 'John'],
    ]) {
      await http()
        .post(api('/auth/register'))
        .send({ email, password, firstName, lastName: 'Test' })
        .expect(201);
    }
    lisa = await signIn(LISA);
    john = await signIn(JOHN);

    // Mixed case on purpose: stored lowercased, matched after normalization.
    ids.david = await addContact(lisa, {
      firstName: 'David',
      lastName: 'Test',
      relationship: 'Friend',
      email: DAVID.toUpperCase(),
      mobile: '+61 400 000 111',
    });
    // Removed before Sarah is added: at most two active contacts (Phase 10).
    ids.ghost = await addContact(lisa, { firstName: 'Ghost', email: GHOST });
    await lisa.delete(api(`/trusted-contacts/${ids.ghost}`)).expect(204);
    ids.sarah = await addContact(lisa, {
      firstName: 'Sarah',
      relationship: 'Sister',
      email: SARAH,
    });
    // David is also John's Trusted Contact; John has no content.
    ids.davidForJohn = await addContact(john, {
      firstName: 'David',
      relationship: 'Neighbour',
      email: DAVID,
    });

    ids.recipient = (
      await lisa
        .post(api('/recipients'))
        .send({ firstName: 'Sofia', email: at('sofia') })
        .expect(201)
    ).body.id;
    const message = async (title: string, triggerType?: string) => {
      const id = (
        await lisa
          .post(api('/messages'))
          .send({
            title,
            textContent: 'Fictional private text.',
            recipientIds: [ids.recipient],
          })
          .expect(201)
      ).body.id as string;
      if (triggerType) {
        await lisa
          .post(api(`/messages/${id}/schedule`))
          .send(
            triggerType === 'AFTER_DEATH'
              ? { triggerType, afterDeathDays: 30 }
              : { triggerType },
          )
          .expect(201);
      }
      return id;
    };
    ids.draft = await message('Secret draft title');
    ids.onDeath = await message('On death', 'ON_DEATH');
    ids.afterDeath = await message('After death', 'AFTER_DEATH');
  });

  afterAll(async () => {
    await prisma?.user.deleteMany({ where: { email: { in: [LISA, JOHN] } } });
    await app?.close();
    await queue?.obliterate({ force: true });
    await queue?.close();
  });

  describe('OTP request / verify', () => {
    it('known, unknown and deleted-contact emails get the same generic 202', async () => {
      const bodies = [];
      for (const email of [DAVID, 'unknown@example.com', GHOST]) {
        const res = await requestOtp(email).expect(202);
        expect(res.body.message).toBe(TRUSTED_CONTACT_OTP_REQUESTED);
        expect(res.body.challengeId).toMatch(/^[A-Za-z0-9_-]{43}$/);
        bodies.push(Object.keys(res.body).sort());
      }
      expect(new Set(bodies.map(String)).size).toBe(1);
      expect(sent.some((s) => s.email === 'unknown@example.com')).toBe(false);
      expect(sent.some((s) => s.email === GHOST)).toBe(false);
    });

    it('invalid email → 400', async () => {
      await requestOtp('not-an-email').expect(400);
      await http()
        .post(api('/trusted-contact-auth/request-otp'))
        .send({ email: DAVID, extra: 1 })
        .expect(400);
    });

    it('wrong → 401; right → 200 + HttpOnly Lax cookie; reuse → 401', async () => {
      const { challengeId } = (await requestOtp(DAVID).expect(202)).body;
      const code = sent.findLast((s) => s.email === DAVID)!.code;
      const wrong = String((Number(code) + 1) % 1e6).padStart(6, '0');
      expect((await verify(challengeId, wrong).expect(401)).body.message).toBe(
        INVALID_CODE,
      );
      const ok = await verify(challengeId, code).expect(200);
      expect(ok.body).toEqual({ authenticated: true, email: DAVID });
      const cookie = String(ok.headers['set-cookie']);
      expect(cookie).toMatch(new RegExp(`^${TRUSTED_CONTACT_SESSION_COOKIE}=`));
      expect(cookie).toMatch(/HttpOnly/);
      expect(cookie).toMatch(/SameSite=Lax/);
      expect(cookie).not.toContain(`${RECIPIENT_SESSION_COOKIE}=`);
      await verify(challengeId, code).expect(401);
    });

    it('too many wrong codes make the challenge unusable', async () => {
      const { challengeId } = (await requestOtp(DAVID).expect(202)).body;
      const code = sent.findLast((s) => s.email === DAVID)!.code;
      const wrong = String((Number(code) + 1) % 1e6).padStart(6, '0');
      for (let i = 0; i < 5; i++) await verify(challengeId, wrong).expect(401);
      await verify(challengeId, code).expect(401);
    });

    it('bad challengeId / code format → 400', async () => {
      await verify('short', '123456').expect(400);
      await verify('a'.repeat(43), '12ab').expect(400);
    });

    it('too many OTP requests for one email → 429', async () => {
      const email = at('burst');
      const codes = [];
      for (let i = 0; i < 11; i++) codes.push((await requestOtp(email)).status);
      expect(codes.slice(0, 10).every((c) => c === 202)).toBe(true);
      expect(codes[10]).toBe(429);
    });

    it('/me and logout: 204, session destroyed, cookie cleared', async () => {
      const agent = await contactSignIn(DAVID);
      expect(
        (await agent.get(api('/trusted-contact-auth/me')).expect(200)).body,
      ).toEqual({ authenticated: true, email: DAVID });
      const out = await agent
        .post(api('/trusted-contact-auth/logout'))
        .expect(204);
      expect(String(out.headers['set-cookie'])).toMatch(
        new RegExp(`^${TRUSTED_CONTACT_SESSION_COOKIE}=;`),
      );
      await agent.get(api('/trusted-contact-auth/me')).expect(401);
      await agent.get(api('/trusted-contact/accounts')).expect(401);
      await http().post(api('/trusted-contact-auth/logout')).expect(204);
    });
  });

  describe('session separation (three principals)', () => {
    it('Customer cookie only → 401 on Trusted Contact routes', async () => {
      await lisa.get(api('/trusted-contact/accounts')).expect(401);
      await lisa.get(api('/trusted-contact-auth/me')).expect(401);
    });

    it('Recipient cookie only → 401 on Trusted Contact routes', async () => {
      const sid = await app
        .get(RecipientAuthService)
        .createSession({ emailNormalized: DAVID });
      for (const cookie of [
        `${RECIPIENT_SESSION_COOKIE}=${sid}`,
        `${TRUSTED_CONTACT_SESSION_COOKIE}=${sid}`,
      ]) {
        await http()
          .get(api('/trusted-contact/accounts'))
          .set('Cookie', cookie)
          .expect(401);
      }
    });

    it('Trusted Contact cookie only → 401 on Customer and Recipient routes', async () => {
      david = await contactSignIn(DAVID);
      for (const path of [
        '/auth/me',
        '/messages',
        '/recipients',
        '/trusted-contacts',
        '/memory-vault',
        '/my-story/prompts',
        '/my-wishes/prompts',
        '/recipient/messages',
        '/recipient-auth/me',
        // Phase 10 permission model: no content, Recipient, settings or
        // Customer case routes with a Trusted Contact session either.
        `/messages/${ids.draft}`,
        `/messages/${ids.draft}/media`,
        `/recipients/${ids.recipient}`,
        `/trusted-contacts/${ids.david}`,
        '/death-verification/me',
      ]) {
        const res = await david.get(api(path));
        expect([path, res.status]).toEqual([path, 401]);
      }
      // Nor can it act for the Customer (settings, confirm alive, contacts).
      await david.patch(api('/users/me')).send({ firstName: 'X' }).expect(401);
      await david
        .post(api('/death-verification/me/confirm-alive'))
        .send({})
        .expect(401);
      await david
        .post(api(`/trusted-contacts/${ids.david}/invitation`))
        .expect(401);
    });
  });

  describe('accounts', () => {
    it('lists each active relationship for the email, with safe fields only', async () => {
      const res = await david.get(api('/trusted-contact/accounts')).expect(200);
      expect(res.body).toEqual([
        {
          trustedContactId: ids.david,
          accountHolder: { displayName: 'Lisa Test' },
          relationship: 'Friend',
          hasPreservedContent: true,
          deathVerificationStatus: null,
        },
        {
          trustedContactId: ids.davidForJohn,
          accountHolder: { displayName: 'John Test' },
          relationship: 'Neighbour',
          hasPreservedContent: false,
          deathVerificationStatus: null,
        },
      ]);
      // toEqual above pins the exact shape; this guards the raw payload too.
      const raw = JSON.stringify(res.body);
      for (const leak of [
        LISA,
        JOHN,
        'ownerUserId',
        'Secret draft',
        'Sofia',
        '_count',
        'mobile',
        '"email"',
      ]) {
        expect(raw).not.toContain(leak);
      }
    });

    it('a deleted relationship is excluded and cannot sign in', async () => {
      const { challengeId } = (await requestOtp(GHOST).expect(202)).body;
      expect(sent.some((s) => s.email === GHOST)).toBe(false);
      await verify(challengeId, '123456').expect(401);
    });

    it('hasPreservedContent turns true for Memory Vault / My Story content too', async () => {
      await john
        .post(api('/memory-vault'))
        .send({ title: 'Fictional memory', category: 'FAMILY' })
        .expect(201);
      const res = await david.get(api('/trusted-contact/accounts')).expect(200);
      expect(
        res.body.find(
          (a: { trustedContactId: string }) =>
            a.trustedContactId === ids.davidForJohn,
        ).hasPreservedContent,
      ).toBe(true);
    });
  });

  describe('death reports', () => {
    it('validation: 400 for bad input and injected fields; 400 bad UUID; 404 foreign id', async () => {
      const tomorrow = new Date(Date.now() + 2 * 86_400_000 + 14 * 3_600_000)
        .toISOString()
        .slice(0, 10);
      for (const body of [
        { reportedDateOfDeath: tomorrow },
        { reportedDateOfDeath: '2026-02-30' },
        { confirmReport: false },
        { confirmReport: undefined },
        { note: 'x'.repeat(2001) },
        { ownerUserId: ZERO },
        { status: 'VERIFIED' },
        { unknownField: 1 },
      ]) {
        await report(david, ids.david, body).expect(400);
      }
      await report(david, 'not-a-uuid').expect(400);
      // Sarah's relationship id, and a random one: both 404 for David.
      await report(david, ids.sarah).expect(404);
      await report(david, ZERO).expect(404);
      await david
        .get(api(`/trusted-contact/accounts/${ids.sarah}/death-verification`))
        .expect(404);
      expect(
        await prisma.deathVerificationCase.count({
          where: { owner: { email: LISA } },
        }),
      ).toBe(0);
    });

    it('first report → 201 PENDING_VERIFICATION; nothing released, nobody marked dead', async () => {
      const before = await releaseState();
      expect(before.messages.find((m) => m.id === ids.onDeath)!.status).toBe(
        'SCHEDULED',
      );

      const res = await report(david, ids.david).expect(201);
      expect(res.body).toEqual({
        caseId: expect.any(String),
        reportId: expect.any(String),
        status: 'PENDING_VERIFICATION',
        reportedAt: expect.any(String),
        message: REPORT_RECEIVED,
      });
      ids.case = res.body.caseId;

      const after = await releaseState();
      expect(after).toEqual(before);
      expect(after.messages.find((m) => m.id === ids.onDeath)!.status).toBe(
        'SCHEDULED',
      );
      expect(after.messages.find((m) => m.id === ids.afterDeath)!.status).toBe(
        'SCHEDULED',
      );
      expect(after.releases).toBe(0);
      expect(after.grants).toBe(0);
      expect(after.lisa).toEqual({ status: 'ACTIVE', passedAt: null });
      // Nothing queued for Lisa's messages. (Not global counts: the release
      // reconciler scans the shared test database, so parallel e2e files'
      // FIXED_DATE messages can legitimately appear in this queue.)
      for (const id of [ids.onDeath, ids.afterDeath]) {
        expect(await queue.getJob(releaseJobId(id))).toBeUndefined();
      }

      const stored = await prisma.deathReport.findUniqueOrThrow({
        where: { id: res.body.reportId },
      });
      expect(stored).toMatchObject({
        deathVerificationCaseId: ids.case,
        reportedByTrustedContactId: ids.david,
        reporterFirstNameSnapshot: 'David',
        reporterLastNameSnapshot: 'Test',
        reporterEmailNormalized: DAVID,
        reporterMobileNormalized: '+61 400 000 111',
        note: 'Fictional test report.',
      });
      expect(stored.reportedDateOfDeath!.toISOString().slice(0, 10)).toBe(
        '2026-09-28',
      );
    });

    it('status: PENDING_VERIFICATION, reportedByYou, no reporters or counts', async () => {
      const res = await david
        .get(api(`/trusted-contact/accounts/${ids.david}/death-verification`))
        .expect(200);
      expect(res.body).toEqual({
        status: 'PENDING_VERIFICATION',
        reportedByYou: true,
        openedAt: expect.any(String),
        canReport: false,
      });
      const list = await david
        .get(api('/trusted-contact/accounts'))
        .expect(200);
      expect(list.body[0].deathVerificationStatus).toBe('PENDING_VERIFICATION');
      // John's account has no case.
      expect(list.body[1].deathVerificationStatus).toBeNull();
    });

    it('duplicate report by the same contact → 409, still one report', async () => {
      const res = await report(david, ids.david).expect(409);
      expect(res.body.message).toBe(ALREADY_REPORTED);
      expect(
        await prisma.deathReport.count({
          where: { reportedByTrustedContactId: ids.david },
        }),
      ).toBe(1);
    });

    it('a second Trusted Contact reports into the same case; still pending, still nothing released', async () => {
      const before = await releaseState();
      const sarah = await contactSignIn(SARAH);
      expect(
        (
          await sarah
            .get(
              api(`/trusted-contact/accounts/${ids.sarah}/death-verification`),
            )
            .expect(200)
        ).body,
      ).toMatchObject({
        status: 'PENDING_VERIFICATION',
        reportedByYou: false,
        canReport: true,
      });
      const res = await report(sarah, ids.sarah, {
        reportedDateOfDeath: undefined,
        note: undefined,
      }).expect(201);
      expect(res.body).toMatchObject({
        caseId: ids.case,
        status: 'PENDING_VERIFICATION',
      });
      const found = await prisma.deathVerificationCase.findUniqueOrThrow({
        where: { id: ids.case },
        include: { reports: true },
      });
      expect(found.status).toBe('PENDING_VERIFICATION');
      expect(found.resolvedAt).toBeNull();
      expect(found.reports).toHaveLength(2);
      expect(await releaseState()).toEqual(before);
      // No report count leaks to either contact.
      const status = await sarah
        .get(api(`/trusted-contact/accounts/${ids.sarah}/death-verification`))
        .expect(200);
      expect(Object.keys(status.body).sort()).toEqual([
        'canReport',
        'openedAt',
        'reportedByYou',
        'status',
      ]);
      await lisa.delete(api(`/trusted-contacts/${ids.sarah}`)).expect(204);
      // Removed relationship: no longer listed or reachable; report kept.
      expect(
        (await sarah.get(api('/trusted-contact/accounts')).expect(200)).body,
      ).toEqual([]);
      await sarah
        .get(api(`/trusted-contact/accounts/${ids.sarah}/death-verification`))
        .expect(404);
      expect(
        await prisma.deathReport.count({
          where: { reportedByTrustedContactId: ids.sarah },
        }),
      ).toBe(1);
    });

    it('editing the Trusted Contact later does not change the report snapshot', async () => {
      await lisa
        .patch(api(`/trusted-contacts/${ids.david}`))
        .send({
          firstName: 'Dave',
          lastName: 'Renamed',
          mobile: '+61 499 999 999',
        })
        .expect(200);
      const stored = await prisma.deathReport.findFirstOrThrow({
        where: { reportedByTrustedContactId: ids.david },
      });
      expect(stored).toMatchObject({
        reporterFirstNameSnapshot: 'David',
        reporterLastNameSnapshot: 'Test',
        reporterMobileNormalized: '+61 400 000 111',
      });
    });

    it('David can report independently for John', async () => {
      const res = await report(david, ids.davidForJohn).expect(201);
      expect(res.body.caseId).not.toBe(ids.case);
    });
  });
});
