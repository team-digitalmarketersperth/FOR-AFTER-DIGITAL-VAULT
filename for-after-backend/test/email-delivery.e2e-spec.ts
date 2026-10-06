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
import { MessageReleaseReconciler } from '../src/message-release/message-release-reconciler.service.js';
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
    ivy: at('em.ivy'),
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
    for (const key of ['lisa', 'maya', 'noah', 'ivy'] as const)
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
      // Phase 10: adding the contact also emailed the invitation.
      expect(inbox.to(DAVID).map((m) => m.kind)).toEqual([
        'trusted-contact-invitation',
        'trusted-contact-otp',
      ]);
      expect(inbox.to(DAVID, 'trusted-contact-otp')).toEqual([
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
      expect(inbox.to(users.noah, 'death-safety')).toHaveLength(0);

      await agents.noah
        .post(api('/death-verification/me/confirm-alive'))
        .send({ confirmAlive: true })
        .expect(200);
      // The reconciler's next attempt finds the case CANCELLED and sends nothing.
      const outcome = await app
        .get(DeathVerificationWorkflow)
        .startSafeguard(kase.id, new Date(Date.now() + 3_600_000));
      expect(outcome).toEqual({ result: 'skipped' });
      expect(inbox.to(users.noah, 'death-safety')).toHaveLength(0);
      expect(
        (
          await prisma.deathVerificationCase.findUniqueOrThrow({
            where: { id: kase.id },
          })
        ).status,
      ).toBe('CANCELLED');
    });
  });
  // Step 24.1: every assigned Recipient is told once, and only after release.
  describe('recipient release notifications (Step 24.1)', () => {
    const AVA = at('em.ava');
    const BEN = at('em.ben');
    const CAL = at('em.cal');
    const KIT = at('em.kit');
    const JUNO = at('em.juno');
    const NOTE = 'Fictional private note about Ava';
    const released = (email: string) => inbox.to(email, 'message-released');
    const newRecipient = async (agent: Agent, body: object) =>
      (await agent.post(api('/recipients')).send(body).expect(201)).body
        .id as string;
    const notificationRows = (messageId: string) =>
      prisma.releaseNotification.findMany({
        where: { grant: { messageId } },
        include: { grant: true },
      });
    let ava: string, ben: string, cal: string, dot: string;
    let multiId: string;

    it('DRAFT, SCHEDULED and unscheduled messages send nothing', async () => {
      ava = await newRecipient(agents.lisa, {
        firstName: 'Ava',
        lastName: 'Fictional-Surname',
        email: AVA,
        privateNote: NOTE,
      });
      const draft = (
        await agents.lisa
          .post(api('/messages'))
          .send({
            title: 'Draft only',
            textContent: PRIVATE_TEXT,
            recipientIds: [ava],
          })
          .expect(201)
      ).body.id as string;
      const later = await scheduleSoon(agents.lisa, [ava], 'Scheduled later');
      await agents.lisa
        .patch(api(`/messages/${later}/schedule`))
        .send({
          triggerType: 'FIXED_DATE',
          scheduledFor: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        })
        .expect(200);
      // Scheduled to release in 1.5 s, then unscheduled before it can.
      const unscheduled = await scheduleSoon(agents.lisa, [ava], 'Unscheduled');
      await agents.lisa
        .delete(api(`/messages/${unscheduled}/schedule`))
        .expect(204);
      await sleep(2500);
      const statuses = await prisma.message.findMany({
        where: { id: { in: [draft, later, unscheduled] } },
        select: { status: true },
      });
      expect(statuses.map((m) => m.status).sort()).toEqual([
        'DRAFT',
        'DRAFT',
        'SCHEDULED',
      ]);
      expect(
        await prisma.releaseNotification.count({
          where: { grant: { messageId: { in: [draft, later, unscheduled] } } },
        }),
      ).toBe(0);
      expect(inbox.to(AVA)).toHaveLength(0);
    });

    it('three Recipients with email get one email each; one without email blocks nothing; one outage stays isolated', async () => {
      ben = await newRecipient(agents.lisa, { firstName: 'Ben', email: BEN });
      cal = await newRecipient(agents.lisa, { firstName: 'Cal', email: CAL });
      dot = await newRecipient(agents.lisa, {
        firstName: 'Dot',
        mobile: '+61400000001',
      });
      // Ben's first attempt fails transiently; Ava's and Cal's must not wait on it.
      inbox.failNextFor(BEN, 1);
      multiId = await scheduleSoon(
        agents.lisa,
        [ava, ben, cal, dot],
        'To four',
      );
      await until(async () => {
        const rows = await notificationRows(multiId);
        return rows.length === 3 && rows.every((n) => n.status === 'SENT');
      });
      const msg = await prisma.message.findUniqueOrThrow({
        where: { id: multiId },
        include: {
          release: true,
          accessGrants: { include: { notification: true } },
        },
      });
      expect(msg.status).toBe('RELEASED');
      expect(msg.release).not.toBeNull();
      expect(msg.accessGrants).toHaveLength(4);
      const byRecipient = Object.fromEntries(
        msg.accessGrants.map((g) => [g.recipientId, g.notification]),
      );
      expect(byRecipient[dot]).toBeNull(); // no address: no row, no attempt
      expect(byRecipient[ava]).toMatchObject({
        status: 'SENT',
        attemptCount: 1,
      });
      expect(byRecipient[cal]).toMatchObject({
        status: 'SENT',
        attemptCount: 1,
      });
      // Retried with BullMQ backoff, then sent once.
      expect(byRecipient[ben]).toMatchObject({
        status: 'SENT',
        attemptCount: 2,
        lastErrorCode: null,
      });
      for (const [email, name, id] of [
        [AVA, 'Ava', ava],
        [BEN, 'Ben', ben],
        [CAL, 'Cal', cal],
      ]) {
        const mails = released(email);
        expect(mails).toHaveLength(1);
        expect(mails[0].text).toContain(`Hi ${name},`);
        expect(mails[0].idempotencyKey).toBe(
          `release-notification/${byRecipient[id]!.id}`,
        );
      }
    });

    it('privacy: no content, title, note, surname, sender, media or token in the email', () => {
      const [email] = released(AVA);
      for (const part of [email.subject, email.html, email.text]) {
        expect(part).not.toContain('To four');
        expect(part).not.toContain(PRIVATE_TEXT);
        expect(part).not.toContain(NOTE);
        expect(part).not.toContain('Fictional-Surname');
        expect(part).not.toMatch(
          /lisa|X-Amz|signature=|storageKey|token|code=/i,
        );
      }
      // The only link is the plain sign-in page.
      expect(email.html.match(/href="[^"]*"/g)).toEqual([
        `href="${APP}/recipient/sign-in"`,
      ]);
    });

    it('re-running release, both reconcilers and the enqueue sends nothing new', async () => {
      expect(await app.get(MessageReleaseService).release(multiId)).toEqual({
        result: 'already_released',
      });
      await app.get(MessageReleaseReconciler).reconcile();
      const notifications = app.get(ReleaseNotificationQueue);
      await notifications.enqueueForMessage(multiId);
      expect(
        await notifications.enqueueStale(new Date(Date.now() + 5 * 60_000)),
      ).toBe(0);
      await sleep(800);
      expect(
        await prisma.messageRelease.count({ where: { messageId: multiId } }),
      ).toBe(1);
      expect(
        await prisma.recipientMessageAccessGrant.count({
          where: { messageId: multiId },
        }),
      ).toBe(4);
      expect(await notificationRows(multiId)).toHaveLength(3);
      for (const email of [AVA, BEN, CAL])
        expect(released(email)).toHaveLength(1);
    });

    it('a second message to the same Recipient is its own notification', async () => {
      const second = await scheduleSoon(agents.lisa, [ava], 'Second to Ava');
      await until(
        async () => (await notificationRows(second))[0]?.status === 'SENT',
      );
      expect(released(AVA)).toHaveLength(2);
      expect(released(BEN)).toHaveLength(1);
    });

    it('the email is not a sign-in: the Recipient still needs an OTP, then sees only their own messages', async () => {
      // Following the email link without a session opens nothing.
      await http().get(api('/recipient/messages')).expect(401);
      const onlyCal = await scheduleSoon(agents.lisa, [cal], 'Only for Cal');
      await until(
        async () => (await notificationRows(onlyCal))[0]?.status === 'SENT',
      );
      const reader = await otpSignIn('recipient-auth', BEN);
      const list = JSON.stringify(
        (await reader.get(api('/recipient/messages')).expect(200)).body,
      );
      expect(list).toContain(multiId);
      expect(list).not.toContain(onlyCal);
      await reader.get(api(`/recipient/messages/${onlyCal}`)).expect(404);
      await reader.get(api(`/recipient/messages/${multiId}`)).expect(200);
    });

    it('death triggers: nothing at report or safeguard; ON_DEATH at verification; AFTER_DEATH only when it releases', async () => {
      await agents.ivy
        .post(api('/trusted-contacts'))
        .send({ firstName: 'Juno', email: JUNO })
        .expect(201);
      const kit = await newRecipient(agents.ivy, {
        firstName: 'Kit',
        email: KIT,
      });
      const create = async (title: string, schedule: object) => {
        const id = (
          await agents.ivy
            .post(api('/messages'))
            .send({ title, textContent: PRIVATE_TEXT, recipientIds: [kit] })
            .expect(201)
        ).body.id as string;
        await agents.ivy
          .post(api(`/messages/${id}/schedule`))
          .send(schedule)
          .expect(201);
        return id;
      };
      const onDeath = await create('Ivy on death', {
        triggerType: 'ON_DEATH',
      });
      const afterDeath = await create('Ivy after death', {
        triggerType: 'AFTER_DEATH',
        afterDeathDays: 1,
      });

      const juno = await otpSignIn('trusted-contact-auth', JUNO);
      const [account] = (
        await juno.get(api('/trusted-contact/accounts')).expect(200)
      ).body;
      await juno
        .post(
          api(
            `/trusted-contact/accounts/${account.trustedContactId}/death-reports`,
          ),
        )
        .send({ confirmReport: true })
        .expect(201);
      await until(() => inbox.to(users.ivy, 'death-safety').length === 1);
      const kase = await prisma.deathVerificationCase.findFirstOrThrow({
        where: { owner: { email: users.ivy } },
      });
      expect(kase.status).toBe('SAFEGUARD_ACTIVE');
      await sleep(300);
      expect(released(KIT)).toHaveLength(0);
      // The safeguard is an hour in this suite (other tests confirm alive
      // during it): end it now (test-only fixture), then elapse it for real.
      await prisma.deathVerificationCase.update({
        where: { id: kase.id },
        data: { safeguardEndsAt: new Date(Date.now() - 1000) },
      });
      expect(
        await app.get(DeathVerificationWorkflow).elapseSafeguard(kase.id),
      ).toEqual({ result: 'ready_for_review' });
      await sleep(300);
      expect(released(KIT)).toHaveLength(0);

      // Death one day ago minus 8 s: AFTER_DEATH (1 day) falls due 8 s later.
      await agents.admin
        .post(api(`/admin/death-verifications/${kase.id}/verify`))
        .send({
          verifiedDeathAt: new Date(
            Date.now() - 86_400_000 + 8000,
          ).toISOString(),
          confirmVerification: true,
          decisionNote: 'Fictional Step 24.1 verification test.',
        })
        .expect(200);
      await until(
        async () => (await notificationRows(onDeath))[0]?.status === 'SENT',
      );
      expect(released(KIT)).toHaveLength(1);
      const pending = await prisma.message.findUniqueOrThrow({
        where: { id: afterDeath },
        include: { deathActivation: true },
      });
      expect(pending.status).toBe('SCHEDULED');
      expect(await notificationRows(afterDeath)).toHaveLength(0);

      await until(
        async () => (await notificationRows(afterDeath))[0]?.status === 'SENT',
        25_000,
      );
      const [row] = await notificationRows(afterDeath);
      expect(row.sentAt!.getTime()).toBeGreaterThanOrEqual(
        pending.deathActivation!.dueAt.getTime(),
      );
      expect(released(KIT)).toHaveLength(2);
      expect(released(KIT)[1].text).toContain('Hi Kit,');
      const reader = await otpSignIn('recipient-auth', KIT);
      const list = JSON.stringify(
        (await reader.get(api('/recipient/messages')).expect(200)).body,
      );
      expect(list).toContain(onDeath);
      expect(list).toContain(afterDeath);
    }, 45_000);
  });
});
