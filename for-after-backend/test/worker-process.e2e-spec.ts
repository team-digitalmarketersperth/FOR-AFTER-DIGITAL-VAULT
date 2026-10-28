import type { INestApplicationContext } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import { Queue } from 'bullmq';
import session from 'express-session';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/config/app.setup.js';
import { EmailProvider } from '../src/email/email-provider.js';
import { MediaStorage } from '../src/media/storage/media-storage.service.js';
import { releaseJobId } from '../src/message-release/message-release-queue.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { WorkerModule } from '../src/worker.module.js';
import { FakeEmailProvider } from './fake-email.js';

// Phase 17B: the production composition roots, booted as they are in their own
// processes. AppModule (the API) only produces jobs; WorkerModule consumes
// them. Real PostgreSQL + local Redis on queues used only by this run.
describe('API and worker processes (e2e, Phase 17B)', () => {
  const run = Date.now();
  const names = {
    release: `test-p17b-release-${run}`,
    email: `test-p17b-email-${run}`,
    death: `test-p17b-death-${run}`,
  };
  const owner = `p17b.lisa.${run}@example.test`;
  const sofia = `p17b.sofia.${run}@example.test`;
  const password = 'StrongPassword123!';
  const inbox = new FakeEmailProvider();
  let api: NestExpressApplication | undefined;
  let worker: INestApplicationContext | undefined;
  let prisma: PrismaService;
  let releaseQueue: Queue;
  let emailQueue: Queue;
  let deathQueue: Queue;
  let messageId: string;

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const until = async (check: () => Promise<boolean>, ms = 20_000) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(200))
      if (await check()) return;
    throw new Error('Timed out waiting for the worker');
  };
  const consumers = async () =>
    (
      await Promise.all(
        [releaseQueue, emailQueue, deathQueue].map((q) => q.getWorkersCount()),
      )
    ).reduce((a, b) => a + b, 0);

  const startApi = async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .overrideProvider(MediaStorage)
      .useValue({})
      .overrideProvider(EmailProvider)
      .useValue(inbox)
      .compile();
    const app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app, new session.MemoryStore());
    await app.init();
    return app;
  };
  // What src/worker.ts boots: an application context, no HTTP server.
  const startWorker = async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [WorkerModule],
    })
      .overrideProvider(EmailProvider)
      .useValue(inbox)
      .compile();
    return moduleRef.init();
  };

  beforeAll(async () => {
    process.env.RELEASE_QUEUE_NAME = names.release;
    process.env.EMAIL_QUEUE_NAME = names.email;
    process.env.DEATH_VERIFICATION_QUEUE_NAME = names.death;
    const connection = { url: process.env.REDIS_URL! };
    releaseQueue = new Queue(names.release, { connection });
    emailQueue = new Queue(names.email, { connection });
    deathQueue = new Queue(names.death, { connection });
    api = await startApi();
    prisma = api.get(PrismaService);
  });

  afterAll(async () => {
    await worker?.close();
    await prisma?.user.deleteMany({ where: { email: owner } });
    await api?.close();
    for (const q of [releaseQueue, emailQueue, deathQueue]) {
      await q?.obliterate({ force: true }).catch(() => undefined);
      await q?.close();
    }
  });

  it('API only: the request succeeds and queues a job, but nothing is consumed or released', async () => {
    expect(await consumers()).toBe(0);
    const http = () => request(api!.getHttpServer());
    await http()
      .post('/api/v1/auth/register')
      .send({ email: owner, password, firstName: 'Lisa', lastName: 'Test' })
      .expect(201);
    const lisa = request.agent(api!.getHttpServer());
    await lisa
      .post('/api/v1/auth/login')
      .send({ email: owner, password })
      .expect(200);
    const recipientId = (
      await lisa
        .post('/api/v1/recipients')
        .send({ firstName: 'Sofia', email: sofia })
        .expect(201)
    ).body.id as string;
    messageId = (
      await lisa
        .post('/api/v1/messages')
        .send({
          title: 'Worker Split Test',
          contentType: 'TEXT',
          textContent: 'Fictional test message.',
          recipientIds: [recipientId],
        })
        .expect(201)
    ).body.id as string;
    await lisa
      .post(`/api/v1/messages/${messageId}/schedule`)
      .send({ triggerType: 'NOW' })
      .expect(201);

    const job = await releaseQueue.getJob(releaseJobId(messageId));
    expect(job?.data).toEqual({ messageId });
    await sleep(1500);
    expect(await job!.getState()).toBe('waiting');
    expect(await consumers()).toBe(0);
    expect(
      await prisma.message.findUniqueOrThrow({ where: { id: messageId } }),
    ).toMatchObject({ status: 'SCHEDULED' });
    expect(await prisma.messageRelease.count({ where: { messageId } })).toBe(0);
  });

  it('worker only: consumes the queued job, grants access and emails the Recipient', async () => {
    worker = await startWorker();
    expect(await consumers()).toBe(3);
    await until(
      async () =>
        (await prisma.releaseNotification.findFirst({
          where: { grant: { messageId } },
        }))?.status === 'SENT',
    );
    expect(
      await prisma.message.findUniqueOrThrow({ where: { id: messageId } }),
    ).toMatchObject({ status: 'RELEASED' });
    expect(await prisma.messageRelease.count({ where: { messageId } })).toBe(1);
    expect(
      await prisma.recipientMessageAccessGrant.count({ where: { messageId } }),
    ).toBe(1);
    expect(inbox.to(sofia, 'message-released')).toHaveLength(1);
  });

  it('worker restart: state persists and nothing happens twice', async () => {
    await worker!.close();
    worker = undefined;
    expect(await consumers()).toBe(0);
    worker = await startWorker();
    expect(await consumers()).toBe(3);
    // A duplicate job (retry after a crash) and a fresh reconcile pass.
    const dup = await releaseQueue.add('release', { messageId });
    await until(async () => (await dup.getState()) === 'completed');
    expect((await releaseQueue.getJob(dup.id!))?.returnvalue).toBe(
      'already_released',
    );
    expect(await prisma.messageRelease.count({ where: { messageId } })).toBe(1);
    expect(
      await prisma.recipientMessageAccessGrant.count({ where: { messageId } }),
    ).toBe(1);
    expect(
      await prisma.releaseNotification.count({
        where: { grant: { messageId } },
      }),
    ).toBe(1);
    expect(inbox.to(sofia, 'message-released')).toHaveLength(1);
  });

  it('API restart: the worker keeps consuming and the API adds no consumer', async () => {
    await api!.close();
    api = undefined;
    const dup = await releaseQueue.add('release', { messageId });
    await until(async () => (await dup.getState()) === 'completed');
    api = await startApi();
    prisma = api.get(PrismaService);
    expect(await consumers()).toBe(3);
  });
});
