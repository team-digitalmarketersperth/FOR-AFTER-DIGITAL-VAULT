import { ConfigModule } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';
import session from 'express-session';
import request from 'supertest';
import { AuthModule } from '../src/auth/auth.module.js';
import { configureApp } from '../src/config/app.setup.js';
import { MediaModule } from '../src/media/media.module.js';
import { MediaStorage } from '../src/media/storage/media-storage.service.js';
import { releaseJobId } from '../src/message-release/message-release-queue.service.js';
import { MessageReleaseReconciler } from '../src/message-release/message-release-reconciler.service.js';
import { MessageReleaseService } from '../src/message-release/message-release.service.js';
import { MessageSchedulesModule } from '../src/message-schedules/message-schedules.module.js';
import { MessagesModule } from '../src/messages/messages.module.js';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { RecipientsModule } from '../src/recipients/recipients.module.js';

// Real HTTP, sessions (MemoryStore), PostgreSQL, local Redis (REDIS_URL) and a
// real BullMQ worker on a queue used only by this run. Object storage is
// mocked. Fictional data only; test users (and their messages) are removed.
describe('Message release (e2e, PostgreSQL + Redis + BullMQ)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let queue: Queue;
  const run = Date.now();
  const queueName = `test-message-release-${run}`;
  const emails = ['lisa'].map((n) => `release.${n}.${run}@example.test`);
  const password = 'StrongPassword123!';

  type Agent = ReturnType<typeof request.agent>;
  let lisa: Agent;
  let sofiaId: string;

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (check: () => Promise<boolean>, ms = 20_000) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) {
      if (await check()) return;
    }
    throw new Error('Timed out waiting for the release worker');
  };
  // Explicit UTC ("Z") instants, as the API requires an offset.
  const inSeconds = (s: number) => new Date(Date.now() + s * 1000);

  const addMessage = async (recipientId = sofiaId) =>
    (
      await lisa
        .post('/api/v1/messages')
        .send({
          title: 'Timed Release Test',
          contentType: 'TEXT',
          textContent: 'Fictional test message.',
          recipientIds: [recipientId],
        })
        .expect(201)
    ).body.id as string;
  const schedule = (id: string, body: object) =>
    lisa.post(`/api/v1/messages/${id}/schedule`).send(body);
  const statusOf = async (id: string) =>
    (await lisa.get(`/api/v1/messages/${id}`).expect(200)).body
      .status as string;
  const releases = (messageId: string) =>
    prisma.messageRelease.findMany({ where: { messageId } });
  const jobState = async (messageId: string) =>
    (await queue.getJob(releaseJobId(messageId)))?.getState();

  beforeAll(async () => {
    // Isolated queue; a long interval so only explicit reconcile calls run.
    process.env.RELEASE_QUEUE_NAME = queueName;
    process.env.RELEASE_RECONCILE_INTERVAL_SECONDS = '3600';
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        AuthModule,
        RecipientsModule,
        MessagesModule,
        MessageSchedulesModule,
        MediaModule,
      ],
    })
      .overrideProvider(MediaStorage)
      .useValue({})
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app, new session.MemoryStore());
    await app.init();
    prisma = app.get(PrismaService);
    queue = new Queue(queueName, {
      connection: { url: process.env.REDIS_URL! },
    });

    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email: emails[0], password, firstName: 'Lisa', lastName: 'Test' })
      .expect(201);
    lisa = request.agent(app.getHttpServer());
    await lisa
      .post('/api/v1/auth/login')
      .send({ email: emails[0], password })
      .expect(200);
    sofiaId = (
      await lisa
        .post('/api/v1/recipients')
        .send({ firstName: 'Sofia' })
        .expect(201)
    ).body.id;
  });

  afterAll(async () => {
    await prisma?.user.deleteMany({ where: { email: { in: emails } } });
    await app?.close();
    await queue?.obliterate({ force: true });
    await queue?.close();
  });

  it('releases a FIXED_DATE message once, at its time, and keeps the schedule', async () => {
    const id = await addMessage();
    const at = inSeconds(3);
    await schedule(id, {
      triggerType: 'FIXED_DATE',
      scheduledFor: at.toISOString(),
    }).expect(201);
    expect(await statusOf(id)).toBe('SCHEDULED');
    expect(await jobState(id)).toBe('delayed');
    // The job holds the id only.
    expect((await queue.getJob(releaseJobId(id)))?.data).toEqual({
      messageId: id,
    });

    await waitFor(async () => (await statusOf(id)) === 'RELEASED');
    const [release, ...more] = await releases(id);
    expect(more).toEqual([]);
    expect(release).toMatchObject({
      triggerType: 'FIXED_DATE',
      scheduledFor: new Date(at.toISOString()),
    });
    expect(release.releasedAt.getTime()).toBeGreaterThanOrEqual(
      at.getTime() - 50,
    );
    // Schedule kept for history; no BullMQ state in the API response.
    const detail = await lisa.get(`/api/v1/messages/${id}`).expect(200);
    expect(JSON.stringify(detail.body)).not.toMatch(/job|attempt|release"/i);
    await lisa.get(`/api/v1/messages/${id}/schedule`).expect(200);

    // Duplicate processing (retry after a crash, second worker, duplicate job).
    expect(await app.get(MessageReleaseService).release(id)).toEqual({
      result: 'already_released',
    });
    const dup = await queue.add('release', { messageId: id });
    await waitFor(async () => (await dup.getState()) === 'completed');
    expect(await releases(id)).toHaveLength(1);
    expect(await statusOf(id)).toBe('RELEASED');
  }, 30_000);

  it('a RELEASED message is read-only', async () => {
    const id = await addMessage();
    await schedule(id, {
      triggerType: 'FIXED_DATE',
      scheduledFor: inSeconds(2).toISOString(),
    }).expect(201);
    await waitFor(async () => (await statusOf(id)) === 'RELEASED');
    const msg = `/api/v1/messages/${id}`;
    await lisa.patch(msg).send({ title: 'Changed' }).expect(409);
    await lisa.delete(msg).expect(409);
    await lisa
      .post(`${msg}/media/upload-url`)
      .send({
        kind: 'PHOTO',
        originalFileName: 'a.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 1000,
      })
      .expect(409);
    await lisa.delete(`${msg}/media/${crypto.randomUUID()}`).expect(409);
    await lisa
      .post(`${msg}/media/${crypto.randomUUID()}/complete`)
      .send({ providerFileId: 'f1' })
      .expect((res) => expect([404, 409]).toContain(res.status));
    await schedule(id, { triggerType: 'ON_DEATH' }).expect(409);
    await lisa
      .patch(`${msg}/schedule`)
      .send({ triggerType: 'ON_DEATH' })
      .expect(409);
    await lisa.delete(`${msg}/schedule`).expect(409);
    expect(await statusOf(id)).toBe('RELEASED');
  }, 30_000);

  it('rejects release fields from clients', async () => {
    const id = await addMessage();
    await lisa
      .patch(`/api/v1/messages/${id}`)
      .send({ status: 'RELEASED' })
      .expect(400);
    for (const extra of [
      { releasedAt: new Date().toISOString() },
      { release: {} },
      { releaseId: crypto.randomUUID() },
      { status: 'RELEASED' },
      { jobId: 'x' },
    ]) {
      await schedule(id, { triggerType: 'ON_DEATH', ...extra }).expect(400);
    }
    expect(await statusOf(id)).toBe('DRAFT');
  });

  it('unscheduling removes the job; a stale job still cannot release', async () => {
    const id = await addMessage();
    await schedule(id, {
      triggerType: 'FIXED_DATE',
      scheduledFor: inSeconds(3).toISOString(),
    }).expect(201);
    expect(await jobState(id)).toBe('delayed');
    await lisa.delete(`/api/v1/messages/${id}/schedule`).expect(204);
    expect(await jobState(id)).toBeUndefined();

    // Simulate a job that survived (e.g. Redis removal failed).
    const stale = await queue.add('release', { messageId: id });
    await waitFor(async () => (await stale.getState()) === 'completed');
    expect(stale.id).toBeDefined();
    await sleep(3500); // past the original time
    expect(await statusOf(id)).toBe('DRAFT');
    expect(await releases(id)).toEqual([]);
  }, 30_000);

  it('reschedule: releases at the new time only; an early job is re-delayed', async () => {
    const id = await addMessage();
    const timeA = inSeconds(2);
    const timeB = inSeconds(7);
    await schedule(id, {
      triggerType: 'FIXED_DATE',
      scheduledFor: timeA.toISOString(),
    }).expect(201);
    await lisa
      .patch(`/api/v1/messages/${id}/schedule`)
      .send({ scheduledFor: timeB.toISOString() })
      .expect(200);
    // A leftover job for time A fires now: PostgreSQL says "not yet".
    await queue.add('release', { messageId: id });
    await sleep(3500);
    expect(await statusOf(id)).toBe('SCHEDULED');
    expect(await releases(id)).toEqual([]);

    await waitFor(async () => (await statusOf(id)) === 'RELEASED');
    const [release] = await releases(id);
    expect(release.scheduledFor).toEqual(new Date(timeB.toISOString()));
    expect(release.releasedAt.getTime()).toBeGreaterThanOrEqual(
      timeB.getTime() - 50,
    );
  }, 30_000);

  it.each([
    ['ON_DEATH', { triggerType: 'ON_DEATH' }],
    ['AFTER_DEATH', { triggerType: 'AFTER_DEATH', afterDeathDays: 30 }],
  ])('%s is stored only: no job, never released', async (_, body) => {
    const id = await addMessage();
    await schedule(id, body).expect(201);
    expect(await jobState(id)).toBeUndefined();
    await app.get(MessageReleaseReconciler).reconcile();
    expect(await jobState(id)).toBeUndefined();
    // Even a forced job is a no-op.
    const forced = await queue.add('release', { messageId: id });
    await waitFor(async () => (await forced.getState()) === 'completed');
    expect(await statusOf(id)).toBe('SCHEDULED');
    expect(await releases(id)).toEqual([]);
  });

  it('FIXED_DATE → ON_DEATH removes the job; back to FIXED_DATE re-adds it', async () => {
    const id = await addMessage();
    const url = `/api/v1/messages/${id}/schedule`;
    await schedule(id, {
      triggerType: 'FIXED_DATE',
      scheduledFor: inSeconds(3600).toISOString(),
    }).expect(201);
    expect(await jobState(id)).toBe('delayed');
    await lisa.patch(url).send({ triggerType: 'ON_DEATH' }).expect(200);
    expect(await jobState(id)).toBeUndefined();
    await lisa
      .patch(url)
      .send({
        triggerType: 'FIXED_DATE',
        scheduledFor: inSeconds(3600).toISOString(),
      })
      .expect(200);
    expect(await jobState(id)).toBe('delayed');
    // Beyond the 24 h lookahead: PostgreSQL only.
    await lisa
      .patch(url)
      .send({ scheduledFor: inSeconds(3 * 86400).toISOString() })
      .expect(200);
    expect(await jobState(id)).toBeUndefined();
    await lisa.delete(url).expect(204);
  });

  it('recovers from Redis losing the job: reconciliation rebuilds it from PostgreSQL', async () => {
    const id = await addMessage();
    await schedule(id, {
      triggerType: 'FIXED_DATE',
      scheduledFor: inSeconds(3).toISOString(),
    }).expect(201);
    // Lose only this job (like a Redis flush, without touching sessions).
    await queue.remove(releaseJobId(id));
    expect(await jobState(id)).toBeUndefined();

    const result = await app.get(MessageReleaseReconciler).reconcile();
    expect(result.enqueued).toBeGreaterThanOrEqual(1);
    expect(await jobState(id)).toBe('delayed');
    // A second pass changes nothing for this message.
    await app.get(MessageReleaseReconciler).reconcile();
    await waitFor(async () => (await statusOf(id)) === 'RELEASED');
    expect(await releases(id)).toHaveLength(1);
  }, 30_000);

  it('no live recipient at release time → stays SCHEDULED (business block)', async () => {
    const jennyId = (
      await lisa
        .post('/api/v1/recipients')
        .send({ firstName: 'Jenny' })
        .expect(201)
    ).body.id;
    const id = await addMessage(jennyId);
    await schedule(id, {
      triggerType: 'FIXED_DATE',
      scheduledFor: inSeconds(2).toISOString(),
    }).expect(201);
    await lisa.delete(`/api/v1/recipients/${jennyId}`).expect(204);
    await waitFor(async () => (await jobState(id)) === 'completed');
    expect(await statusOf(id)).toBe('SCHEDULED');
    expect(await releases(id)).toEqual([]);
  }, 30_000);
});
