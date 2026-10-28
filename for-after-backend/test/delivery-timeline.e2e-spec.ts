import { ConfigModule } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import { Queue } from 'bullmq';
import session from 'express-session';
import request from 'supertest';
import { AuthModule } from '../src/auth/auth.module.js';
import { configureApp } from '../src/config/app.setup.js';
import { DeliveryTimelineModule, DeliveryTimelineService } from '../src/delivery-timeline/delivery-timeline.module.js';
import { MessageSchedulesModule } from '../src/message-schedules/message-schedules.module.js';
import { MessagesModule } from '../src/messages/messages.module.js';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { RecipientsModule } from '../src/recipients/recipients.module.js';
import { RedisModule } from '../src/redis/redis.module.js';

// Delivery timeline end to end: real HTTP, guards, PostgreSQL and the real
// scheduling engine (its occurrences and instants are what the timeline reads).
// No worker runs, so nothing is released unless a test says so. Fictional
// data only; both users are deleted afterwards.
describe('Delivery timeline (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let releaseQueue: Queue;
  const run = Date.now();
  const users = { ada: `dt.ada.${run}@example.test`, ben: `dt.ben.${run}@example.test` };
  const password = 'StrongPassword123!';
  const releaseQueueName = `test-dt-release-${run}`;
  const api = (path: string) => `/api/v1${path}`;
  const agents: Record<string, ReturnType<typeof request.agent>> = {};
  const PRIVATE = 'PRIVATE-FICTIONAL-TEXT';
  const nextYear = new Date().getUTCFullYear() + 1;
  const timeline = async (who = 'ada') => (await agents[who].get(api('/users/me/delivery-timeline')).expect(200)).body;
  const ids: Record<string, string> = {};

  const recipient = async (firstName: string, birthday: string | null = null) =>
    (await agents.ada.post(api('/recipients')).send({ firstName, birthday, email: `${firstName}.${run}@example.test`, privateNote: PRIVATE }).expect(201))
      .body.id as string;
  const scheduled = async (title: string, recipientIds: string[], schedule: object) => {
    const id = (await agents.ada.post(api('/messages')).send({ title, textContent: PRIVATE, recipientIds }).expect(201)).body.id as string;
    await agents.ada.post(api(`/messages/${id}/schedule`)).send(schedule).expect(201);
    return id;
  };

  beforeAll(async () => {
    process.env.RELEASE_QUEUE_NAME = releaseQueueName;
    process.env.RELEASE_RECONCILE_INTERVAL_SECONDS = '3600';
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        RedisModule,
        AuthModule,
        RecipientsModule,
        MessagesModule,
        MessageSchedulesModule,
        DeliveryTimelineModule,
      ],
    })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app, new session.MemoryStore());
    await app.init();
    prisma = app.get(PrismaService);
    releaseQueue = new Queue(releaseQueueName, { connection: { url: process.env.REDIS_URL! } });
    for (const [key, email] of Object.entries(users)) {
      await request(app.getHttpServer()).post(api('/auth/register')).send({ email, password, firstName: key, lastName: 'Test' }).expect(201);
      agents[key] = request.agent(app.getHttpServer());
      await agents[key].post(api('/auth/login')).send({ email, password }).expect(200);
    }
  });

  afterAll(async () => {
    await prisma?.user.deleteMany({ where: { email: { in: Object.values(users) } } });
    await app?.close();
    await releaseQueue?.obliterate({ force: true });
    await releaseQueue?.close();
  });

  it('needs a Customer session; a new account has an empty plan', async () => {
    await request(app.getHttpServer()).get(api('/users/me/delivery-timeline')).expect(401);
    expect(await timeline()).toEqual({ upcoming: [], conditional: [], recent: [] });
  });

  it('builds every trigger from the engine’s own rows', async () => {
    ids.mum = await recipient('Mum', '1960-12-24');
    ids.sarah = await recipient('Sarah', '1990-03-14');
    ids.james = await recipient('James', '1992-06-22');
    ids.alex = await recipient('Alex');
    ids.emma = await recipient('Emma');
    // A draft never appears: it has no timing yet.
    await agents.ada.post(api('/messages')).send({ title: 'Unscheduled draft', recipientIds: [ids.mum] }).expect(201);

    ids.fixed = await scheduled('Christmas message', [ids.mum], {
      triggerType: 'FIXED_DATE',
      scheduledFor: `${nextYear}-12-24T09:00:00+11:00`,
    });
    ids.birthday = await scheduled('Birthday message', [ids.sarah, ids.james], {
      triggerType: 'BIRTHDAY',
      timezone: 'Australia/Perth',
      localTime: '09:00',
    });
    ids.anniversary = await scheduled('Anniversary message', [ids.alex], {
      triggerType: 'ANNIVERSARY',
      timezone: 'Australia/Perth',
      localTime: '18:30',
      annualMonth: 4,
      annualDay: 10,
    });
    ids.custom = await scheduled('Graduation message', [ids.emma], {
      triggerType: 'CUSTOM_EVENT',
      timezone: 'Australia/Perth',
      localTime: '10:00',
      eventDate: `${nextYear}-09-05`,
      eventLabel: 'Graduation day',
    });
    ids.now = await scheduled('Right away', [ids.mum], { triggerType: 'NOW' });
    ids.onDeath = await scheduled('Letter to family', [ids.mum, ids.sarah], { triggerType: 'ON_DEATH' });
    ids.after30 = await scheduled('Thirty days on', [ids.sarah], { triggerType: 'AFTER_DEATH', afterDeathDays: 30 });
    ids.after7 = await scheduled('A week on', [ids.sarah], { triggerType: 'AFTER_DEATH', afterDeathDays: 7 });
    ids.annual = await scheduled('Annual remembrance', [ids.mum], {
      triggerType: 'ANNUAL_AFTER_DEATH',
      timezone: 'Australia/Perth',
      localTime: '09:00',
    });

    const t = await timeline();
    // NOW first, then ascending by the real stored instant.
    expect(t.upcoming[0]).toMatchObject({ messageId: ids.now, triggerType: 'NOW', dueAt: null, recipients: ['Mum'] });
    const times = t.upcoming.slice(1).map((e: { dueAt: string }) => Date.parse(e.dueAt));
    expect(times).toEqual([...times].sort((a, b) => a - b));

    // One row per Recipient for birthdays (never merged), at the engine's own dueAt.
    const birthdays = t.upcoming.filter((e: { messageId: string }) => e.messageId === ids.birthday);
    expect(birthdays.map((e: { recipients: string[] }) => e.recipients)).toEqual(
      expect.arrayContaining([['Sarah'], ['James']]),
    );
    const stored = await prisma.messageRecipientRelease.findMany({ where: { messageId: ids.birthday, releasedAt: null } });
    expect(birthdays.map((e: { dueAt: string }) => e.dueAt).sort()).toEqual(stored.map((o) => o.dueAt.toISOString()).sort());
    expect(birthdays.every((e: { repeatsAnnually: boolean; timezone: string }) => e.repeatsAnnually && e.timezone === 'Australia/Perth')).toBe(true);

    const fixed = t.upcoming.find((e: { messageId: string }) => e.messageId === ids.fixed);
    expect(fixed).toMatchObject({ dueAt: `${nextYear}-12-23T22:00:00.000Z`, timezone: null, repeatsAnnually: false, recipients: ['Mum'] });
    expect(t.upcoming.find((e: { messageId: string }) => e.messageId === ids.anniversary)).toMatchObject({
      triggerType: 'ANNIVERSARY',
      repeatsAnnually: true,
      recipients: ['Alex'],
    });
    expect(t.upcoming.find((e: { messageId: string }) => e.messageId === ids.custom)).toMatchObject({
      dueAt: `${nextYear}-09-05T02:00:00.000Z`,
      eventLabel: 'Graduation day',
      repeatsAnnually: false,
    });

    // Death-triggered: conditional, never a date; ON_DEATH, AFTER_DEATH by offset, then annual.
    expect(t.conditional.map((e: { messageId: string }) => e.messageId)).toEqual([ids.onDeath, ids.after7, ids.after30, ids.annual]);
    expect(t.conditional[0]).toMatchObject({ triggerType: 'ON_DEATH', afterDeathDays: null, recipients: ['Mum', 'Sarah'] });
    expect(JSON.stringify(t.conditional)).not.toMatch(/dueAt/);
    // Every recurring trigger yields its next occurrence only: 1 row per Recipient.
    expect(t.upcoming).toHaveLength(1 /* now */ + 1 /* fixed */ + 2 /* birthdays */ + 1 /* anniversary */ + 1 /* custom */);
  });

  it('never returns content, contact details, notes or internal ids', async () => {
    const t = await timeline();
    expect(JSON.stringify(t)).not.toMatch(new RegExp(`${PRIVATE}|@|example\\.test|Unscheduled draft`));
    for (const e of t.upcoming) {
      expect(Object.keys(e).sort()).toEqual(
        ['dueAt', 'eventLabel', 'key', 'messageId', 'recipients', 'repeatsAnnually', 'timezone', 'title', 'triggerType'],
      );
    }
  });

  it('removed Recipients and deleted messages drop out', async () => {
    await agents.ada.delete(api(`/recipients/${ids.james}`)).expect(204);
    const t = await timeline();
    expect(t.upcoming.filter((e: { messageId: string }) => e.messageId === ids.birthday).map((e: { recipients: string[] }) => e.recipients)).toEqual([
      ['Sarah'],
    ]);
    await agents.ada.delete(api(`/messages/${ids.after7}/schedule`)).expect(204);
    await agents.ada.delete(api(`/messages/${ids.after7}`)).expect(204);
    expect((await timeline()).conditional.map((e: { messageId: string }) => e.messageId)).not.toContain(ids.after7);
  });

  it('delivered: recently delivered (one-shot and per-Recipient), no longer upcoming', async () => {
    const now = new Date();
    await prisma.message.update({ where: { id: ids.now }, data: { status: 'RELEASED' } });
    await prisma.messageRelease.create({ data: { messageId: ids.now, triggerType: 'NOW', releasedAt: now } });
    const occ = await prisma.messageRecipientRelease.findFirstOrThrow({ where: { messageId: ids.anniversary, releasedAt: null } });
    await prisma.messageRecipientRelease.update({ where: { id: occ.id }, data: { releasedAt: now } });
    const t = await timeline();
    expect(t.upcoming.some((e: { messageId: string }) => e.messageId === ids.now)).toBe(false);
    expect(t.upcoming.some((e: { messageId: string }) => e.messageId === ids.anniversary)).toBe(false);
    expect(t.recent.map((e: { messageId: string }) => e.messageId).sort()).toEqual([ids.anniversary, ids.now].sort());
    expect(t.recent.find((e: { messageId: string }) => e.messageId === ids.now).recipients).toEqual(['Mum']);
    // Old deliveries are not a log: older than 30 days are left out.
    await prisma.messageRelease.update({ where: { messageId: ids.now }, data: { releasedAt: new Date(Date.now() - 31 * 86_400_000) } });
    expect((await timeline()).recent.map((e: { messageId: string }) => e.messageId)).toEqual([ids.anniversary]);
  });

  it('after a verified death the engine’s due dates are shown (service level: the Customer is PASSED then)', async () => {
    const owner = await prisma.user.findUniqueOrThrow({ where: { email: users.ada } });
    const kase = await prisma.deathVerificationCase.create({ data: { ownerUserId: owner.id, status: 'VERIFIED', verifiedAt: new Date() } });
    const due = new Date(Date.now() + 30 * 86_400_000);
    await prisma.deathTriggeredMessageActivation.create({
      data: { messageId: ids.after30, deathVerificationCaseId: kase.id, triggerType: 'AFTER_DEATH', activatedAt: new Date(), dueAt: due },
    });
    await prisma.messageRecipientRelease.create({
      data: { messageId: ids.annual, recipientId: ids.mum, occurrenceYear: nextYear, dueAt: new Date(`${nextYear}-01-01T01:00:00Z`) },
    });
    const t = await app.get(DeliveryTimelineService).getForUser(owner.id);
    expect(t.upcoming.find((e) => e.messageId === ids.after30)).toMatchObject({ dueAt: due, triggerType: 'AFTER_DEATH' });
    expect(t.upcoming.find((e) => e.messageId === ids.annual)).toMatchObject({ repeatsAnnually: true, recipients: ['Mum'] });
    expect(t.conditional.map((e) => e.messageId)).toEqual([ids.onDeath]);
    await prisma.deathVerificationCase.delete({ where: { id: kase.id } });
  });

  it('owner-only: another Customer sees nothing of it', async () => {
    expect(await timeline('ben')).toEqual({ upcoming: [], conditional: [], recent: [] });
  });
});
