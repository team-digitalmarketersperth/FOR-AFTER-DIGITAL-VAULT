import { ConfigModule } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import { Queue } from 'bullmq';
import { randomBytes } from 'node:crypto';
import session from 'express-session';
import request from 'supertest';
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
import { ReadinessModule } from '../src/readiness/readiness.module.js';
import { RecipientsModule } from '../src/recipients/recipients.module.js';
import { RedisModule } from '../src/redis/redis.module.js';
import { TrustedContactsModule } from '../src/trusted-contacts/trusted-contacts.module.js';

// Dashboard readiness end to end: real HTTP, guards and PostgreSQL. Five setup
// steps, 20 points each, derived from the Customer's own rows. Fictional data
// only; both test users (and everything they own) are deleted afterwards.
describe('Readiness (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let releaseQueue: Queue;
  const run = Date.now();
  const users = { ada: `rd.ada.${run}@example.test`, ben: `rd.ben.${run}@example.test` };
  const password = 'StrongPassword123!';
  const releaseQueueName = `test-rd-release-${run}`;
  const api = (path: string) => `/api/v1${path}`;
  const agents: Record<string, ReturnType<typeof request.agent>> = {};
  const readiness = async (who = 'ada') => (await agents[who].get(api('/users/me/readiness')).expect(200)).body;
  const step = async (key: string, who = 'ada') =>
    (await readiness(who)).steps.find((s: { key: string }) => s.key === key);

  beforeAll(async () => {
    process.env.RELEASE_QUEUE_NAME = releaseQueueName;
    process.env.RELEASE_RECONCILE_INTERVAL_SECONDS = '3600';
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        RedisModule,
        AuthModule,
        MediaModule,
        RecipientsModule,
        TrustedContactsModule,
        MessagesModule,
        MessageSchedulesModule,
        MemoryVaultModule,
        MyStoryModule,
        MyWishesModule,
        ReadinessModule,
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

  it('needs a Customer session', async () => {
    await request(app.getHttpServer()).get(api('/users/me/readiness')).expect(401);
  });

  it('a new account: 0 of 5, nothing claimed, no nonsensical counts', async () => {
    expect(await readiness()).toEqual({
      score: 0,
      completedSteps: 0,
      totalSteps: 5,
      steps: [
        { key: 'PEOPLE', complete: false, people: 0 },
        { key: 'TRUSTED_CONTACTS', complete: false, trustedContacts: 0, ready: 0 },
        { key: 'PRESERVED', complete: false, messages: 0, memories: 0, storyAnswers: 0 },
        { key: 'SCHEDULING', complete: false, messages: 0, needsScheduling: 0 },
        { key: 'WISHES', complete: false, wishes: 0 },
      ],
    });
  });

  let recipientId: string;
  it('people: a removed person does not count; an active one gives +20', async () => {
    const removed = (await agents.ada.post(api('/recipients')).send({ firstName: 'Old' }).expect(201)).body.id;
    expect((await readiness()).score).toBe(20);
    await agents.ada.delete(api(`/recipients/${removed}`)).expect(204);
    expect(await step('PEOPLE')).toEqual({ key: 'PEOPLE', complete: false, people: 0 });
    recipientId = (await agents.ada.post(api('/recipients')).send({ firstName: 'Sofia' }).expect(201)).body.id;
    expect(await step('PEOPLE')).toEqual({ key: 'PEOPLE', complete: true, people: 1 });
  });

  // Approved 2026-10-14: complete only with a READY contact (accepted invitation), the
  // definition the Trusted Contacts page shows. Declined, pending and unsent don't count.
  it('trusted contacts: only a READY (accepted) contact gives +20; removed, declined and unsent do not', async () => {
    const declined = (
      await agents.ada.post(api('/trusted-contacts')).send({ firstName: 'Dee', email: `rd.dee.${run}@example.test` }).expect(201)
    ).body.id;
    await prisma.trustedContactInvitation.create({
      data: {
        trustedContactId: declined,
        emailNormalized: `rd.dee.${run}@example.test`,
        tokenHash: randomBytes(32).toString('hex'),
        status: 'DECLINED',
        declinedAt: new Date(),
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    expect(await step('TRUSTED_CONTACTS')).toMatchObject({ complete: false, trustedContacts: 1, ready: 0 });
    await agents.ada.delete(api(`/trusted-contacts/${declined}`)).expect(204);
    const davidEmail = `rd.david.${run}@example.test`;
    const david = (await agents.ada.post(api('/trusted-contacts')).send({ firstName: 'David', email: davidEmail }).expect(201)).body.id;
    // Added, but not yet accepted (the test email provider sends nothing): not ready.
    expect(await step('TRUSTED_CONTACTS')).toEqual({ key: 'TRUSTED_CONTACTS', complete: false, trustedContacts: 1, ready: 0 });
    await prisma.trustedContactInvitation.create({
      data: {
        trustedContactId: david,
        emailNormalized: davidEmail,
        tokenHash: randomBytes(32).toString('hex'),
        status: 'ACCEPTED',
        acceptedAt: new Date(),
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    expect(await step('TRUSTED_CONTACTS')).toEqual({ key: 'TRUSTED_CONTACTS', complete: true, trustedContacts: 1, ready: 1 });
    expect((await readiness()).score).toBe(40);
  });

  let draftId: string;
  it('a draft message: content preserved (+20), and it needs scheduling', async () => {
    draftId = (
      await agents.ada
        .post(api('/messages'))
        .send({ title: 'For Sofia', textContent: 'Fictional words.', recipientIds: [recipientId] })
        .expect(201)
    ).body.id;
    expect(await step('PRESERVED')).toMatchObject({ complete: true, messages: 1 });
    expect(await step('SCHEDULING')).toEqual({ key: 'SCHEDULING', complete: false, messages: 1, needsScheduling: 1 });
    expect((await readiness()).score).toBe(60);
  });

  it('scheduling: scheduled and released messages have timing; deleted drafts are ignored', async () => {
    await agents.ada
      .post(api(`/messages/${draftId}/schedule`))
      .send({ triggerType: 'FIXED_DATE', scheduledFor: new Date(Date.now() + 365 * 86_400_000).toISOString() })
      .expect(201);
    expect(await step('SCHEDULING')).toEqual({ key: 'SCHEDULING', complete: true, messages: 1, needsScheduling: 0 });
    // A released message (as after a release) never "needs scheduling".
    const released = await prisma.message.create({
      data: { ownerUserId: (await prisma.user.findUniqueOrThrow({ where: { email: users.ada } })).id, title: 'Sent', status: 'RELEASED' },
    });
    // A deleted draft is gone from every count.
    const gone = (
      await agents.ada.post(api('/messages')).send({ title: 'Never mind', recipientIds: [recipientId] }).expect(201)
    ).body.id;
    expect((await step('SCHEDULING')).needsScheduling).toBe(1);
    await agents.ada.delete(api(`/messages/${gone}`)).expect(204);
    expect(await step('SCHEDULING')).toEqual({ key: 'SCHEDULING', complete: true, messages: 2, needsScheduling: 0 });
    expect((await readiness()).score).toBe(80);
    await prisma.message.delete({ where: { id: released.id } });
  });

  it('memories and story answers count as preserved content too', async () => {
    await agents.ada.post(api('/memory-vault')).send({ title: 'Lake house', category: 'FAMILY', textContent: 'Fictional.' }).expect(201);
    await agents.ada.put(api('/my-story/prompts/childhood.earliest-memory/response')).send({ textContent: 'Fictional answer.' }).expect(200);
    expect(await step('PRESERVED')).toEqual({ key: 'PRESERVED', complete: true, messages: 1, memories: 1, storyAnswers: 1 });
  });

  it('wishes: one answered wish → 100, with no notice acknowledgement', async () => {
    expect(await step('WISHES')).toEqual({ key: 'WISHES', complete: false, wishes: 0 });
    await agents.ada.put(api('/my-wishes/prompts/ceremony.style/response')).send({ textContent: 'Something quiet. Fictional.' }).expect(200);
    expect(await readiness()).toMatchObject({ score: 100, completedSteps: 5 });
    // Removing the only wish takes the step back.
    await agents.ada.delete(api('/my-wishes/prompts/ceremony.style/response')).expect(204);
    expect((await readiness()).score).toBe(80);
  });

  it('only the Customer’s own data, counts only: no names, emails, titles or text', async () => {
    expect((await readiness('ben')).score).toBe(0);
    const body = JSON.stringify(await readiness());
    expect(body).not.toMatch(/Sofia|David|rd\.|For Sofia|Fictional|Lake house|@/);
  });

  it('reads counts, never content rows', async () => {
    const spies = [prisma.message, prisma.memoryVaultItem, prisma.myStoryResponse, prisma.myWishResponse, prisma.recipient].map((m) =>
      vi.spyOn(m, 'findMany'),
    );
    await readiness();
    for (const s of spies) {
      expect(s).not.toHaveBeenCalled();
      s.mockRestore();
    }
  });
});
