import { ConfigModule } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import { Queue } from 'bullmq';
import { randomBytes, randomUUID } from 'node:crypto';
import session from 'express-session';
import request from 'supertest';
import { AttentionModule } from '../src/attention/attention.module.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { configureApp } from '../src/config/app.setup.js';
import { MessageSchedulesModule } from '../src/message-schedules/message-schedules.module.js';
import { MessagesModule } from '../src/messages/messages.module.js';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { RecipientsModule } from '../src/recipients/recipients.module.js';
import { RedisModule } from '../src/redis/redis.module.js';
import { TrustedContactsModule } from '../src/trusted-contacts/trusted-contacts.module.js';

// "Needs your attention" end to end: real HTTP, guards and PostgreSQL. Each
// item appears from real state and disappears when the Customer fixes it.
// Storage uses a 1000-byte test limit and synthetic READY rows (no provider).
// Fictional data only; both users and everything they own are deleted after.
describe('Attention (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let releaseQueue: Queue;
  const run = Date.now();
  const users = { ada: `at.ada.${run}@example.test`, ben: `at.ben.${run}@example.test` };
  const password = 'StrongPassword123!';
  const releaseQueueName = `test-at-release-${run}`;
  const api = (path: string) => `/api/v1${path}`;
  const agents: Record<string, ReturnType<typeof request.agent>> = {};
  type Item = { key: string; title: string; priority: string; description: string | null };
  const attention = async (who = 'ada') =>
    (await agents[who].get(api('/users/me/attention')).expect(200)).body as { items: Item[]; total: number };
  const titles = async (who = 'ada') => (await attention(who)).items.map((i) => i.title);
  const userId = (email: string) => prisma.user.findUniqueOrThrow({ where: { email } }).then((u) => u.id);
  const invitation = (trustedContactId: string, email: string, status: 'PENDING' | 'ACCEPTED') =>
    prisma.trustedContactInvitation.create({
      data: {
        trustedContactId,
        emailNormalized: email,
        tokenHash: randomBytes(32).toString('hex'),
        status,
        acceptedAt: status === 'ACCEPTED' ? new Date() : null,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });

  beforeAll(async () => {
    process.env.RELEASE_QUEUE_NAME = releaseQueueName;
    process.env.RELEASE_RECONCILE_INTERVAL_SECONDS = '3600';
    process.env.STORAGE_LIMIT_BYTES = '1000';
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
        AttentionModule,
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
    delete process.env.STORAGE_LIMIT_BYTES;
    await prisma?.user.deleteMany({ where: { email: { in: Object.values(users) } } });
    await app?.close();
    await releaseQueue?.obliterate({ force: true });
    await releaseQueue?.close();
  });

  it('needs a Customer session', async () => {
    await request(app.getHttpServer()).get(api('/users/me/attention')).expect(401);
  });

  it('a new account: nothing needs attention (no zero-contact item; readiness covers setup)', async () => {
    expect(await attention()).toEqual({ items: [], total: 0 });
  });

  let sofia: string;
  let drafts: string[];
  it('messages needing timing: aggregated; scheduling one updates the count; released and deleted never count', async () => {
    sofia = (await agents.ada.post(api('/recipients')).send({ firstName: 'Sofia', birthday: '1990-05-05' }).expect(201)).body.id;
    drafts = [];
    for (const title of ['One', 'Two', 'Gone'])
      drafts.push((await agents.ada.post(api('/messages')).send({ title, textContent: 'Fictional words.', recipientIds: [sofia] }).expect(201)).body.id);
    expect(await titles()).toEqual(['3 messages need timing']);
    await agents.ada.delete(api(`/messages/${drafts[2]}`)).expect(204);
    await prisma.message.create({ data: { ownerUserId: await userId(users.ada), title: 'Sent', status: 'RELEASED' } });
    expect(await titles()).toEqual(['2 messages need timing']);
    await agents.ada
      .post(api(`/messages/${drafts[0]}/schedule`))
      .send({ triggerType: 'FIXED_DATE', scheduledFor: new Date(Date.now() + 365 * 86_400_000).toISOString() })
      .expect(201);
    expect(await titles()).toEqual(['1 message needs timing']);
  });

  it('Trusted Contact: pending is named; accepting (READY) removes it; a removed contact never shows', async () => {
    const email = `at.james.${run}@example.test`;
    const james = (await agents.ada.post(api('/trusted-contacts')).send({ firstName: 'James', email }).expect(201)).body.id;
    await invitation(james, email, 'PENDING');
    expect(await titles()).toContain('James hasn’t accepted the invitation yet');
    await prisma.trustedContactInvitation.updateMany({
      where: { trustedContactId: james },
      data: { status: 'ACCEPTED', acceptedAt: new Date() },
    });
    expect((await titles()).some((t) => t.includes('James'))).toBe(false);

    const otherEmail = `at.dee.${run}@example.test`;
    const dee = (await agents.ada.post(api('/trusted-contacts')).send({ firstName: 'Dee', email: otherEmail }).expect(201)).body.id;
    await invitation(dee, otherEmail, 'PENDING');
    expect(await titles()).toContain('Dee hasn’t accepted the invitation yet');
    await agents.ada.delete(api(`/trusted-contacts/${dee}`)).expect(204);
    expect((await titles()).some((t) => t.includes('Dee'))).toBe(false);
  });

  it('missing birthday: only when a scheduled BIRTHDAY message needs it; adding it back resolves it', async () => {
    // A missing birthday on someone without a birthday message is not surfaced.
    await agents.ada.post(api('/recipients')).send({ firstName: 'Noah' }).expect(201);
    expect((await titles()).some((t) => t.includes('Noah'))).toBe(false);

    await agents.ada
      .post(api(`/messages/${drafts[1]}/schedule`))
      .send({ triggerType: 'BIRTHDAY', timezone: 'Australia/Perth', localTime: '09:00' })
      .expect(201);
    await agents.ada.patch(api(`/recipients/${sofia}`)).send({ birthday: null }).expect(200);
    const item = (await attention()).items.find((i) => i.key === `RECIPIENT_BIRTHDAY_MISSING:${sofia}`);
    expect(item).toMatchObject({
      title: 'Sofia is missing a birthday',
      description: 'Needed for 1 scheduled birthday message.',
      priority: 'MEDIUM',
    });
    await agents.ada.patch(api(`/recipients/${sofia}`)).send({ birthday: '1990-05-05' }).expect(200);
    expect((await titles()).some((t) => t.includes('Sofia'))).toBe(false);
  });

  it('storage: 80% LOW, 90% HIGH, full HIGH, and freeing space removes it', async () => {
    const ownerUserId = await userId(users.ada);
    const file = (sizeBytes: number) =>
      prisma.mediaAsset.create({
        data: {
          ownerUserId,
          messageId: drafts[0],
          kind: 'PHOTO',
          status: 'READY',
          storageKey: `test/attention/${randomUUID()}.jpg`,
          originalFileName: 'synthetic.jpg',
          mimeType: 'image/jpeg',
          sizeBytes,
        },
      });
    const storage = async () => (await attention()).items.find((i) => i.key === 'STORAGE');
    expect(await storage()).toBeUndefined();
    const a = await file(840);
    expect(await storage()).toMatchObject({ title: 'Storage is 84% full', priority: 'LOW' });
    const b = await file(90);
    expect(await storage()).toMatchObject({ title: 'Storage is 93% full', priority: 'HIGH' });
    // HIGH sorts first.
    expect((await attention()).items[0].key).toBe('STORAGE');
    const c = await file(70);
    expect(await storage()).toMatchObject({ title: 'Storage is full', priority: 'HIGH' });
    // Deleted files stop counting (the Storage Manager's soft delete).
    await prisma.mediaAsset.updateMany({ where: { id: { in: [b.id, c.id] } }, data: { deletedAt: new Date() } });
    expect(await storage()).toMatchObject({ priority: 'LOW' });
    await prisma.mediaAsset.update({ where: { id: a.id }, data: { deletedAt: new Date() } });
    expect(await storage()).toBeUndefined();
  });

  it('only the Customer’s own items; safe fields only', async () => {
    expect(await attention('ben')).toEqual({ items: [], total: 0 });
    const body = JSON.stringify(await attention());
    expect(body).not.toMatch(/@|token|otp|privateNote|death|verif|evidence|textContent|storageKey/i);
  });
});
