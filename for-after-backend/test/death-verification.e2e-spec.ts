import { ConfigModule } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import { Queue } from 'bullmq';
import session from 'express-session';
import request from 'supertest';
import { adminSignIn } from './admin-sign-in.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { configureApp } from '../src/config/app.setup.js';
import {
  DeathNoticeDelivery,
  type SafetyNoticeInput,
} from '../src/death-verification/death-verification-notice.js';
import { DeathVerificationQueue } from '../src/death-verification/death-verification-queue.service.js';
import { DeathVerificationWorkflow } from '../src/death-verification/death-verification-workflow.service.js';
import { DeathVerificationModule } from '../src/death-verification/death-verification.module.js';
import { MediaModule } from '../src/media/media.module.js';
import { MediaStorage } from '../src/media/storage/media-storage.service.js';
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
import { TrustedContactAuthModule } from '../src/trusted-contact-auth/trusted-contact-auth.module.js';
import { TrustedContactOtpDelivery } from '../src/trusted-contact-auth/trusted-contact-auth.service.js';
import { TrustedContactPortalModule } from '../src/trusted-contact-portal/trusted-contact-portal.module.js';
import { TrustedContactsModule } from '../src/trusted-contacts/trusted-contacts.module.js';

// Step 15 end to end: real HTTP, guards, PostgreSQL, Redis and both BullMQ
// queues (safeguard + message release). Safety notices and OTPs go through
// fakes. The safeguard is 2 s so the real worker advances the case. Only
// fictional data; every test user (and so every case) is deleted afterwards.
describe('Death verification workflow (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let releaseQueue: Queue;
  let deathQueue: Queue;
  const run = Date.now();
  const at = (name: string) => `${name}.${run}@example.test`;
  const releaseQueueName = `test-dv-release-${run}`;
  const deathQueueName = `test-dv-${run}`;
  const password = 'StrongPassword123!';
  const users = {
    lisa: at('dv.lisa'),
    maya: at('dv.maya'),
    noah: at('dv.noah'),
    ruth: at('dv.ruth'),
    olga: at('dv.olga'),
    // Phase 10: reopening after a closed case.
    pia: at('dv.pia'),
    ivan: at('dv.ivan'),
    vera: at('dv.vera'),
    cora: at('dv.cora'),
    admin: at('dv.admin'),
  };
  const DAVID = at('dv.david');
  const SOFIA = at('dv.sofia');
  const ZERO = '00000000-0000-4000-8000-000000000000';

  const notices: SafetyNoticeInput[] = [];
  let noticeFails = false;
  const noticeDelivery = {
    sendAccountHolderSafetyNotice: vi.fn(async (input: SafetyNoticeInput) => {
      if (noticeFails) throw new Error('fake provider down');
      notices.push(input);
    }),
  };
  const otps: OtpDeliveryInput[] = [];
  const otpDelivery = {
    sendOtp: vi.fn(async (input: OtpDeliveryInput) => {
      otps.push(input);
    }),
  };
  const storage = {
    createUploadUrl: vi.fn(async () => 'https://storage.test/put'),
    createAccessUrl: vi.fn(async () => 'https://storage.test/get'),
    headObject: vi.fn(async () => ({ sizeBytes: 1, contentType: 'x' })),
    deleteObject: vi.fn(async () => undefined),
  };

  type Agent = ReturnType<typeof request.agent>;
  const agents: Record<string, Agent> = {};
  const ids: Record<string, string> = {};
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

  const signIn = async (email: string) => {
    const agent = request.agent(app.getHttpServer());
    await agent.post(api('/auth/login')).send({ email, password }).expect(200);
    return agent;
  };
  // The Customer's current (newest) case: there may be several (Phase 10).
  const caseOf = (email: string) =>
    prisma.deathVerificationCase.findFirstOrThrow({
      where: { owner: { email } },
      orderBy: [{ openedAt: 'desc' }, { id: 'desc' }],
    });
  const statusOf = async (id: string) =>
    (await prisma.message.findUniqueOrThrow({ where: { id } })).status;
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
  // Customer + Trusted Contact David (+ optional Recipient/messages) → report.
  const setupCustomer = async (
    key: keyof typeof users,
    messages: { title: string; schedule: object }[] = [],
  ) => {
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
    const messageIds: string[] = [];
    for (const m of messages) {
      const id = (
        await customer
          .post(api('/messages'))
          .send({
            title: m.title,
            textContent: 'Fictional death-trigger text.',
            recipientIds: [recipientId],
          })
          .expect(201)
      ).body.id as string;
      await customer
        .post(api(`/messages/${id}/schedule`))
        .send(m.schedule)
        .expect(201);
      messageIds.push(id);
    }
    return { tcId, recipientId, messageIds };
  };
  const report = (tcId: string) =>
    agents.david
      .post(api(`/trusted-contact/accounts/${tcId}/death-reports`))
      .send({ confirmReport: true, reportedDateOfDeath: '2026-09-01' })
      .expect(201);
  const toReadyForReview = async (email: string) => {
    await until(
      async () => (await caseOf(email)).status === 'READY_FOR_REVIEW',
    );
  };
  const verify = (caseId: string, body: object = {}, agent = agents.admin) =>
    agent.post(api(`/admin/death-verifications/${caseId}/verify`)).send({
      verifiedDeathAt: new Date(Date.now() - 60 * 86_400_000).toISOString(),
      confirmVerification: true,
      decisionNote: 'Fictional Step 15 verification test.',
      ...body,
    });

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
        MediaModule,
        RecipientAuthModule,
        RecipientPortalModule,
        TrustedContactAuthModule,
        TrustedContactPortalModule,
        DeathVerificationModule,
      ],
    })
      // Seven customer/admin sign-ins exceed the 5/min login limit; throttling
      // is covered by the auth e2e tests, not here.
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .overrideProvider(MediaStorage)
      .useValue(storage)
      .overrideProvider(DeathNoticeDelivery)
      .useValue(noticeDelivery)
      .overrideProvider(TrustedContactOtpDelivery)
      .useValue(otpDelivery)
      .overrideProvider(RecipientOtpDelivery)
      .useValue(otpDelivery)
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app, new session.MemoryStore());
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
    // Admins cannot self-register: an operator sets the role.
    await prisma.user.update({
      where: { email: users.admin },
      data: { role: 'ADMIN' },
    });
    for (const [key, email] of Object.entries(users)) {
      // Step 16: an admin session needs password + TOTP.
      agents[key] =
        key === 'admin'
          ? (await adminSignIn(app, email, password)).agent
          : await signIn(email);
    }
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

  describe('happy path: report → safeguard → review → VERIFIED → release', () => {
    it('report starts the safeguard only after the safety notice is sent', async () => {
      const setup = await setupCustomer('lisa', [
        { title: 'On death', schedule: { triggerType: 'ON_DEATH' } },
        {
          title: 'After death, overdue',
          schedule: { triggerType: 'AFTER_DEATH', afterDeathDays: 7 },
        },
        {
          title: 'After death, future',
          schedule: { triggerType: 'AFTER_DEATH', afterDeathDays: 365 },
        },
        {
          title: 'Fixed date',
          schedule: {
            triggerType: 'FIXED_DATE',
            scheduledFor: new Date(Date.now() + 3_600_000).toISOString(),
          },
        },
      ]);
      Object.assign(ids, {
        lisaTc: setup.tcId,
        onDeath: setup.messageIds[0],
        afterOverdue: setup.messageIds[1],
        afterFuture: setup.messageIds[2],
        fixed: setup.messageIds[3],
      });
      agents.david = await otpSignIn('trusted-contact-auth', DAVID);
      const res = await report(ids.lisaTc);
      ids.lisaCase = res.body.caseId;
      expect(res.body.status).toBe('PENDING_VERIFICATION');

      const kase = await caseOf(users.lisa);
      expect(kase.status).toBe('SAFEGUARD_ACTIVE');
      expect(kase.safetyNoticeSentAt).not.toBeNull();
      expect(
        kase.safeguardEndsAt!.getTime() - kase.safeguardStartedAt!.getTime(),
      ).toBe(2000);
      const notice = notices.find((n) => n.caseId === ids.lisaCase)!;
      expect(notice).toMatchObject({
        email: users.lisa,
        displayName: 'lisa Test',
      });
      // The notice carries no report, reporter or content data.
      expect(Object.keys(notice).sort()).toEqual([
        'caseId',
        'displayName',
        'email',
        'safeguardEndsAt',
      ]);
    });

    it('Customer sees SAFEGUARD_ACTIVE + deadline only; Trusted Contact sees status only', async () => {
      const me = await agents.lisa
        .get(api('/death-verification/me'))
        .expect(200);
      expect(me.body).toEqual({
        status: 'SAFEGUARD_ACTIVE',
        safeguardEndsAt: expect.any(String),
        canConfirmAlive: true,
      });
      const tc = await agents.david
        .get(api(`/trusted-contact/accounts/${ids.lisaTc}/death-verification`))
        .expect(200);
      expect(Object.keys(tc.body).sort()).toEqual([
        'canReport',
        'openedAt',
        'reportedByYou',
        'status',
      ]);
      expect(tc.body.canReport).toBe(false);
    });

    it('admin cannot verify during the safeguard (409), no override exists', async () => {
      await verify(ids.lisaCase).expect(409);
      await verify(ids.lisaCase, { force: true }).expect(400);
      expect((await caseOf(users.lisa)).status).toBe('SAFEGUARD_ACTIVE');
    });

    it('the real safeguard job advances to READY_FOR_REVIEW; nothing is released', async () => {
      await toReadyForReview(users.lisa);
      for (const id of [ids.onDeath, ids.afterOverdue, ids.afterFuture]) {
        expect(await statusOf(id)).toBe('SCHEDULED');
      }
      expect(
        await prisma.messageRelease.count({
          where: { message: { owner: { email: users.lisa } } },
        }),
      ).toBe(0);
      expect(
        await prisma.deathTriggeredMessageActivation.count({
          where: { deathVerificationCaseId: ids.lisaCase },
        }),
      ).toBe(0);
    });

    it('authorization: Customer, Trusted Contact and no session all 401; validation 400; unknown 404', async () => {
      // A Customer cookie is never read on admin routes (separate admin session).
      await verify(ids.lisaCase, {}, agents.maya).expect(401);
      await verify(ids.lisaCase, {}, agents.david).expect(401);
      await agents.maya.get(api('/admin/death-verifications')).expect(401);
      await http().get(api('/admin/death-verifications')).expect(401);
      await agents.admin
        .get(api('/admin/death-verifications/not-a-uuid'))
        .expect(400);
      await agents.admin
        .get(api(`/admin/death-verifications/${ZERO}`))
        .expect(404);
      await verify(ZERO).expect(404);
      for (const body of [
        { confirmVerification: undefined },
        { confirmVerification: false },
        { verifiedDeathAt: undefined },
        { verifiedDeathAt: '2026-09-28T14:30:00' },
        { verifiedDeathAt: '2099-01-01T00:00:00Z' },
        { ownerUserId: ZERO },
        { status: 'VERIFIED' },
        { verifiedByUserId: ZERO },
        { deathTriggersActivatedAt: new Date().toISOString() },
      ]) {
        await verify(ids.lisaCase, body).expect(400);
      }
      expect((await caseOf(users.lisa)).status).toBe('READY_FOR_REVIEW');
    });

    it('admin detail shows reports, count and audit trail; no Message content', async () => {
      const { body } = await agents.admin
        .get(api(`/admin/death-verifications/${ids.lisaCase}`))
        .expect(200);
      expect(body).toMatchObject({
        caseId: ids.lisaCase,
        status: 'READY_FOR_REVIEW',
        reportCount: 1,
        accountHolder: { email: users.lisa },
      });
      expect(body.reports[0]).toMatchObject({
        reporterFirstNameSnapshot: 'David',
        reportedDateOfDeath: '2026-09-01',
      });
      expect(
        body.auditEvents.map((e: { eventType: string }) => e.eventType),
      ).toEqual([
        'REPORT_RECEIVED',
        'SAFETY_NOTICE_SENT',
        'SAFEGUARD_STARTED',
        'SAFEGUARD_ELAPSED',
      ]);
      expect(JSON.stringify(body)).not.toContain(
        'Fictional death-trigger text',
      );
      const list = await agents.admin
        .get(api('/admin/death-verifications?status=READY_FOR_REVIEW'))
        .expect(200);
      // Step 16: paginated { items, pagination }.
      expect(
        list.body.items.map((c: { caseId: string }) => c.caseId),
      ).toContain(ids.lisaCase);
      expect(list.body.pagination).toMatchObject({ page: 1, limit: 25 });
      await agents.admin
        .get(api('/admin/death-verifications?status=DEAD'))
        .expect(400);
    });

    it('admin verifies: VERIFIED, audit, activations with correct due times', async () => {
      const deathAt = new Date(Date.now() - 60 * 86_400_000);
      const res = await verify(ids.lisaCase, {
        verifiedDeathAt: deathAt.toISOString().replace('Z', '+00:00'),
      }).expect(200);
      expect(res.body.status).toBe('VERIFIED');
      const kase = await caseOf(users.lisa);
      expect(kase.verifiedDeathAt).toEqual(deathAt);
      expect(kase.verifiedByUserId).not.toBeNull();
      expect(kase.deathTriggersActivatedAt).not.toBeNull();

      const acts = await prisma.deathTriggeredMessageActivation.findMany({
        where: { deathVerificationCaseId: ids.lisaCase },
      });
      const byMessage = Object.fromEntries(acts.map((a) => [a.messageId, a]));
      expect(Object.keys(byMessage).sort()).toEqual(
        [ids.onDeath, ids.afterOverdue, ids.afterFuture].sort(),
      );
      expect(byMessage[ids.onDeath].dueAt).toEqual(kase.verifiedAt);
      expect(byMessage[ids.afterOverdue].dueAt).toEqual(
        new Date(deathAt.getTime() + 7 * 86_400_000),
      );
      expect(byMessage[ids.afterFuture].dueAt).toEqual(
        new Date(deathAt.getTime() + 365 * 86_400_000),
      );
      // FIXED_DATE is not a death trigger.
      expect(byMessage[ids.fixed]).toBeUndefined();
    });

    it('queue releases ON_DEATH and overdue AFTER_DEATH; future AFTER_DEATH and FIXED_DATE wait', async () => {
      await until(
        async () =>
          (await statusOf(ids.onDeath)) === 'RELEASED' &&
          (await statusOf(ids.afterOverdue)) === 'RELEASED',
      );
      expect(await statusOf(ids.afterFuture)).toBe('SCHEDULED');
      expect(await statusOf(ids.fixed)).toBe('SCHEDULED');
      const releases = await prisma.messageRelease.findMany({
        where: { messageId: { in: [ids.onDeath, ids.afterOverdue] } },
      });
      expect(releases.map((r) => r.triggerType).sort()).toEqual([
        'AFTER_DEATH',
        'ON_DEATH',
      ]);
      expect(
        await prisma.recipientMessageAccessGrant.count({
          where: { messageId: { in: [ids.onDeath, ids.afterOverdue] } },
        }),
      ).toBe(2);
    });

    it('idempotent: re-running release and activation creates nothing new', async () => {
      const releases = app.get(MessageReleaseService);
      expect(await releases.release(ids.onDeath)).toEqual({
        result: 'already_released',
      });
      expect(await releases.release(ids.afterFuture)).toMatchObject({
        result: 'not_due',
      });
      const workflow = app.get(DeathVerificationWorkflow);
      await workflow.activateTriggers(ids.lisaCase);
      await app.get(DeathVerificationQueue).reconcile();
      expect(
        await prisma.deathTriggeredMessageActivation.count({
          where: { deathVerificationCaseId: ids.lisaCase },
        }),
      ).toBe(3);
      expect(
        await prisma.messageRelease.count({
          where: { messageId: ids.onDeath },
        }),
      ).toBe(1);
      expect(
        await prisma.recipientMessageAccessGrant.count({
          where: { messageId: ids.onDeath },
        }),
      ).toBe(1);
      const events = await prisma.deathVerificationAuditEvent.findMany({
        where: {
          deathVerificationCaseId: ids.lisaCase,
          eventType: {
            in: [
              'DEATH_TRIGGER_ACTIVATION_STARTED',
              'DEATH_TRIGGER_ACTIVATION_COMPLETED',
            ],
          },
        },
      });
      expect(events.map((e) => e.eventType).sort()).toEqual([
        'DEATH_TRIGGER_ACTIVATION_COMPLETED',
        'DEATH_TRIGGER_ACTIVATION_STARTED',
      ]);
    });

    it('the Recipient Portal shows death-triggered releases with no special casing', async () => {
      const sofia = await otpSignIn('recipient-auth', SOFIA);
      const { body } = await sofia.get(api('/recipient/messages')).expect(200);
      const titles = body.map((m: { title: string }) => m.title);
      expect(titles).toEqual(
        expect.arrayContaining(['On death', 'After death, overdue']),
      );
      expect(titles).not.toContain('After death, future');
    });

    it('the verified Customer can no longer sign in or use an old session; admins still can', async () => {
      await http()
        .post(api('/auth/login'))
        .send({ email: users.lisa, password })
        .expect(403);
      await agents.lisa.get(api('/auth/me')).expect(401);
      await agents.lisa.get(api('/messages')).expect(401);
      await agents.lisa
        .post(api('/death-verification/me/confirm-alive'))
        .send({ confirmAlive: true })
        .expect(401);
      await agents.admin.get(api('/admin-auth/me')).expect(200);
    });

    it('a verified case accepts no decisions or reports (409)', async () => {
      await verify(ids.lisaCase).expect(409);
      await agents.admin
        .post(api(`/admin/death-verifications/${ids.lisaCase}/reject`))
        .send({ confirmRejection: true })
        .expect(409);
      await agents.david
        .post(api(`/trusted-contact/accounts/${ids.lisaTc}/death-reports`))
        .send({ confirmReport: true })
        .expect(409);
    });
  });

  describe('Customer confirms alive', () => {
    it('SAFEGUARD_ACTIVE → CANCELLED; stays cancelled after the deadline; nothing released', async () => {
      const setup = await setupCustomer('maya', [
        { title: 'Maya on death', schedule: { triggerType: 'ON_DEATH' } },
      ]);
      const { body } = await report(setup.tcId);
      expect((await caseOf(users.maya)).status).toBe('SAFEGUARD_ACTIVE');
      const res = await agents.maya
        .post(api('/death-verification/me/confirm-alive'))
        .send({ confirmAlive: true })
        .expect(200);
      expect(res.body).toEqual({
        status: 'CANCELLED',
        safeguardEndsAt: expect.any(String),
        canConfirmAlive: false,
      });
      await sleep(2500);
      // Stale safeguard job / elapse is a no-op on a cancelled case.
      expect(
        await app.get(DeathVerificationWorkflow).elapseSafeguard(body.caseId),
      ).toMatchObject({ result: 'stale' });
      const kase = await caseOf(users.maya);
      expect(kase.status).toBe('CANCELLED');
      expect(kase.cancelledAt).not.toBeNull();
      expect(await statusOf(setup.messageIds[0])).toBe('SCHEDULED');
      // The report is kept as history.
      expect(
        await prisma.deathReport.count({
          where: { deathVerificationCaseId: body.caseId },
        }),
      ).toBe(1);
      await agents.maya
        .post(api('/death-verification/me/confirm-alive'))
        .send({ confirmAlive: true })
        .expect(409);
      await verify(body.caseId).expect(409);
      await agents.maya
        .post(api('/death-verification/me/confirm-alive'))
        .send({ confirmAlive: true, status: 'VERIFIED' })
        .expect(400);
    });

    it('a Customer with no case gets 404 on confirm-alive and a null status', async () => {
      await agents.ruth
        .post(api('/death-verification/me/confirm-alive'))
        .send({ confirmAlive: true })
        .expect(404);
      expect(
        (await agents.ruth.get(api('/death-verification/me')).expect(200)).body,
      ).toEqual({
        status: null,
        safeguardEndsAt: null,
        canConfirmAlive: false,
      });
      // The admin cookie is never read on Customer routes.
      await agents.admin.get(api('/death-verification/me')).expect(401);
    });
  });

  describe('admin rejects', () => {
    it('READY_FOR_REVIEW → REJECTED; nothing activated or released', async () => {
      const setup = await setupCustomer('noah', [
        { title: 'Noah on death', schedule: { triggerType: 'ON_DEATH' } },
      ]);
      const { body } = await report(setup.tcId);
      await agents.admin
        .post(api(`/admin/death-verifications/${body.caseId}/reject`))
        .send({ confirmRejection: true })
        .expect(409); // still in safeguard
      await toReadyForReview(users.noah);
      const res = await agents.admin
        .post(api(`/admin/death-verifications/${body.caseId}/reject`))
        .send({ confirmRejection: true, decisionNote: 'Unable to verify.' })
        .expect(200);
      expect(res.body.status).toBe('REJECTED');
      expect(await statusOf(setup.messageIds[0])).toBe('SCHEDULED');
      expect(
        await prisma.deathTriggeredMessageActivation.count({
          where: { deathVerificationCaseId: body.caseId },
        }),
      ).toBe(0);
      await verify(body.caseId).expect(409);
      // The Customer is untouched and the decision note is admin-only.
      await agents.noah.get(api('/auth/me')).expect(200);
      const me = await agents.noah
        .get(api('/death-verification/me'))
        .expect(200);
      expect(JSON.stringify(me.body)).not.toContain('Unable to verify');
    });
  });

  describe('race: confirm-alive vs admin verify', () => {
    it('exactly one terminal decision wins; the loser gets 409', async () => {
      const setup = await setupCustomer('ruth', [
        { title: 'Ruth on death', schedule: { triggerType: 'ON_DEATH' } },
      ]);
      const { body } = await report(setup.tcId);
      await toReadyForReview(users.ruth);
      const [alive, verified] = await Promise.all([
        agents.ruth
          .post(api('/death-verification/me/confirm-alive'))
          .send({ confirmAlive: true }),
        verify(body.caseId),
      ]);
      // The loser gets 409, or 401 if verify committed first: the account is
      // then PASSED and the Customer session guard refuses it.
      const codes = [alive.status, verified.status];
      expect(codes.filter((c) => c === 200)).toHaveLength(1);
      expect(codes.find((c) => c !== 200)).toBeOneOf([401, 409]);
      const kase = await caseOf(users.ruth);
      const user = await prisma.user.findUniqueOrThrow({
        where: { email: users.ruth },
      });
      if (alive.status === 200) {
        expect(kase.status).toBe('CANCELLED');
        expect(user.status).toBe('ACTIVE');
        expect(
          await prisma.deathTriggeredMessageActivation.count({
            where: { deathVerificationCaseId: body.caseId },
          }),
        ).toBe(0);
      } else {
        expect(kase.status).toBe('VERIFIED');
        expect(user.status).toBe('PASSED');
      }
      const terminal = await prisma.deathVerificationAuditEvent.count({
        where: {
          deathVerificationCaseId: body.caseId,
          eventType: { in: ['CUSTOMER_CONFIRMED_ALIVE', 'ADMIN_VERIFIED'] },
        },
      });
      expect(terminal).toBe(1);
    });
  });

  describe('notice failure and reconciliation', () => {
    it('a failed notice keeps PENDING_VERIFICATION; the reconciler starts the safeguard later', async () => {
      const email = users.olga;
      const setup = await setupCustomer('olga');
      noticeFails = true;
      const { body } = await report(setup.tcId);
      noticeFails = false;
      let kase = await caseOf(email);
      expect(kase.status).toBe('PENDING_VERIFICATION');
      expect(kase.safetyNoticeSentAt).toBeNull();
      expect(kase.safetyNoticeAttemptCount).toBe(1);
      // Retry needs half an interval (1800 s here) to pass: simulate the clock.
      await app
        .get(DeathVerificationWorkflow)
        .startSafeguard(body.caseId, new Date(Date.now() + 3_600_000));
      kase = await caseOf(email);
      expect(kase.status).toBe('SAFEGUARD_ACTIVE');
      expect(kase.safetyNoticeAttemptCount).toBe(2);
    });
  });

  describe('reopening after a closed case (Phase 10)', () => {
    const EVE = at('dv.eve');
    const OPEN = [
      'PENDING_VERIFICATION',
      'SAFEGUARD_ACTIVE',
      'READY_FOR_REVIEW',
    ] as const;
    const casesOf = (email: string) =>
      prisma.deathVerificationCase.findMany({
        where: { owner: { email } },
        orderBy: [{ openedAt: 'asc' }, { id: 'asc' }],
        include: {
          reports: { select: { reportedByTrustedContactId: true } },
          auditEvents: {
            orderBy: { createdAt: 'asc' },
            select: { eventType: true, actorTrustedContactId: true },
          },
        },
      });
    const openCount = (email: string) =>
      prisma.deathVerificationCase.count({
        where: { owner: { email }, status: { in: [...OPEN] } },
      });
    const addEve = async (key: keyof typeof users) => {
      const id = (
        await agents[key]
          .post(api('/trusted-contacts'))
          .send({ firstName: 'Eve', email: EVE })
          .expect(201)
      ).body.id as string;
      agents.eve ??= await otpSignIn('trusted-contact-auth', EVE);
      return id;
    };
    const reportAs = (agent: Agent, tcId: string) =>
      agent
        .post(api(`/trusted-contact/accounts/${tcId}/death-reports`))
        .send({ confirmReport: true });
    const confirmAlive = (key: keyof typeof users) =>
      agents[key]
        .post(api('/death-verification/me/confirm-alive'))
        .send({ confirmAlive: true });
    const accountStatus = async (email: string) =>
      (await prisma.user.findUniqueOrThrow({ where: { email } })).status;

    it('CANCELLED: the next report opens case 2; case 1 is untouched; the full safety workflow runs again', async () => {
      const { tcId, messageIds } = await setupCustomer('pia', [
        { title: 'Pia on death', schedule: { triggerType: 'ON_DEATH' } },
      ]);
      const first = (await report(tcId)).body.caseId as string;
      await confirmAlive('pia').expect(200);
      const closed = await prisma.deathVerificationCase.findUniqueOrThrow({
        where: { id: first },
      });
      expect(closed.status).toBe('CANCELLED');

      const status = await agents.david
        .get(api(`/trusted-contact/accounts/${tcId}/death-verification`))
        .expect(200);
      expect(status.body).toMatchObject({
        status: 'CANCELLED',
        reportedByYou: true,
        canReport: true,
      });

      const second = (await report(tcId)).body;
      expect(second.caseId).not.toBe(first);
      expect(second.status).toBe('PENDING_VERIFICATION');

      // Case 1 is immutable history: not a single field changed.
      expect(
        await prisma.deathVerificationCase.findUniqueOrThrow({
          where: { id: first },
        }),
      ).toEqual(closed);
      const [one, two] = await casesOf(users.pia);
      expect(one.id).toBe(first);
      expect(one.auditEvents.map((e) => e.eventType)).toContain(
        'CUSTOMER_CONFIRMED_ALIVE',
      );
      expect(two.reopenedFromCaseId).toBe(first);
      expect(two.auditEvents.slice(0, 2)).toEqual([
        { eventType: 'CASE_REOPENED', actorTrustedContactId: tcId },
        { eventType: 'REPORT_RECEIVED', actorTrustedContactId: tcId },
      ]);
      expect(await openCount(users.pia)).toBe(1);

      // Same workflow: a new safety notice, then the safeguard, then review.
      expect(notices.some((n) => n.caseId === second.caseId)).toBe(true);
      await toReadyForReview(users.pia);
      const me = await agents.pia
        .get(api('/death-verification/me'))
        .expect(200);
      expect(me.body).toMatchObject({
        status: 'READY_FOR_REVIEW',
        canConfirmAlive: true,
      });
      // A report verifies nothing and releases nothing.
      expect(await statusOf(messageIds[0])).toBe('SCHEDULED');
      expect(await accountStatus(users.pia)).toBe('ACTIVE');
      // The same contact cannot file twice into the open case.
      await reportAs(agents.david, tcId).expect(409);
      expect(await openCount(users.pia)).toBe(1);
    });

    it('the database itself refuses a second open case, or any case next to a VERIFIED one', async () => {
      for (const email of [users.pia, users.lisa]) {
        const { id } = await prisma.user.findUniqueOrThrow({
          where: { email },
        });
        await expect(
          prisma.deathVerificationCase.create({ data: { ownerUserId: id } }),
        ).rejects.toMatchObject({ code: 'P2002' });
      }
    });

    it('REJECTED: another active Trusted Contact opens case 2; it is reviewed and verified normally', async () => {
      const { tcId, messageIds } = await setupCustomer('ivan', [
        { title: 'Ivan on death', schedule: { triggerType: 'ON_DEATH' } },
      ]);
      const eveTc = await addEve('ivan');
      const first = (await report(tcId)).body.caseId as string;
      await toReadyForReview(users.ivan);
      await agents.admin
        .post(api(`/admin/death-verifications/${first}/reject`))
        .send({ confirmRejection: true, decisionNote: 'Fictional rejection.' })
        .expect(200);

      const second = (await reportAs(agents.eve, eveTc).expect(201)).body;
      expect(second.caseId).not.toBe(first);
      const [one, two] = await casesOf(users.ivan);
      expect(one).toMatchObject({ id: first, status: 'REJECTED' });
      expect(one.reports).toEqual([{ reportedByTrustedContactId: tcId }]);
      expect(two).toMatchObject({ reopenedFromCaseId: first });
      expect(two.auditEvents[0]).toEqual({
        eventType: 'CASE_REOPENED',
        actorTrustedContactId: eveTc,
      });

      // A report alone: no PASSED, no release. Only the admin's verification.
      await toReadyForReview(users.ivan);
      expect(await statusOf(messageIds[0])).toBe('SCHEDULED');
      expect(await accountStatus(users.ivan)).toBe('ACTIVE');
      await verify(second.caseId).expect(200);
      expect(await accountStatus(users.ivan)).toBe('PASSED');
      await until(async () => (await statusOf(messageIds[0])) === 'RELEASED');

      // History stays queryable for admins: both cases, the old one unchanged.
      const old = await agents.admin
        .get(api(`/admin/death-verifications/${first}`))
        .expect(200);
      expect(old.body).toMatchObject({
        status: 'REJECTED',
        reopenedFromCaseId: null,
      });
      const latest = await agents.admin
        .get(api(`/admin/death-verifications/${second.caseId}`))
        .expect(200);
      expect(latest.body).toMatchObject({
        status: 'VERIFIED',
        reopenedFromCaseId: first,
      });
    });

    it('VERIFIED / PASSED is never reopened: no new case, no second release', async () => {
      const releases = () =>
        prisma.messageRelease.count({
          where: { message: { owner: { email: users.lisa } } },
        });
      const before = await releases();
      await reportAs(agents.david, ids.lisaTc).expect(409);
      const status = await agents.david
        .get(api(`/trusted-contact/accounts/${ids.lisaTc}/death-verification`))
        .expect(200);
      expect(status.body).toMatchObject({
        status: 'VERIFIED',
        canReport: false,
      });
      expect(await casesOf(users.lisa)).toHaveLength(1);
      expect(await releases()).toBe(before);
    });

    it('race: two Trusted Contacts reporting after CANCELLED open exactly one new case', async () => {
      const { tcId } = await setupCustomer('vera');
      const eveTc = await addEve('vera');
      await report(tcId);
      await confirmAlive('vera').expect(200);
      const [a, b] = await Promise.all([
        reportAs(agents.david, tcId),
        reportAs(agents.eve, eveTc),
      ]);
      expect([a.status, b.status]).toEqual([201, 201]);
      expect(a.body.caseId).toBe(b.body.caseId);
      const cases = await casesOf(users.vera);
      expect(cases).toHaveLength(2);
      expect(cases[0].status).toBe('CANCELLED');
      expect(OPEN).toContain(cases[1].status);
      expect(cases[1].reports).toHaveLength(2);
      expect(
        cases[1].auditEvents.filter((e) => e.eventType === 'CASE_REOPENED'),
      ).toHaveLength(1);
      expect(await openCount(users.vera)).toBe(1);
    });

    it('race: a report during confirm-alive never builds on stale state', async () => {
      const { tcId } = await setupCustomer('cora');
      const eveTc = await addEve('cora');
      const first = (await report(tcId)).body.caseId as string;
      const [alive, late] = await Promise.all([
        confirmAlive('cora'),
        reportAs(agents.eve, eveTc),
      ]);
      expect(alive.status).toBe(200);
      expect(late.status).toBe(201);
      const cases = await casesOf(users.cora);
      expect(cases[0]).toMatchObject({ id: first, status: 'CANCELLED' });
      if (late.body.caseId === first) {
        // The report committed first and was then cancelled with its case.
        expect(cases).toHaveLength(1);
        expect(cases[0].reports).toHaveLength(2);
      } else {
        // The cancel committed first: the report saw CANCELLED and reopened.
        expect(cases).toHaveLength(2);
        expect(cases[0].reports).toEqual([
          { reportedByTrustedContactId: tcId },
        ]);
        expect(cases[1]).toMatchObject({
          reopenedFromCaseId: first,
          reports: [{ reportedByTrustedContactId: eveTc }],
        });
      }
      expect(await openCount(users.cora)).toBeLessThanOrEqual(1);
    });
  });
});
