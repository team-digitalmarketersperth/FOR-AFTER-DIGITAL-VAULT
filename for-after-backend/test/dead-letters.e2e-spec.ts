import { randomUUID } from 'node:crypto';
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
import {
  DeathVerificationQueue,
  safeguardJobId,
} from '../src/death-verification/death-verification-queue.service.js';
import { DeathVerificationWorkflow } from '../src/death-verification/death-verification-workflow.service.js';
import { DeathVerificationModule } from '../src/death-verification/death-verification.module.js';
import { EmailProvider } from '../src/email/email-provider.js';
import { MediaModule } from '../src/media/media.module.js';
import { MediaStorage } from '../src/media/storage/media-storage.service.js';
import { MessageReleaseQueue } from '../src/message-release/message-release-queue.service.js';
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
import { TrustedContactsModule } from '../src/trusted-contacts/trusted-contacts.module.js';
import { QueueWorkersModule } from '../src/worker.module.js';

// Phase 17A end to end: real HTTP, PostgreSQL, Redis and the three BullMQ
// workers. Failures are synthetic (a spied service method or the fake email
// provider); dead letters, alerts, admin retry and the worker re-checks are
// the real code paths. Fictional data only; own queues; cleaned up afterwards.
describe('Dead letters + operational alerts (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const inbox = new FakeEmailProvider();
  const run = Date.now();
  const at = (name: string) => `${name}.${run}@example.test`;
  const password = 'StrongPassword123!';
  const users = {
    lisa: at('dl.lisa'),
    admin: at('dl.admin'),
    root: at('dl.root'),
  };
  const OPS = at('dl.ops');
  const SOFIA = at('dl.sofia');
  const DAVID = at('dl.david');
  const PRIVATE_TEXT = 'Fictional private text that must never leave the vault.';
  const NOTE = 'Fictional private death report note';

  type Agent = ReturnType<typeof request.agent>;
  const agents: Record<string, Agent> = {};
  const api = (path: string) => `/api/v1${path}`;
  const http = () => request(app.getHttpServer());
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const until = async (check: () => Promise<boolean> | boolean, ms = 20_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await check()) return;
      await sleep(100);
    }
    throw new Error('condition not met in time');
  };
  const deadLetter = (queueName: string, jobId: string) =>
    prisma.deadLetterJob.findUnique({
      where: { queueName_jobId: { queueName, jobId } },
    });
  const scheduleSoon = async (recipientIds: string[]) => {
    const id = (
      await agents.lisa
        .post(api('/messages'))
        .send({ title: 'Fictional', textContent: PRIVATE_TEXT, recipientIds })
        .expect(201)
    ).body.id as string;
    await agents.lisa
      .post(api(`/messages/${id}/schedule`))
      .send({
        triggerType: 'FIXED_DATE',
        scheduledFor: new Date(Date.now() + 800).toISOString(),
      })
      .expect(201);
    return id;
  };
  const otpSignIn = async (
    base: 'recipient-auth' | 'trusted-contact-auth',
    email: string,
  ) => {
    const before = inbox.to(email).length;
    const { challengeId } = (
      await http().post(api(`/${base}/request-otp`)).send({ email }).expect(202)
    ).body;
    await until(() => inbox.to(email).length === before + 1);
    const agent = request.agent(app.getHttpServer());
    await agent
      .post(api(`/${base}/verify-otp`))
      .send({ challengeId, code: inbox.code(email) })
      .expect(200);
    return agent;
  };

  beforeAll(async () => {
    Object.assign(process.env, {
      RELEASE_QUEUE_NAME: `test-dl-release-${run}`,
      RELEASE_RECONCILE_INTERVAL_SECONDS: '3600',
      RELEASE_JOB_ATTEMPTS: '2',
      RELEASE_JOB_BACKOFF_MS: '50',
      DEATH_VERIFICATION_QUEUE_NAME: `test-dl-dv-${run}`,
      DEATH_VERIFICATION_RECONCILE_INTERVAL_SECONDS: '3600',
      DEATH_VERIFICATION_JOB_ATTEMPTS: '2',
      DEATH_VERIFICATION_JOB_BACKOFF_MS: '50',
      EMAIL_QUEUE_NAME: `test-dl-email-${run}`,
      EMAIL_JOB_ATTEMPTS: '2',
      EMAIL_JOB_BACKOFF_MS: '50',
      OPS_ALERT_EMAIL: OPS,
      APP_BASE_URL: 'http://app.test',
      RECIPIENT_OTP_IP_REQUEST_LIMIT: '10000',
      RECIPIENT_OTP_VERIFY_IP_LIMIT: '10000',
      TRUSTED_CONTACT_OTP_IP_REQUEST_LIMIT: '10000',
      TRUSTED_CONTACT_OTP_VERIFY_IP_LIMIT: '10000',
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
        MediaModule,
        RecipientAuthModule,
        RecipientPortalModule,
        TrustedContactAuthModule,
        DeathVerificationModule,
        AdminModule,
      ],
    })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .overrideProvider(MediaStorage)
      .useValue({})
      // The only fake: release emails, OTPs and ops alerts land here.
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
    await prisma.user.update({
      where: { email: users.root },
      data: { role: 'SUPER_ADMIN' },
    });
    agents.lisa = request.agent(app.getHttpServer());
    await agents.lisa
      .post(api('/auth/login'))
      .send({ email: users.lisa, password })
      .expect(200);
    agents.admin = (await adminSignIn(app, users.admin, password)).agent;
    agents.root = (await adminSignIn(app, users.root, password)).agent;
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    delete process.env.OPS_ALERT_EMAIL;
    const lisa = await prisma?.user.findUnique({ where: { email: users.lisa } });
    await prisma?.deadLetterJob.deleteMany({
      where: { createdAt: { gte: new Date(run) } },
    });
    await prisma?.user.deleteMany({
      where: { email: { in: Object.values(users) } },
    });
    if (lisa) await prisma?.deathVerificationCase.deleteMany({ where: { ownerUserId: lisa.id } });
    for (const q of [
      app?.get(MessageReleaseQueue).queue,
      app?.get(DeathVerificationQueue).queue,
      app?.get(ReleaseNotificationQueue).queue,
    ])
      await q?.obliterate({ force: true }).catch(() => undefined);
    await app?.close();
  });

  describe('message-release', () => {
    let messageId: string;
    let sofiaId: string;
    const jobId = () => `message-release-${messageId}`;

    it('retries first, then exactly one sanitized dead letter + one alert; nothing released', async () => {
      sofiaId = (
        await agents.lisa
          .post(api('/recipients'))
          .send({ firstName: 'Sofia', email: SOFIA })
          .expect(201)
      ).body.id;
      const releases = app.get(MessageReleaseService);
      const spy = vi
        .spyOn(releases, 'release')
        .mockRejectedValue(
          Object.assign(
            new Error('connect ECONNREFUSED postgresql://app:hunter2@db:5432'),
            { code: 'ECONNREFUSED' },
          ),
        );
      messageId = await scheduleSoon([sofiaId]);
      await until(async () => (await deadLetter('message-release', jobId())) !== null);
      expect(spy).toHaveBeenCalledTimes(2); // RELEASE_JOB_ATTEMPTS: 1 retry, then terminal
      spy.mockRestore();
      await until(
        async () =>
          (await deadLetter('message-release', jobId()))?.alertStatus === 'SENT',
      );
      const row = (await deadLetter('message-release', jobId()))!;
      expect(row).toMatchObject({
        jobName: 'release',
        entityType: 'Message',
        entityId: messageId,
        attemptsMade: 2,
        errorCode: 'ECONNREFUSED',
        errorMessage: 'connect ECONNREFUSED [url]',
        status: 'OPEN',
        failureCount: 1,
      });
      expect(JSON.stringify(row)).not.toMatch(/hunter2|Fictional|@example/);
      const alerts = inbox.to(OPS, 'ops-alert');
      expect(alerts).toHaveLength(1);
      expect(alerts[0].text).toContain(`Entity: Message ${messageId}`);
      expect(alerts[0].text + alerts[0].html).not.toMatch(
        /Fictional|hunter2|example\.test/,
      );
      expect(
        (await prisma.message.findUniqueOrThrow({ where: { id: messageId } }))
          .status,
      ).toBe('SCHEDULED');
    });

    it('a repeated terminal callback for the same failure changes nothing', async () => {
      const job = await app.get(MessageReleaseQueue).queue.getJob(jobId());
      const { DeadLetterService } = await import(
        '../src/dead-letters/dead-letter.service.js'
      );
      const service = app.get(DeadLetterService);
      const err = new Error('again');
      const results = await Promise.all([
        service.record('message-release', job!, err),
        service.record('message-release', job!, err),
      ]);
      expect(results).toEqual([null, null]);
      expect(
        await prisma.deadLetterJob.count({
          where: { queueName: 'message-release', jobId: jobId() },
        }),
      ).toBe(1);
      expect((await deadLetter('message-release', jobId()))!.failureCount).toBe(1);
      expect(inbox.to(OPS, 'ops-alert')).toHaveLength(1);
    });

    it('admins list and view it (ids and safe fields only)', async () => {
      const list = await agents.admin
        .get(api('/admin/system/dead-letters'))
        .query({ queue: 'message-release', status: 'OPEN' })
        .expect(200);
      const item = list.body.items.find(
        (d: { jobId: string }) => d.jobId === jobId(),
      );
      expect(item).toMatchObject({ entityId: messageId, alertStatus: 'SENT' });
      expect(list.body.pagination).toMatchObject({ page: 1, limit: 25 });
      expect(JSON.stringify(list.body)).not.toMatch(/hunter2|Fictional|example\.test/);
      await agents.root
        .get(api(`/admin/system/dead-letters/${item.id}`))
        .expect(200);
      await agents.admin
        .get(api('/admin/system/dead-letters'))
        .query({ queue: 'bull:anything' })
        .expect(400);
      await agents.admin
        .get(api(`/admin/system/dead-letters/${randomUUID()}`))
        .expect(404);
    });

    it('admin retry → the worker re-checks PostgreSQL and releases once; a second retry is 409', async () => {
      const row = (await deadLetter('message-release', jobId()))!;
      const [a, b] = await Promise.all([
        agents.admin.post(api(`/admin/system/dead-letters/${row.id}/retry`)),
        agents.root.post(api(`/admin/system/dead-letters/${row.id}/retry`)),
      ]);
      expect([a.status, b.status].sort((x, y) => x - y)).toEqual([200, 409]);
      await until(
        async () =>
          (await deadLetter('message-release', jobId()))?.status === 'RESOLVED',
      );
      expect(await deadLetter('message-release', jobId())).toMatchObject({
        resolution: 'released',
      });
      expect(
        await prisma.messageRelease.count({ where: { messageId } }),
      ).toBe(1);
      await agents.admin
        .post(api(`/admin/system/dead-letters/${row.id}/retry`))
        .expect(409);
      const audit = await prisma.auditLog.findMany({
        where: { eventType: 'DEAD_LETTER_RETRY_REQUESTED', subjectId: row.id },
      });
      expect(audit).toHaveLength(1);
      expect(audit[0].metadata).toEqual({
        queue: 'message-release',
        jobId: jobId(),
        outcome: 'requeued',
      });
    });

    it('a stale Message (unscheduled meanwhile) is a safe no-op on retry', async () => {
      const spy = vi
        .spyOn(app.get(MessageReleaseService), 'release')
        .mockRejectedValue(new Error('synthetic'));
      const id = await scheduleSoon([sofiaId]);
      await until(async () => (await deadLetter('message-release', `message-release-${id}`)) !== null);
      spy.mockRestore();
      await agents.lisa.delete(api(`/messages/${id}/schedule`)).expect(204);
      const row = (await deadLetter('message-release', `message-release-${id}`))!;
      await agents.admin
        .post(api(`/admin/system/dead-letters/${row.id}/retry`))
        .expect(200);
      await until(
        async () => (await deadLetter('message-release', row.jobId))?.status === 'RESOLVED',
      );
      expect((await deadLetter('message-release', row.jobId))!.resolution).toBe('stale');
      expect(await prisma.messageRelease.count({ where: { messageId: id } })).toBe(0);
      expect(
        (await prisma.message.findUniqueOrThrow({ where: { id } })).status,
      ).toBe('DRAFT');
    });
  });

  describe('death-verification', () => {
    it('a terminal case keeps its state; the note never reaches the dead letter', async () => {
      const lisa = await prisma.user.findUniqueOrThrow({ where: { email: users.lisa } });
      const kase = await prisma.deathVerificationCase.create({
        data: { ownerUserId: lisa.id, status: 'CANCELLED', resolvedAt: new Date() },
      });
      const workflow = app.get(DeathVerificationWorkflow);
      const spy = vi
        .spyOn(workflow, 'elapseSafeguard')
        .mockRejectedValue(new Error('synthetic'));
      const queue = app.get(DeathVerificationQueue).queue;
      const id = safeguardJobId(kase.id);
      // A synthetic job with an extra field: only ids may ever be copied.
      await queue.add(
        'safeguard',
        { caseId: kase.id, note: NOTE } as never,
        { jobId: id, attempts: 2, backoff: { type: 'fixed', delay: 50 } },
      );
      await until(async () => (await deadLetter('death-verification', id)) !== null);
      expect(spy).toHaveBeenCalledTimes(2);
      spy.mockRestore();
      const row = (await deadLetter('death-verification', id))!;
      expect(row).toMatchObject({
        entityType: 'DeathVerificationCase',
        entityId: kase.id,
        status: 'OPEN',
      });
      expect(JSON.stringify(row)).not.toContain(NOTE);
      await agents.admin
        .post(api(`/admin/system/dead-letters/${row.id}/retry`))
        .expect(200);
      await until(async () => (await deadLetter('death-verification', id))?.status === 'RESOLVED');
      expect((await deadLetter('death-verification', id))!.resolution).toBe('stale');
      expect(
        (await prisma.deathVerificationCase.findUniqueOrThrow({ where: { id: kase.id } })).status,
      ).toBe('CANCELLED');
      await agents.admin
        .post(api(`/admin/system/dead-letters/${row.id}/retry`))
        .expect(409);
    });
  });

  describe('email-delivery with the provider down (alert recursion)', () => {
    let notificationId: string;
    const jobId = () => `release-notification-${notificationId}`;

    it('provider down for everyone: one dead letter, its alert fails once, no loop', async () => {
      const rae = at('dl.rae');
      const recipientId = (
        await agents.lisa
          .post(api('/recipients'))
          .send({ firstName: 'Rae', email: rae })
          .expect(201)
      ).body.id;
      // 2 delivery attempts + 1 alert attempt, all failing; nothing else sends meanwhile.
      inbox.failNext(3, 'network_error', true);
      const messageId = await scheduleSoon([recipientId]);
      await until(async () => {
        const n = await prisma.releaseNotification.findFirst({
          where: { grant: { messageId } },
        });
        notificationId = n?.id ?? '';
        return n?.status === 'FAILED';
      });
      await until(
        async () =>
          (await deadLetter('email-delivery', jobId()))?.alertStatus === 'FAILED',
      );
      await sleep(500);
      expect(inbox.failures).toHaveLength(0);
      expect(
        await prisma.deadLetterJob.count({
          where: { queueName: 'email-delivery', createdAt: { gte: new Date(run) } },
        }),
      ).toBe(1);
      const counts = await app
        .get(ReleaseNotificationQueue)
        .queue.getJobCounts('waiting', 'delayed', 'active', 'failed');
      expect(counts).toMatchObject({ waiting: 0, delayed: 0, active: 0, failed: 1 });
      const row = (await deadLetter('email-delivery', jobId()))!;
      expect(row).toMatchObject({
        entityType: 'ReleaseNotification',
        entityId: notificationId,
        errorCode: 'network_error',
        alertedAt: null,
      });
      expect(JSON.stringify(row)).not.toMatch(/Fictional|example\.test|<html/);
      expect(inbox.to(rae)).toHaveLength(0);
    });

    it('admin retry reuses the notification row: sent once, then already_sent no-op', async () => {
      const row = (await deadLetter('email-delivery', jobId()))!;
      await agents.admin
        .post(api(`/admin/system/dead-letters/${row.id}/retry`))
        .expect(200);
      await until(async () => (await deadLetter('email-delivery', jobId()))?.status === 'RESOLVED');
      expect((await deadLetter('email-delivery', jobId()))!.resolution).toBe('sent');
      const sent = inbox.sent.filter(
        (m) => m.idempotencyKey === `release-notification/${notificationId}`,
      );
      expect(sent).toHaveLength(1);
      // Reopen synthetically and retry: the worker sees SENT and does nothing.
      await prisma.deadLetterJob.update({ where: { id: row.id }, data: { status: 'OPEN' } });
      await agents.admin
        .post(api(`/admin/system/dead-letters/${row.id}/retry`))
        .expect(200);
      await until(async () => (await deadLetter('email-delivery', jobId()))?.status === 'RESOLVED');
      expect((await deadLetter('email-delivery', jobId()))!.resolution).toBe('already_sent');
      expect(
        inbox.sent.filter((m) => m.idempotencyKey === `release-notification/${notificationId}`),
      ).toHaveLength(1);
    });
  });

  describe('access', () => {
    it('only admins: unauthenticated, Customer, Recipient and Trusted Contact are refused', async () => {
      const row = await prisma.deadLetterJob.findFirstOrThrow({
        where: { createdAt: { gte: new Date(run) } },
      });
      await agents.lisa
        .post(api('/trusted-contacts'))
        .send({ firstName: 'David', email: DAVID })
        .expect(201);
      const recipient = await otpSignIn('recipient-auth', SOFIA);
      const contact = await otpSignIn('trusted-contact-auth', DAVID);
      for (const agent of [
        request.agent(app.getHttpServer()),
        agents.lisa,
        recipient,
        contact,
      ]) {
        for (const res of [
          await agent.get(api('/admin/system/dead-letters')),
          await agent.get(api(`/admin/system/dead-letters/${row.id}`)),
          await agent.post(api(`/admin/system/dead-letters/${row.id}/retry`)),
        ]) {
          expect([401, 403]).toContain(res.status);
          expect(JSON.stringify(res.body)).not.toContain(row.jobId);
        }
      }
    });
  });
});
