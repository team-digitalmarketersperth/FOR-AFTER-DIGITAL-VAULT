import { ConfigModule } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import session from 'express-session';
import request from 'supertest';
import { adminSignIn } from './admin-sign-in.js';
import { FakeEmailProvider } from './fake-email.js';
import { AdminModule } from '../src/admin/admin.module.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { configureApp } from '../src/config/app.setup.js';
import { DeathVerificationWorkflow } from '../src/death-verification/death-verification-workflow.service.js';
import { DeathVerificationModule } from '../src/death-verification/death-verification.module.js';
import { EmailProvider } from '../src/email/email-provider.js';
import { MediaModule } from '../src/media/media.module.js';
import { MediaStorage } from '../src/media/storage/media-storage.service.js';
import { MessageReleaseService } from '../src/message-release/message-release.service.js';
import { MessageSchedulesModule } from '../src/message-schedules/message-schedules.module.js';
import { MessagesModule } from '../src/messages/messages.module.js';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { RecipientAuthModule } from '../src/recipient-auth/recipient-auth.module.js';
import { RecipientPortalModule } from '../src/recipient-portal/recipient-portal.module.js';
import { RecipientsModule } from '../src/recipients/recipients.module.js';
import { RedisModule } from '../src/redis/redis.module.js';
import { ReleaseNotificationQueue } from '../src/release-notifications/release-notification-queue.service.js';
import { TrustedContactAuthModule } from '../src/trusted-contact-auth/trusted-contact-auth.module.js';
import { TrustedContactPortalModule } from '../src/trusted-contact-portal/trusted-contact-portal.module.js';
import { TrustedContactsModule } from '../src/trusted-contacts/trusted-contacts.module.js';

// Step 24 end to end: real HTTP, PostgreSQL, Redis and the BullMQ workers
// (release, email, death verification). Only the email provider is a fake
// inbox; the OTP, release-notification and safety-notice code paths are the
// real ones. Fictional data only; test users are deleted afterwards.
describe('Email delivery (e2e, fake provider)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const inbox = new FakeEmailProvider();
  const run = Date.now();
  const at = (name: string) => `${name}.${run}@example.test`;
  const password = 'StrongPassword123!';
  const users = {
    lisa: at('em.lisa'),
    maya: at('em.maya'),
    noah: at('em.noah'),
    admin: at('em.admin'),
  };
  const SOFIA = at('em.sofia');
  const RAE = at('em.rae');
  const DAVID = at('em.david');
  const TESS = at('em.tess');
  const APP = 'http://app.test';
  const PRIVATE_TITLE = 'Fictional private title';
  const PRIVATE_TEXT = 'Fictional private text that must never be emailed.';

  type Agent = ReturnType<typeof request.agent>;
  const agents: Record<string, Agent> = {};
  const api = (path: string) => `/api/v1${path}`;
  const http = () => request(app.getHttpServer());
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const until = async (
    check: () => Promise<boolean> | boolean,
    ms = 20_000,
  ) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await check()) return;
      await sleep(150);
    }
    throw new Error('condition not met in time');
  };
  const signIn = async (email: string) => {
    const agent = request.agent(app.getHttpServer());
    await agent.post(api('/auth/login')).send({ email, password }).expect(200);
    return agent;
  };
  /** OTP sign-in reading the code from the fake inbox, as a person would. */
  const otpSignIn = async (
    base: 'recipient-auth' | 'trusted-contact-auth',
    email: string,
  ) => {
    const before = inbox.to(email).length;
    const { challengeId } = (
      await http()
        .post(api(`/${base}/request-otp`))
        .send({ email })
        .expect(202)
    ).body;
    await until(() => inbox.to(email).length === before + 1);
    const agent = request.agent(app.getHttpServer());
    await agent
      .post(api(`/${base}/verify-otp`))
      .send({ challengeId, code: inbox.code(email) })
      .expect(200);
    return agent;
  };
  const notificationFor = (messageId: string, email: string) =>
    prisma.releaseNotification.findFirst({
      where: { grant: { messageId, recipientEmailNormalized: email } },
    });
  const scheduleSoon = async (
    agent: Agent,
    recipientIds: string[],
    title = PRIVATE_TITLE,
  ) => {
    const id = (
      await agent
        .post(api('/messages'))
        .send({ title, textContent: PRIVATE_TEXT, recipientIds })
        .expect(201)
    ).body.id as string;
    await agent
      .post(api(`/messages/${id}/schedule`))
      .send({
        triggerType: 'FIXED_DATE',
        scheduledFor: new Date(Date.now() + 1500).toISOString(),
      })
      .expect(201);
    return id;
  };

  beforeAll(async () => {
    Object.assign(process.env, {
      RELEASE_QUEUE_NAME: `test-em-release-${run}`,
      RELEASE_RECONCILE_INTERVAL_SECONDS: '3600',
      DEATH_VERIFICATION_QUEUE_NAME: `test-em-dv-${run}`,
      DEATH_VERIFICATION_RECONCILE_INTERVAL_SECONDS: '3600',
      DEATH_VERIFICATION_SAFEGUARD_SECONDS: '3600',
      EMAIL_QUEUE_NAME: `test-em-email-${run}`,
      EMAIL_JOB_ATTEMPTS: '3',
      EMAIL_JOB_BACKOFF_MS: '100',
      APP_BASE_URL: APP,
      RECIPIENT_OTP_IP_REQUEST_LIMIT: '10000',
      RECIPIENT_OTP_VERIFY_IP_LIMIT: '10000',
      TRUSTED_CONTACT_OTP_IP_REQUEST_LIMIT: '10000',
      TRUSTED_CONTACT_OTP_VERIFY_IP_LIMIT: '10000',
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
        AdminModule,
      ],
    })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .overrideProvider(MediaStorage)
      .useValue({})
      // The only fake: every email the app sends lands in this inbox.
      .overrideProvider(EmailProvider)
      .useValue(inbox)
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app, new session.MemoryStore());
    await app.init();
    prisma = app.get(PrismaService);
    for (const [key, email] of Object.entries(users)) {
      await http()
        .post(api('/auth/register'))
        .send({ email, password, firstName: key, lastName: 'Test' })
        .expect(201);
    }
    await prisma.user.update({
      where: { email: users.admin },
      data: { role: 'ADMIN' },
    });
    for (const key of ['lisa', 'maya', 'noah'] as const)
      agents[key] = await signIn(users[key]);
    agents.admin = (await adminSignIn(app, users.admin, password)).agent;
  });

  afterAll(async () => {
    await prisma?.user.deleteMany({
      where: { email: { in: Object.values(users) } },
    });
    await app
      ?.get(ReleaseNotificationQueue)
      .queue.obliterate({ force: true })
      .catch(() => undefined);
    await app?.close();
  });

  describe('released message → one minimal email → Recipient signs in by emailed code', () => {
    let messageId: string;
    let mobileOnlyId: string;

    it('release creates one notification per grant with an email, and sends it once', async () => {
      const sofia = (
        await agents.lisa
          .post(api('/recipients'))
          .send({ firstName: 'Sofia', email: SOFIA })
          .expect(201)
      ).body.id;
      mobileOnlyId = (
        await agents.lisa
          .post(api('/recipients'))
          .send({ firstName: 'Mo', mobile: '+61400000000' })
          .expect(201)
      ).body.id;
      messageId = await scheduleSoon(agents.lisa, [sofia, mobileOnlyId]);
      // Nothing is sent while the message is only SCHEDULED.
      expect(inbox.to(SOFIA)).toHaveLength(0);

      await until(
        async () =>
          (await notificationFor(messageId, SOFIA))?.status === 'SENT',
      );
      const msg = await prisma.message.findUniqueOrThrow({
        where: { id: messageId },
        include: { release: true },
      });
      expect(msg.status).toBe('RELEASED');
      const grants = await prisma.recipientMessageAccessGrant.findMany({
        where: { messageId },
        include: { notification: true },
      });
      expect(grants).toHaveLength(2);
      // The mobile-only Recipient has a grant but no email to send.
      expect(
        grants.find((g) => g.recipientId === mobileOnlyId)?.notification,
      ).toBeNull();

      const [email] = inbox.to(SOFIA, 'message-released');
      expect(inbox.to(SOFIA)).toHaveLength(1);
      expect(email.subject).toBe('A message is waiting for you');
      expect(email.text).toContain(`${APP}/recipient/sign-in`);
      // Never the content, title, sender or a signed link.
      for (const part of [email.html, email.text, email.subject]) {
        expect(part).not.toContain(PRIVATE_TITLE);
        expect(part).not.toContain(PRIVATE_TEXT);
        expect(part).not.toMatch(/lisa|X-Amz|signature=/i);
      }
      const row = await notificationFor(messageId, SOFIA);
      expect(row).toMatchObject({
        attemptCount: 1,
        providerMessageId: expect.stringMatching(/^fake-/),
        lastErrorCode: null,
      });
    });

    it('releasing, enqueueing and reconciling again sends nothing new (one logical email)', async () => {
      expect(await app.get(MessageReleaseService).release(messageId)).toEqual({
        result: 'already_released',
      });
      const notifications = app.get(ReleaseNotificationQueue);
      await notifications.enqueueForMessage(messageId);
      // As if two minutes had passed: the reconciler sees no PENDING row.
      expect(
        await notifications.enqueueStale(new Date(Date.now() + 5 * 60_000)),
      ).toBe(0);
      await sleep(800);
      expect(inbox.to(SOFIA, 'message-released')).toHaveLength(1);
      expect(
        await prisma.releaseNotification.count({
          where: { grant: { messageId } },
        }),
      ).toBe(1);
    });

    it('the Recipient signs in with the emailed code (one email per request) and reads the message', async () => {
      const sofia = await otpSignIn('recipient-auth', SOFIA);
      expect(inbox.to(SOFIA, 'recipient-otp')).toHaveLength(1);
      expect(inbox.to(SOFIA, 'recipient-otp')[0].subject).toBe(
        'Your For After sign-in code',
      );
      const list = await sofia.get(api('/recipient/messages')).expect(200);
      expect(JSON.stringify(list.body)).toContain(messageId);
      // A used code cannot be replayed.
      const { challengeId } = (
        await http()
          .post(api('/recipient-auth/request-otp'))
          .send({ email: SOFIA })
          .expect(202)
      ).body;
      await until(() => inbox.to(SOFIA, 'recipient-otp').length === 2);
      const code = inbox.code(SOFIA)!;
      await http()
        .post(api('/recipient-auth/verify-otp'))
        .send({ challengeId, code })
        .expect(200);
      await http()
        .post(api('/recipient-auth/verify-otp'))
        .send({ challengeId, code })
        .expect(401);
    });

    it('an address with no released content gets the same answer and no email (no enumeration)', async () => {
      const nobody = at('em.nobody');
      const res = await http()
        .post(api('/recipient-auth/request-otp'))
        .send({ email: nobody })
        .expect(202);
      const known = await http()
        .post(api('/recipient-auth/request-otp'))
        .send({ email: SOFIA })
        .expect(202);
      expect(res.body.message).toBe(known.body.message);
      await sleep(500);
      expect(inbox.to(nobody)).toHaveLength(0);
    });
  });

  describe('provider outage: the release stands, the email fails visibly, an admin retry sends it', () => {
    let messageId: string;
    let jobId: string;

    it('retries with backoff, then FAILED; the message stays RELEASED and readable', async () => {
      const rae = (
        await agents.lisa
          .post(api('/recipients'))
          .send({ firstName: 'Rae', email: RAE })
          .expect(201)
      ).body.id;
      inbox.failNext(3); // EMAIL_JOB_ATTEMPTS
      messageId = await scheduleSoon(
        agents.lisa,
        [rae],
        'Second fictional message',
      );
      await until(
        async () =>
          (await notificationFor(messageId, RAE))?.status === 'FAILED',
      );
      const row = (await notificationFor(messageId, RAE))!;
      expect(row).toMatchObject({
        attemptCount: 3,
        lastErrorCode: 'rate_limit_exceeded',
        sentAt: null,
      });
      expect(
        (await prisma.message.findUniqueOrThrow({ where: { id: messageId } }))
          .status,
      ).toBe('RELEASED');
      expect(inbox.to(RAE, 'message-released')).toHaveLength(0);
      // The Recipient can still sign in and read it.
      const reader = await otpSignIn('recipient-auth', RAE);
      expect(
        JSON.stringify(
          (await reader.get(api('/recipient/messages')).expect(200)).body,
        ),
      ).toContain(messageId);
      jobId = `release-notification-${row.id}`;
    });

    it('admins see it as a failed job with ids and a safe reason only, and can retry it', async () => {
      const failed = await agents.admin
        .get(api('/admin/system/queues/email-delivery/failed'))
        .expect(200);
      const job = failed.body.items.find(
        (j: { jobId: string }) => j.jobId === jobId,
      );
      expect(job).toMatchObject({
        queue: 'email-delivery',
        attemptsMade: 3,
        failedReasonSanitized: 'email_send_failed: rate_limit_exceeded',
        payload: { notificationId: jobId.replace('release-notification-', '') },
      });
      expect(JSON.stringify(failed.body)).not.toMatch(
        /@example\.test|Second fictional|<html/,
      );
      // Not an admin route for a Customer (separate cookies).
      await agents.lisa
        .post(api(`/admin/system/queues/email-delivery/jobs/${jobId}/retry`))
        .expect(401);

      await agents.admin
        .post(api(`/admin/system/queues/email-delivery/jobs/${jobId}/retry`))
        .expect(200);
      await until(
        async () => (await notificationFor(messageId, RAE))?.status === 'SENT',
      );
      expect(inbox.to(RAE, 'message-released')).toHaveLength(1);
      // Retry means "run the job again", never a second email.
      await agents.admin
        .post(api(`/admin/system/queues/email-delivery/jobs/${jobId}/retry`))
        .expect(409);
    });
  });

  describe('trusted contact sign-in and the account-holder safety email', () => {
    it('a Trusted Contact signs in with the emailed code (exactly one email)', async () => {
      await agents.maya
        .post(api('/trusted-contacts'))
        .send({ firstName: 'David', email: DAVID })
        .expect(201);
      agents.david = await otpSignIn('trusted-contact-auth', DAVID);
      expect(inbox.to(DAVID)).toEqual([
        expect.objectContaining({
          kind: 'trusted-contact-otp',
          subject: 'Your For After sign-in code',
        }),
      ]);
      const accounts = await agents.david
        .get(api('/trusted-contact/accounts'))
        .expect(200);
      expect(accounts.body).toHaveLength(1);
    });

    it('a death report emails the account holder once, then the safeguard starts', async () => {
      const [account] = (
        await agents.david.get(api('/trusted-contact/accounts')).expect(200)
      ).body;
      await agents.david
        .post(
          api(
            `/trusted-contact/accounts/${account.trustedContactId}/death-reports`,
          ),
        )
        .send({
          confirmReport: true,
          reportedDateOfDeath: '2026-09-01',
          note: 'Fictional note from David',
        })
        .expect(201);
      await until(() => inbox.to(users.maya, 'death-safety').length === 1);
      const kase = await prisma.deathVerificationCase.findFirstOrThrow({
        where: { owner: { email: users.maya } },
      });
      expect(kase.status).toBe('SAFEGUARD_ACTIVE');
      const [email] = inbox.to(users.maya, 'death-safety');
      expect(email).toMatchObject({
        subject: 'Action needed on your For After account',
        idempotencyKey: `death-safety/${kase.id}`,
      });
      expect(email.text).toContain(`${APP}/login`);
      // No reporter, no note, no confirm link.
      expect(`${email.html}${email.text}`).not.toMatch(
        /David|Fictional note|confirm-alive/,
      );
      // The account holder confirms inside the app, signed in.
      await agents.maya
        .post(api('/death-verification/me/confirm-alive'))
        .send({ confirmAlive: true })
        .expect(200);
      expect(inbox.to(users.maya, 'death-safety')).toHaveLength(1);
    });

    it('a notice that could not be sent is never sent after the Customer confirmed alive (race)', async () => {
      await agents.noah
        .post(api('/trusted-contacts'))
        .send({ firstName: 'Tess', email: TESS })
        .expect(201);
      const tess = await otpSignIn('trusted-contact-auth', TESS);
      const [account] = (
        await tess.get(api('/trusted-contact/accounts')).expect(200)
      ).body;
      inbox.failNext(1); // the first notice attempt fails: case stays PENDING_VERIFICATION
      await tess
        .post(
          api(
            `/trusted-contact/accounts/${account.trustedContactId}/death-reports`,
          ),
        )
        .send({ confirmReport: true })
        .expect(201);
      const kase = await prisma.deathVerificationCase.findFirstOrThrow({
        where: { owner: { email: users.noah } },
      });
      await until(
        async () =>
          (
            await prisma.deathVerificationCase.findUniqueOrThrow({
              where: { id: kase.id },
            })
          ).safetyNoticeAttemptCount === 1,
      );
      expect(inbox.to(users.noah)).toHaveLength(0);

      await agents.noah
        .post(api('/death-verification/me/confirm-alive'))
        .send({ confirmAlive: true })
        .expect(200);
      // The reconciler's next attempt finds the case CANCELLED and sends nothing.
      const outcome = await app
        .get(DeathVerificationWorkflow)
        .startSafeguard(kase.id, new Date(Date.now() + 3_600_000));
      expect(outcome).toEqual({ result: 'skipped' });
      expect(inbox.to(users.noah)).toHaveLength(0);
      expect(
        (
          await prisma.deathVerificationCase.findUniqueOrThrow({
            where: { id: kase.id },
          })
        ).status,
      ).toBe('CANCELLED');
    });
  });
});
