import { ConfigModule } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import { Queue } from 'bullmq';
import session from 'express-session';
import request from 'supertest';
import { ActivityModule } from '../src/activity/activity.module.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { configureApp } from '../src/config/app.setup.js';
import { MediaModule } from '../src/media/media.module.js';
import { MemoryVaultModule } from '../src/memory-vault/memory-vault.module.js';
import { MessageSchedulesModule } from '../src/message-schedules/message-schedules.module.js';
import { MessagesModule } from '../src/messages/messages.module.js';
import { MyStoryModule } from '../src/my-story/my-story.module.js';
import { MyWishesModule } from '../src/my-wishes/my-wishes.module.js';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { RecipientsModule } from '../src/recipients/recipients.module.js';
import { RedisModule } from '../src/redis/redis.module.js';
import { TrustedContactsModule } from '../src/trusted-contacts/trusted-contacts.module.js';
import { UsersModule } from '../src/users/users.module.js';

// Customer "Recent changes" end to end: real HTTP, guards and PostgreSQL.
// One history row per successful change, the owner's own only, ids and types
// only (never content). Fictional data; both users are deleted afterwards.
describe('Customer activity (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let releaseQueue: Queue;
  const run = Date.now();
  const users = { ada: `ac.ada.${run}@example.test`, ben: `ac.ben.${run}@example.test` };
  const password = 'StrongPassword123!';
  const releaseQueueName = `test-ac-release-${run}`;
  const api = (path: string) => `/api/v1${path}`;
  const agents: Record<string, ReturnType<typeof request.agent>> = {};
  type Item = { id: string; type: string; createdAt: string; target: string | null };
  const activity = async (who = 'ada', query = '') =>
    (await agents[who].get(api(`/users/me/activity${query}`)).expect(200)).body as {
      items: Item[];
      pagination: { page: number; limit: number; total: number; pages: number };
    };
  const types = async (who = 'ada') => (await activity(who, '?limit=100')).items.map((i) => i.type);
  const latest = async () => (await activity('ada', '?limit=1')).items[0];
  const PRIVATE = 'PRIVATE-FICTIONAL-TEXT';

  beforeAll(async () => {
    process.env.RELEASE_QUEUE_NAME = releaseQueueName;
    process.env.RELEASE_RECONCILE_INTERVAL_SECONDS = '3600';
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        RedisModule,
        AuthModule,
        UsersModule,
        MediaModule,
        RecipientsModule,
        TrustedContactsModule,
        MessagesModule,
        MessageSchedulesModule,
        MemoryVaultModule,
        MyStoryModule,
        MyWishesModule,
        ActivityModule,
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
      await request(app.getHttpServer())
        .post(api('/auth/register'))
        .send({ email, password, firstName: key, lastName: 'Test' })
        .expect(201);
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

  it('needs a Customer session; a new account has no history (nothing backfilled)', async () => {
    await request(app.getHttpServer()).get(api('/users/me/activity')).expect(401);
    expect(await activity()).toEqual({ items: [], pagination: { page: 1, limit: 25, total: 0, pages: 0 } });
  });

  let recipientId: string;
  let messageId: string;
  it('people, trusted contacts, messages and schedules each record one calm event', async () => {
    recipientId = (await agents.ada.post(api('/recipients')).send({ firstName: 'Sofia', privateNote: PRIVATE }).expect(201)).body.id;
    expect(await latest()).toMatchObject({ type: 'PERSON_ADDED', target: recipientId });
    await agents.ada.patch(api(`/recipients/${recipientId}`)).send({ relationship: 'Daughter' }).expect(200);
    expect((await latest()).type).toBe('PERSON_UPDATED');

    const tc = (await agents.ada.post(api('/trusted-contacts')).send({ firstName: 'David', email: `ac.david.${run}@example.test` }).expect(201))
      .body.id;
    expect(await latest()).toMatchObject({ type: 'TRUSTED_CONTACT_ADDED', target: tc });
    await agents.ada.patch(api(`/trusted-contacts/${tc}`)).send({ relationship: 'Brother' }).expect(200);
    expect((await latest()).type).toBe('TRUSTED_CONTACT_UPDATED');
    await agents.ada.delete(api(`/trusted-contacts/${tc}`)).expect(204);
    // Removed: the history stays, the link does not.
    expect(await latest()).toMatchObject({ type: 'TRUSTED_CONTACT_REMOVED', target: null });

    messageId = (
      await agents.ada.post(api('/messages')).send({ title: 'For Sofia', textContent: PRIVATE, recipientIds: [recipientId] }).expect(201)
    ).body.id;
    expect(await latest()).toMatchObject({ type: 'MESSAGE_CREATED', target: messageId });
    await agents.ada.patch(api(`/messages/${messageId}`)).send({ textContent: `${PRIVATE} 2` }).expect(200);
    expect((await latest()).type).toBe('MESSAGE_UPDATED');

    const at = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
    await agents.ada.post(api(`/messages/${messageId}/schedule`)).send({ triggerType: 'FIXED_DATE', scheduledFor: at(365) }).expect(201);
    expect(await latest()).toMatchObject({ type: 'MESSAGE_SCHEDULED', target: messageId });
    await agents.ada.patch(api(`/messages/${messageId}/schedule`)).send({ triggerType: 'FIXED_DATE', scheduledFor: at(400) }).expect(200);
    expect((await latest()).type).toBe('MESSAGE_RESCHEDULED');
    await agents.ada.delete(api(`/messages/${messageId}/schedule`)).expect(204);
    expect((await latest()).type).toBe('MESSAGE_UNSCHEDULED');
  });

  it('memories, My Story and My Wishes: added, updated, removed', async () => {
    const memory = (await agents.ada.post(api('/memory-vault')).send({ title: 'Lake house', category: 'FAMILY', textContent: PRIVATE }).expect(201))
      .body.id;
    expect(await latest()).toMatchObject({ type: 'MEMORY_ADDED', target: memory });
    await agents.ada.patch(api(`/memory-vault/${memory}`)).send({ title: 'The lake house' }).expect(200);
    expect((await latest()).type).toBe('MEMORY_UPDATED');
    await agents.ada.delete(api(`/memory-vault/${memory}`)).expect(204);
    expect(await latest()).toMatchObject({ type: 'MEMORY_DELETED', target: null });

    const story = api('/my-story/prompts/childhood.earliest-memory/response');
    await agents.ada.put(story).send({ textContent: PRIVATE }).expect(200);
    expect(await latest()).toMatchObject({ type: 'STORY_RESPONSE_ADDED', target: 'childhood.earliest-memory' });
    await agents.ada.put(story).send({ textContent: `${PRIVATE} again` }).expect(200);
    expect((await latest()).type).toBe('STORY_RESPONSE_UPDATED');
    await agents.ada.delete(story).expect(204);
    expect(await latest()).toMatchObject({ type: 'STORY_RESPONSE_DELETED', target: null });

    const wish = api('/my-wishes/prompts/ceremony.style/response');
    await agents.ada.put(wish).send({ textContent: PRIVATE }).expect(200);
    expect(await latest()).toMatchObject({ type: 'WISH_RESPONSE_ADDED', target: 'ceremony.style' });
    await agents.ada.put(wish).send({ textContent: `${PRIVATE} again` }).expect(200);
    expect((await latest()).type).toBe('WISH_RESPONSE_UPDATED');
    await agents.ada.delete(wish).expect(204);
    expect((await latest()).type).toBe('WISH_RESPONSE_DELETED');
  });

  it('a failed change records nothing; a save that changes nothing records nothing', async () => {
    const before = (await activity()).pagination.total;
    // Empty wish: refused (400), rolled back with its history row.
    await agents.ada.put(api('/my-wishes/prompts/ceremony.style/response')).send({ textContent: null }).expect(400);
    await agents.ada.patch(api('/users/me')).send({ firstName: 'ada', lastName: 'Test' }).expect(200);
    expect((await activity()).pagination.total).toBe(before);
    await agents.ada.patch(api('/users/me')).send({ firstName: 'Ada', lastName: 'Test' }).expect(200);
    expect(await latest()).toMatchObject({ type: 'PROFILE_UPDATED', target: null });
  });

  it('a deleted message keeps its history; only the removal is the newest', async () => {
    await agents.ada.delete(api(`/messages/${messageId}`)).expect(204);
    const { items } = await activity('ada', '?limit=100');
    expect(items[0]).toMatchObject({ type: 'MESSAGE_DELETED', target: null });
    // Earlier rows about the message survive, but no longer link to it.
    const aboutMessage = items.filter((i) => i.type.startsWith('MESSAGE_'));
    expect(aboutMessage.map((i) => i.type)).toEqual([
      'MESSAGE_DELETED',
      'MESSAGE_UNSCHEDULED',
      'MESSAGE_RESCHEDULED',
      'MESSAGE_SCHEDULED',
      'MESSAGE_UPDATED',
      'MESSAGE_CREATED',
    ]);
    expect(aboutMessage.every((i) => i.target === null)).toBe(true);
    // The person still exists: still linked.
    expect(items.find((i) => i.type === 'PERSON_ADDED')!.target).toBe(recipientId);
  });

  it('newest first, paginated, owner-only, ids and types only', async () => {
    const all = (await activity('ada', '?limit=100')).items;
    const times = all.map((i) => Date.parse(i.createdAt));
    expect(times).toEqual([...times].sort((a, b) => b - a));
    const page2 = await activity('ada', '?page=2&limit=5');
    expect(page2.pagination).toMatchObject({ page: 2, limit: 5, total: all.length });
    expect(page2.items.map((i) => i.id)).toEqual(all.slice(5, 10).map((i) => i.id));
    await agents.ada.get(api('/users/me/activity?limit=101')).expect(400);
    // Ben sees none of Ada's history, and has none of his own.
    expect(await types('ben')).toEqual([]);
    const body = JSON.stringify(all);
    expect(body).not.toMatch(new RegExp(`${PRIVATE}|Sofia|David|Lake house|For Sofia|ac\\.|@|Daughter|Brother`));
    for (const i of all) expect(Object.keys(i).sort()).toEqual(['createdAt', 'id', 'target', 'type']);
    // Only Customer changes: no queue, storage, security or death-verification events.
    expect(all.every((i) => /^(PERSON|TRUSTED_CONTACT|MESSAGE|MEMORY|STORY_RESPONSE|WISH_RESPONSE|PROFILE|EMAIL)_/.test(i.type))).toBe(true);
  });

  it('history goes with the account', async () => {
    const ben = await prisma.user.findUniqueOrThrow({ where: { email: users.ben } });
    await agents.ben.post(api('/recipients')).send({ firstName: 'Tom' }).expect(201);
    expect(await prisma.customerActivity.count({ where: { userId: ben.id } })).toBe(1);
    await prisma.user.delete({ where: { id: ben.id } });
    expect(await prisma.customerActivity.count({ where: { userId: ben.id } })).toBe(0);
  });
});
