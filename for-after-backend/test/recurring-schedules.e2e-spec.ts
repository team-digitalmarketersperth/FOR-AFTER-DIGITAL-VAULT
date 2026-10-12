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
import {
  occurrenceJobId,
  releaseJobId,
} from '../src/message-release/message-release-queue.service.js';
import { MessageReleaseReconciler } from '../src/message-release/message-release-reconciler.service.js';
import { MessageReleaseService } from '../src/message-release/message-release.service.js';
import { MessageSchedulesModule } from '../src/message-schedules/message-schedules.module.js';
import { annualOccurrence } from '../src/message-schedules/recurrence.js';
import { MessagesModule } from '../src/messages/messages.module.js';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { eligibleGrant } from '../src/recipient-auth/recipient-auth.service.js';
import { RecipientsModule } from '../src/recipients/recipients.module.js';
import { QueueWorkersModule } from '../src/worker.module.js';

// Phase 16 end to end: NOW, BIRTHDAY, ANNIVERSARY, CUSTOM_EVENT and the
// per-Recipient release records, with real HTTP, PostgreSQL, local Redis and
// a real BullMQ worker on a queue used only by this run. Months and years are
// not waited for: a "test clock" moves a stored due time into the past, then
// the real reconciler and worker take over. ANNUAL_AFTER_DEATH runs through
// the real verified-death workflow in death-verification.e2e-spec.ts.
// Fictional data only; test users (and so their messages) are removed.
describe('Recurring and per-Recipient schedules (e2e, PostgreSQL + Redis + BullMQ)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let queue: Queue;
  const run = Date.now();
  const queueName = `test-message-release-recurring-${run}`;
  const emails = ['ana', 'ben'].map(
    (n) => `recurring.${n}.${run}@example.test`,
  );
  const password = 'StrongPassword123!';
  const ZONE = 'Australia/Perth';

  type Agent = ReturnType<typeof request.agent>;
  let ana: Agent;
  let ben: Agent;

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (check: () => Promise<boolean>, ms = 20_000) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) {
      if (await check()) return;
    }
    throw new Error('Timed out waiting for the release worker');
  };

  const addRecipient = async (
    agent: Agent,
    firstName: string,
    birthday: string | null,
  ) =>
    (
      await agent
        .post('/api/v1/recipients')
        .send({
          firstName,
          email: `${firstName.toLowerCase()}.${run}@example.test`,
          ...(birthday ? { birthday } : {}),
        })
        .expect(201)
    ).body.id as string;
  const addMessage = async (agent: Agent, recipientIds: string[]) =>
    (
      await agent
        .post('/api/v1/messages')
        .send({
          title: 'Recurring Test',
          contentType: 'TEXT',
          textContent: 'Fictional recurring message.',
          recipientIds,
        })
        .expect(201)
    ).body.id as string;
  const schedule = (agent: Agent, id: string, body: object) =>
    agent.post(`/api/v1/messages/${id}/schedule`).send(body);
  const statusOf = async (id: string) =>
    (await ana.get(`/api/v1/messages/${id}`).expect(200)).body.status as string;
  const occurrences = (messageId: string) =>
    prisma.messageRecipientRelease.findMany({
      where: { messageId },
      orderBy: [{ recipientId: 'asc' }, { occurrenceYear: 'asc' }],
    });
  const grantsOf = (messageId: string) =>
    prisma.recipientMessageAccessGrant.findMany({
      where: { messageId },
      include: { notifications: true },
    });
  // Test clock: "the day has come" for one occurrence.
  const arrive = (occurrenceId: string) =>
    prisma.messageRecipientRelease.update({
      where: { id: occurrenceId },
      data: { dueAt: new Date(Date.now() - 1000) },
    });
  const released = (occurrenceId: string) => async () =>
    !!(
      await prisma.messageRecipientRelease.findUnique({
        where: { id: occurrenceId },
      })
    )?.releasedAt;
  const reconcile = () => app.get(MessageReleaseReconciler).reconcile();
  const nextYear = new Date().getUTCFullYear() + 1;

  beforeAll(async () => {
    process.env.RELEASE_QUEUE_NAME = queueName;
    process.env.RELEASE_RECONCILE_INTERVAL_SECONDS = '3600';
    const moduleRef = await Test.createTestingModule({
      imports: [
        // Phase 17B: the worker process's consumers, started explicitly.
        QueueWorkersModule,
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
    const signUp = async (email: string, firstName: string) => {
      await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({ email, password, firstName, lastName: 'Test' })
        .expect(201);
      const agent = request.agent(app.getHttpServer());
      await agent
        .post('/api/v1/auth/login')
        .send({ email, password })
        .expect(200);
      return agent;
    };
    ana = await signUp(emails[0], 'Ana');
    ben = await signUp(emails[1], 'Ben');
  });

  afterAll(async () => {
    await prisma?.user.deleteMany({ where: { email: { in: emails } } });
    await app?.close();
    await queue?.obliterate({ force: true });
    await queue?.close();
  });

  describe('NOW', () => {
    it('schedule → immediate BullMQ job (after commit) → worker releases', async () => {
      const r = await addRecipient(ana, 'Nora', null);
      const id = await addMessage(ana, [r]);
      const res = await schedule(ana, id, { triggerType: 'NOW' }).expect(201);
      expect(res.body).toMatchObject({
        triggerType: 'NOW',
        scheduledFor: null,
      });
      await waitFor(async () => (await statusOf(id)) === 'RELEASED');
      const release = await prisma.messageRelease.findUniqueOrThrow({
        where: { messageId: id },
      });
      expect(release.triggerType).toBe('NOW');
      const grants = await grantsOf(id);
      expect(grants).toHaveLength(1);
      expect(grants[0].notifications).toHaveLength(1);
      // Job payload holds the id only.
      const job = await queue.getJob(releaseJobId(id));
      if (job) expect(job.data).toEqual({ messageId: id });
      // Duplicate processing is a no-op.
      expect(await app.get(MessageReleaseService).release(id)).toEqual({
        result: 'already_released',
      });
      expect(
        await prisma.messageRelease.count({ where: { messageId: id } }),
      ).toBe(1);
    });

    it('incomplete composition is refused (409), nothing queued', async () => {
      const r = await addRecipient(ana, 'Nils', null);
      const id = (
        await ana
          .post('/api/v1/messages')
          .send({ title: 'Empty', contentType: 'TEXT', recipientIds: [r] })
          .expect(201)
      ).body.id as string;
      await schedule(ana, id, { triggerType: 'NOW' }).expect(409);
      expect(await statusOf(id)).toBe('DRAFT');
      expect(await queue.getJob(releaseJobId(id))).toBeUndefined();
    });

    it('rejects fields that do not belong to NOW', async () => {
      const r = await addRecipient(ana, 'Nell', null);
      const id = await addMessage(ana, [r]);
      await schedule(ana, id, {
        triggerType: 'NOW',
        timezone: ZONE,
        localTime: '09:00',
      }).expect(400);
      await schedule(ana, id, {
        triggerType: 'NOW',
        scheduledFor: new Date(Date.now() + 60_000).toISOString(),
      }).expect(400);
      expect(await statusOf(id)).toBe('DRAFT');
    });
  });

  describe('BIRTHDAY (per Recipient)', () => {
    let id: string;
    let amyId: string;
    let bobId: string;
    let carlId: string;

    it('refuses while any assigned Recipient has no birthday (409)', async () => {
      const noBirthday = await addRecipient(ana, 'Una', null);
      const withBirthday = await addRecipient(ana, 'Vera', '1990-05-05');
      const m = await addMessage(ana, [noBirthday, withBirthday]);
      const res = await schedule(ana, m, {
        triggerType: 'BIRTHDAY',
        timezone: ZONE,
        localTime: '09:00',
      }).expect(409);
      expect(res.body.message).toMatch(/needs a birthday/);
      expect(await statusOf(m)).toBe('DRAFT');
      expect(await occurrences(m)).toEqual([]);
    });

    it('rejects invalid zones and fixed offsets (400)', async () => {
      const r = await addRecipient(ana, 'Wes', '1990-05-05');
      const m = await addMessage(ana, [r]);
      for (const timezone of ['+08:00', 'UTC', 'Mars/Olympus']) {
        await schedule(ana, m, {
          triggerType: 'BIRTHDAY',
          timezone,
          localTime: '09:00',
        }).expect(400);
      }
      await schedule(ana, m, {
        triggerType: 'BIRTHDAY',
        timezone: ZONE,
        localTime: '09:00',
        scheduledFor: new Date(Date.now() + 60_000).toISOString(),
      }).expect(400);
    });

    it('two Recipients with different birthdays → two independent due occurrences', async () => {
      amyId = await addRecipient(ana, 'Amy', '1990-03-10');
      bobId = await addRecipient(ana, 'Bob', '2001-07-24');
      carlId = await addRecipient(ana, 'Carl', '1988-02-29');
      id = await addMessage(ana, [amyId, bobId, carlId]);
      const res = await schedule(ana, id, {
        triggerType: 'BIRTHDAY',
        timezone: ZONE,
        localTime: '09:00',
      }).expect(201);
      expect(res.body).toMatchObject({
        triggerType: 'BIRTHDAY',
        timezone: ZONE,
        localTime: '09:00',
      });
      expect(await statusOf(id)).toBe('SCHEDULED');
      const occ = await occurrences(id);
      expect(occ).toHaveLength(3);
      const byRecipient = Object.fromEntries(
        occ.map((o) => [o.recipientId, o]),
      );
      const now = new Date();
      for (const [rid, month, day] of [
        [amyId, 3, 10],
        [bobId, 7, 24],
        [carlId, 2, 29],
      ] as const) {
        const o = byRecipient[rid];
        expect(o.releasedAt).toBeNull();
        expect(o.dueAt.getTime()).toBeGreaterThan(now.getTime());
        expect(o.dueAt).toEqual(
          annualOccurrence(o.occurrenceYear, month, day, '09:00', ZONE),
        );
      }
      // Nobody has access yet.
      expect(await grantsOf(id)).toEqual([]);
    });

    it('Amy’s day: only Amy is released; Bob is not released early', async () => {
      const amy = (await occurrences(id)).find((o) => o.recipientId === amyId)!;
      await arrive(amy.id);
      await reconcile();
      await waitFor(released(amy.id));
      expect(await statusOf(id)).toBe('SCHEDULED');
      const grants = await grantsOf(id);
      expect(grants.map((g) => g.recipientId)).toEqual([amyId]);
      expect(grants[0].notifications.map((n) => n.occurrenceId)).toEqual([
        amy.id,
      ]);
      // The Recipient Portal rule (eligibleGrant) now lets Amy in, Bob not.
      const amyEmail = `amy.${run}@example.test`;
      const bobEmail = `bob.${run}@example.test`;
      expect(
        await prisma.recipientMessageAccessGrant.count({
          where: { ...eligibleGrant(amyEmail), messageId: id },
        }),
      ).toBe(1);
      expect(
        await prisma.recipientMessageAccessGrant.count({
          where: { ...eligibleGrant(bobEmail), messageId: id },
        }),
      ).toBe(0);
      // Amy's next birthday is waiting, by calendar.
      const amyNext = (await occurrences(id)).filter(
        (o) => o.recipientId === amyId && !o.releasedAt,
      );
      expect(amyNext).toHaveLength(1);
      expect(amyNext[0].occurrenceYear).toBe(amy.occurrenceYear + 1);
      expect(amyNext[0].dueAt).toEqual(
        annualOccurrence(amy.occurrenceYear + 1, 3, 10, '09:00', ZONE),
      );
    });

    it('once released to anyone, the schedule cannot be changed or removed (409)', async () => {
      await ana
        .patch(`/api/v1/messages/${id}/schedule`)
        .send({ localTime: '10:00' })
        .expect(409);
      await ana.delete(`/api/v1/messages/${id}/schedule`).expect(409);
      const { body } = await ana
        .get(`/api/v1/messages/${id}/schedule`)
        .expect(200);
      expect(body.releasedRecipientCount).toBe(1);
      await ana
        .patch(`/api/v1/messages/${id}`)
        .send({ title: 'x' })
        .expect(409);
      expect(await statusOf(id)).toBe('SCHEDULED');
    });

    it('concurrent workers on Bob’s day: exactly one release, grant and email', async () => {
      const bob = (await occurrences(id)).find((o) => o.recipientId === bobId)!;
      await arrive(bob.id);
      const service = app.get(MessageReleaseService);
      const results = await Promise.all(
        Array.from({ length: 5 }, () => service.releaseOccurrence(bob.id)),
      );
      expect(
        results.filter((r) => r.result === 'occurrence_released'),
      ).toHaveLength(1);
      expect(
        results.every((r) =>
          ['occurrence_released', 'already_released'].includes(r.result),
        ),
      ).toBe(true);
      // A duplicate BullMQ job and a reconciler pass change nothing.
      await queue.add('release', { messageId: id, occurrenceId: bob.id });
      await reconcile();
      await sleep(1000);
      const grants = (await grantsOf(id)).filter(
        (g) => g.recipientId === bobId,
      );
      expect(grants).toHaveLength(1);
      expect(grants[0].notifications).toHaveLength(1);
      expect(
        (await occurrences(id)).filter((o) => o.recipientId === bobId),
      ).toHaveLength(2); // this year (released) + next year (pending)
    });

    it('the second year re-notifies Amy with no second grant', async () => {
      const amyNext = (await occurrences(id)).find(
        (o) => o.recipientId === amyId && !o.releasedAt,
      )!;
      await arrive(amyNext.id);
      await reconcile();
      await waitFor(released(amyNext.id));
      const grants = (await grantsOf(id)).filter(
        (g) => g.recipientId === amyId,
      );
      expect(grants).toHaveLength(1);
      expect(grants[0].notifications).toHaveLength(2);
    });

    it('a Recipient deleted before their day gets no access and no future years', async () => {
      const carl = (await occurrences(id)).find(
        (o) => o.recipientId === carlId,
      )!;
      await ana.delete(`/api/v1/recipients/${carlId}`).expect(204);
      await arrive(carl.id);
      expect(
        await app.get(MessageReleaseService).releaseOccurrence(carl.id),
      ).toEqual({ result: 'stale', reason: 'recipient removed' });
      expect(
        (await grantsOf(id)).filter((g) => g.recipientId === carlId),
      ).toEqual([]);
      expect(
        (await occurrences(id)).filter((o) => o.recipientId === carlId),
      ).toEqual([]);
    });

    it('Redis flushed: the reconciler rebuilds jobs from PostgreSQL without duplicates', async () => {
      const m = await addMessage(ana, [
        await addRecipient(ana, 'Dora', '1995-12-01'),
      ]);
      await schedule(ana, m, {
        triggerType: 'BIRTHDAY',
        timezone: ZONE,
        localTime: '09:00',
      }).expect(201);
      const [occ] = await occurrences(m);
      await queue.obliterate({ force: true });
      await arrive(occ.id);
      await reconcile();
      await reconcile();
      expect((await queue.getJob(occurrenceJobId(occ.id)))?.data).toEqual({
        messageId: m,
        occurrenceId: occ.id,
      });
      await waitFor(released(occ.id));
      expect(await grantsOf(m)).toHaveLength(1);
    });

    it('the database refuses a second row for the same Recipient occurrence', async () => {
      const [occ] = await occurrences(id);
      await expect(
        prisma.messageRecipientRelease.create({
          data: {
            messageId: occ.messageId,
            recipientId: occ.recipientId,
            occurrenceYear: occ.occurrenceYear,
            dueAt: occ.dueAt,
          },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
    });
  });

  describe('ANNIVERSARY', () => {
    it('annual month/day: release, then the next calendar year', async () => {
      const r = await addRecipient(ana, 'Elsa', null); // no birthday needed
      const id = await addMessage(ana, [r]);
      const res = await schedule(ana, id, {
        triggerType: 'ANNIVERSARY',
        timezone: 'America/New_York',
        localTime: '18:30',
        annualMonth: 2,
        annualDay: 29,
      }).expect(201);
      expect(res.body).toMatchObject({ annualMonth: 2, annualDay: 29 });
      await ana
        .patch(`/api/v1/messages/${id}/schedule`)
        .send({ annualDay: 30 })
        .expect(400);
      const [first] = await occurrences(id);
      expect(first.dueAt).toEqual(
        annualOccurrence(
          first.occurrenceYear,
          2,
          29,
          '18:30',
          'America/New_York',
        ),
      );
      await arrive(first.id);
      await reconcile();
      await waitFor(released(first.id));
      expect(await statusOf(id)).toBe('SCHEDULED');
      const next = (await occurrences(id)).find((o) => !o.releasedAt)!;
      expect(next.occurrenceYear).toBeGreaterThan(first.occurrenceYear);
      expect(next.dueAt).toEqual(
        annualOccurrence(
          next.occurrenceYear,
          2,
          29,
          '18:30',
          'America/New_York',
        ),
      );
    });

    it('PATCH before any release rebuilds the pending occurrence', async () => {
      const r = await addRecipient(ana, 'Finn', null);
      const id = await addMessage(ana, [r]);
      await schedule(ana, id, {
        triggerType: 'ANNIVERSARY',
        timezone: ZONE,
        localTime: '09:00',
        annualMonth: 12,
        annualDay: 31,
      }).expect(201);
      const [before] = await occurrences(id);
      await ana
        .patch(`/api/v1/messages/${id}/schedule`)
        .send({ annualMonth: 1, annualDay: 1 })
        .expect(200);
      const after = await occurrences(id);
      expect(after).toHaveLength(1);
      expect(after[0].id).not.toBe(before.id);
      expect(after[0].dueAt).toEqual(
        annualOccurrence(after[0].occurrenceYear, 1, 1, '09:00', ZONE),
      );
      // Unschedule before release: back to DRAFT, occurrences gone.
      await ana.delete(`/api/v1/messages/${id}/schedule`).expect(204);
      expect(await statusOf(id)).toBe('DRAFT');
      expect(await occurrences(id)).toEqual([]);
    });
  });

  describe('CUSTOM_EVENT', () => {
    it('one-time: local date/time + zone → UTC; releases once, no recurrence', async () => {
      const r = await addRecipient(ana, 'Gus', null);
      const id = await addMessage(ana, [r]);
      const res = await schedule(ana, id, {
        triggerType: 'CUSTOM_EVENT',
        timezone: 'Asia/Kolkata',
        localTime: '18:30',
        eventDate: `${nextYear}-06-01`,
        eventLabel: 'Graduation day',
      }).expect(201);
      expect(res.body).toMatchObject({
        triggerType: 'CUSTOM_EVENT',
        eventLabel: 'Graduation day',
        scheduledFor: `${nextYear}-06-01T13:00:00.000Z`,
      });
      // Test clock: the event has arrived.
      await prisma.messageSchedule.update({
        where: { messageId: id },
        data: { scheduledFor: new Date(Date.now() - 1000) },
      });
      await reconcile();
      await waitFor(async () => (await statusOf(id)) === 'RELEASED');
      expect(await occurrences(id)).toEqual([]);
      expect(await grantsOf(id)).toHaveLength(1);
    });

    it('past event, markup in the label, or a client UTC time are refused', async () => {
      const r = await addRecipient(ana, 'Hal', null);
      const id = await addMessage(ana, [r]);
      const base = {
        triggerType: 'CUSTOM_EVENT',
        timezone: ZONE,
        localTime: '09:00',
        eventDate: `${nextYear}-01-01`,
        eventLabel: 'Wedding',
      };
      await schedule(ana, id, { ...base, eventDate: '2020-01-01' }).expect(400);
      await schedule(ana, id, { ...base, eventLabel: '<b>hi</b>' }).expect(400);
      await schedule(ana, id, {
        ...base,
        scheduledFor: new Date(Date.now() + 60_000).toISOString(),
      }).expect(400);
      expect(await statusOf(id)).toBe('DRAFT');
    });
  });

  describe('isolation and database backstops', () => {
    it('another Customer cannot read, change or schedule with someone else’s data', async () => {
      const r = await addRecipient(ana, 'Ivy', '1990-01-01');
      const id = await addMessage(ana, [r]);
      await schedule(ana, id, {
        triggerType: 'BIRTHDAY',
        timezone: ZONE,
        localTime: '09:00',
      }).expect(201);
      await ben.get(`/api/v1/messages/${id}/schedule`).expect(404);
      await ben
        .patch(`/api/v1/messages/${id}/schedule`)
        .send({ localTime: '10:00' })
        .expect(404);
      await ben.delete(`/api/v1/messages/${id}/schedule`).expect(404);
      await schedule(ben, id, { triggerType: 'NOW' }).expect(404);
      // Ben cannot assign Ana's Recipient to his own message.
      await ben
        .post('/api/v1/messages')
        .send({ title: 'x', textContent: 'y', recipientIds: [r] })
        .expect((res) => expect([400, 404]).toContain(res.status));
    });

    it('the CHECK constraint refuses trigger/field mismatches even without the API', async () => {
      const r = await addRecipient(ana, 'Jon', null);
      const id = await addMessage(ana, [r]);
      for (const data of [
        { triggerType: 'BIRTHDAY' as const },
        { triggerType: 'NOW' as const, timezone: ZONE },
        {
          triggerType: 'ANNIVERSARY' as const,
          timezone: ZONE,
          localTime: '09:00',
          annualMonth: 13,
          annualDay: 1,
        },
        {
          triggerType: 'ANNUAL_AFTER_DEATH' as const,
          timezone: ZONE,
          localTime: '9am',
        },
        {
          triggerType: 'CUSTOM_EVENT' as const,
          timezone: ZONE,
          localTime: '09:00',
          eventDate: new Date(`${nextYear}-01-01`),
          scheduledFor: new Date(`${nextYear}-01-01T01:00:00Z`),
        },
      ]) {
        await expect(
          prisma.messageSchedule.create({ data: { messageId: id, ...data } }),
        ).rejects.toThrow();
      }
    });
  });
});
