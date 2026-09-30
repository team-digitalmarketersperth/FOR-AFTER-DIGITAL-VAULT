import { ConfigModule } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import session from 'express-session';
import request from 'supertest';
import { adminSignIn } from './admin-sign-in.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { configureApp } from '../src/config/app.setup.js';
import { MessageSchedulesModule } from '../src/message-schedules/message-schedules.module.js';
import { MessagesModule } from '../src/messages/messages.module.js';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { RecipientsModule } from '../src/recipients/recipients.module.js';

// Real HTTP, validation, guards and PostgreSQL (DATABASE_URL from .env).
// Sessions use MemoryStore; the Step 12 release queue uses the local Redis
// (REDIS_URL, test queue name). Fictional data only; the
// test users are removed afterwards (cascade removes everything they own).
describe('Message schedules (e2e, PostgreSQL)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const run = Date.now();
  const emails = ['lisa', 'john', 'admin'].map(
    (name) => `sched.${name}.${run}@example.test`,
  );
  const password = 'StrongPassword123!';

  type Agent = ReturnType<typeof request.agent>;
  const signIn = async (email: string) => {
    const agent = request.agent(app.getHttpServer());
    await agent
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(200);
    return agent;
  };
  const addRecipient = async (agent: Agent, firstName: string) =>
    (await agent.post('/api/v1/recipients').send({ firstName }).expect(201))
      .body.id as string;
  const addMessage = async (agent: Agent, recipientId: string) =>
    (
      await agent
        .post('/api/v1/messages')
        .send({
          title: 'Fictional message',
          textContent: 'Fictional text.',
          recipientIds: [recipientId],
        })
        .expect(201)
    ).body.id as string;
  const scheduleUrl = (messageId: string) =>
    `/api/v1/messages/${messageId}/schedule`;
  const statusOf = async (agent: Agent, messageId: string) =>
    (await agent.get(`/api/v1/messages/${messageId}`).expect(200)).body
      .status as string;

  // 60 days ahead, written as Perth-style local time with an explicit offset.
  const futureUtc = new Date(Date.now() + 60 * 86_400_000);
  futureUtc.setUTCMilliseconds(0);
  const futureWithOffset =
    new Date(futureUtc.getTime() + 8 * 3_600_000).toISOString().slice(0, 19) +
    '+08:00';

  let lisa: Agent;
  let john: Agent;
  let sofiaId: string;
  let messageA: string;
  let messageB: string;
  let url: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        AuthModule,
        RecipientsModule,
        MessagesModule,
        MessageSchedulesModule,
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app, new session.MemoryStore());
    await app.init();
    prisma = app.get(PrismaService);

    for (const email of emails) {
      await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({ email, password, firstName: 'Test', lastName: 'User' })
        .expect(201);
    }
    lisa = await signIn(emails[0]);
    john = await signIn(emails[1]);
    sofiaId = await addRecipient(lisa, 'Sofia');
    messageA = await addMessage(lisa, sofiaId);
    messageB = await addMessage(john, await addRecipient(john, 'Michael'));
    url = scheduleUrl(messageA);
  });

  afterAll(async () => {
    await prisma?.user.deleteMany({ where: { email: { in: emails } } });
    await app?.close();
  });

  it('requires a session (401), a customer (403) and a UUID (400)', async () => {
    await request(app.getHttpServer())
      .post(url)
      .send({ triggerType: 'ON_DEATH' })
      .expect(401);
    await prisma.user.update({
      where: { email: emails[2] },
      data: { role: 'ADMIN' },
    });
    // Step 16: an admin session needs password + TOTP.
    const { agent: admin } = await adminSignIn(app, emails[2], password);
    await admin.get(url).expect(403);
    await admin.post(url).send({ triggerType: 'ON_DEATH' }).expect(403);
    await lisa.get(scheduleUrl('not-a-uuid')).expect(400);
  });

  it('rejects invalid schedules (400) and leaves the message DRAFT', async () => {
    const past = new Date(Date.now() - 86_400_000).toISOString();
    for (const body of [
      { triggerType: 'FIXED_DATE' },
      { triggerType: 'FIXED_DATE', scheduledFor: past },
      { triggerType: 'FIXED_DATE', scheduledFor: '2030-12-25' },
      { triggerType: 'FIXED_DATE', scheduledFor: '2030-12-25T09:00:00' },
      {
        triggerType: 'FIXED_DATE',
        scheduledFor: futureWithOffset,
        afterDeathDays: 10,
      },
      { triggerType: 'ON_DEATH', scheduledFor: futureWithOffset },
      { triggerType: 'ON_DEATH', afterDeathDays: 5 },
      { triggerType: 'AFTER_DEATH' },
      { triggerType: 'AFTER_DEATH', afterDeathDays: -1 },
      {
        triggerType: 'AFTER_DEATH',
        afterDeathDays: 30,
        scheduledFor: futureWithOffset,
      },
      { triggerType: 'NOW' },
      { triggerType: 'BIRTHDAY' },
      { triggerType: 'ANNIVERSARY' },
      { triggerType: 'CUSTOM_EVENT' },
      { triggerType: 'ANNUAL_AFTER_DEATH' },
      { triggerType: 'ON_DEATH', status: 'SCHEDULED' },
    ]) {
      await lisa.post(url).send(body).expect(400);
    }
    expect(await statusOf(lisa, messageA)).toBe('DRAFT');
    await lisa.get(url).expect(404);
  });

  it('schedules a FIXED_DATE: 201, message SCHEDULED, instant stored in UTC', async () => {
    const created = await lisa
      .post(url)
      .send({ triggerType: 'FIXED_DATE', scheduledFor: futureWithOffset })
      .expect(201);
    expect(created.body).toMatchObject({
      triggerType: 'FIXED_DATE',
      scheduledFor: futureUtc.toISOString(),
      afterDeathDays: null,
    });
    for (const hidden of ['messageId', 'message', 'ownerUserId']) {
      expect(created.body).not.toHaveProperty(hidden);
    }
    expect(await statusOf(lisa, messageA)).toBe('SCHEDULED');

    const got = await lisa.get(url).expect(200);
    expect(got.body.scheduledFor).toBe(futureUtc.toISOString());

    // One schedule per message.
    await lisa.post(url).send({ triggerType: 'ON_DEATH' }).expect(409);
    // A scheduled message is locked for Step 5 edits; status stays server-only.
    await lisa
      .patch(`/api/v1/messages/${messageA}`)
      .send({ title: 'Changed' })
      .expect(409);
    await lisa
      .patch(`/api/v1/messages/${messageA}`)
      .send({ status: 'RELEASED' })
      .expect(400);
  });

  it('PATCH validates the merged state and drops stale fields', async () => {
    const onDeath = await lisa
      .patch(url)
      .send({ triggerType: 'ON_DEATH' })
      .expect(200);
    expect(onDeath.body).toMatchObject({
      triggerType: 'ON_DEATH',
      scheduledFor: null,
      afterDeathDays: null,
    });
    await lisa.patch(url).send({ triggerType: 'AFTER_DEATH' }).expect(400);
    await lisa.patch(url).send({ afterDeathDays: 5 }).expect(400);
    await lisa.patch(url).send({ triggerType: 'NOW' }).expect(400);

    const afterDeath = await lisa
      .patch(url)
      .send({ triggerType: 'AFTER_DEATH', afterDeathDays: 30 })
      .expect(200);
    expect(afterDeath.body).toMatchObject({
      triggerType: 'AFTER_DEATH',
      scheduledFor: null,
      afterDeathDays: 30,
    });
    expect((await lisa.get(url).expect(200)).body.afterDeathDays).toBe(30);
    expect(await statusOf(lisa, messageA)).toBe('SCHEDULED');
  });

  it('isolates users: John gets a plain 404 for Lisa’s message schedule', async () => {
    const responses = [
      await john.get(url).expect(404),
      await john.post(url).send({ triggerType: 'ON_DEATH' }).expect(404),
      await john.patch(url).send({ triggerType: 'ON_DEATH' }).expect(404),
      await john.delete(url).expect(404),
    ];
    for (const res of responses) {
      expect(JSON.stringify(res.body)).not.toMatch(/owner|belongs|lisa|Sofia/i);
    }
    // Lisa cannot touch John's message either.
    await lisa
      .post(scheduleUrl(messageB))
      .send({ triggerType: 'ON_DEATH' })
      .expect(404);
    const row = await prisma.messageSchedule.findUnique({
      where: { messageId: messageA },
    });
    expect(row?.triggerType).toBe('AFTER_DEATH');
  });

  it('unschedules: 204, schedule gone, message DRAFT again (not CANCELLED)', async () => {
    await lisa.delete(url).expect(204);
    await lisa.get(url).expect(404);
    await lisa.delete(url).expect(404);
    await lisa.patch(url).send({ triggerType: 'ON_DEATH' }).expect(404);
    expect(await statusOf(lisa, messageA)).toBe('DRAFT');
    expect(
      await prisma.messageSchedule.count({ where: { messageId: messageA } }),
    ).toBe(0);
    // Editable again through Step 5.
    await lisa
      .patch(`/api/v1/messages/${messageA}`)
      .send({ title: 'Edited after unscheduling' })
      .expect(200);
  });

  it('refuses a message with no live recipient, and RELEASED/CANCELLED/deleted messages', async () => {
    const lonelyRecipient = await addRecipient(lisa, 'Gone');
    const lonely = await addMessage(lisa, lonelyRecipient);
    await lisa.delete(`/api/v1/recipients/${lonelyRecipient}`).expect(204);
    await lisa
      .post(scheduleUrl(lonely))
      .send({ triggerType: 'ON_DEATH' })
      .expect(400);
    expect(await statusOf(lisa, lonely)).toBe('DRAFT');

    for (const status of ['RELEASED', 'CANCELLED'] as const) {
      const id = await addMessage(lisa, sofiaId);
      await prisma.message.update({ where: { id }, data: { status } });
      await lisa
        .post(scheduleUrl(id))
        .send({ triggerType: 'ON_DEATH' })
        .expect(409);
      await lisa.delete(scheduleUrl(id)).expect(409);
      expect(await statusOf(lisa, id)).toBe(status);
    }

    const deleted = await addMessage(lisa, sofiaId);
    await lisa.delete(`/api/v1/messages/${deleted}`).expect(204);
    await lisa
      .post(scheduleUrl(deleted))
      .send({ triggerType: 'ON_DEATH' })
      .expect(404);
  });

  it('the database itself refuses a schedule whose fields contradict its trigger', async () => {
    await expect(
      prisma.messageSchedule.create({
        data: {
          messageId: messageA,
          triggerType: 'ON_DEATH',
          afterDeathDays: 3,
        },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.messageSchedule.create({
        data: { messageId: messageA, triggerType: 'BIRTHDAY' },
      }),
    ).rejects.toThrow();
  });
});
