import { ConfigModule } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import session from 'express-session';
import request from 'supertest';
import { AuthModule } from '../src/auth/auth.module.js';
import { configureApp } from '../src/config/app.setup.js';
import { DraftRecoveryModule } from '../src/draft-recovery/draft-recovery.module.js';
import { MessagesModule } from '../src/messages/messages.module.js';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { RecipientsModule } from '../src/recipients/recipients.module.js';

// Message version history: real HTTP, guards and PostgreSQL. Fictional data
// only; the test users are removed afterwards (cascade removes messages,
// versions and drafts).
describe('Message version history (e2e, PostgreSQL)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const run = Date.now();
  const emails = ['lisa', 'john'].map((n) => `ver.${n}.${run}@example.test`);
  const password = 'StrongPassword123!';
  const base = '/api/v1/messages';
  // Everything the app logs, to prove no private text is ever logged.
  const logged: unknown[] = [];
  const capture = (...args: unknown[]) => void logged.push(args);
  const SECRET = `Fictional private words ${run}`;

  let lisa: ReturnType<typeof request.agent>;
  let john: ReturnType<typeof request.agent>;
  let sofiaId: string;

  const signIn = async (email: string) => {
    const agent = request.agent(app.getHttpServer());
    await agent.post('/api/v1/auth/login').send({ email, password }).expect(200);
    return agent;
  };
  const newMessage = async (textContent: string, title = 'For Sofia') =>
    (
      await lisa
        .post(base)
        .send({ title, contentType: 'TEXT', textContent, recipientIds: [sofiaId] })
        .expect(201)
    ).body as { id: string; version: number };
  const versions = async (id: string, agent = lisa) =>
    (await agent.get(`${base}/${id}/versions`).expect(200)).body.items as {
      id: string;
      version: number;
      reason: string;
      isCurrent: boolean;
    }[];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        AuthModule,
        RecipientsModule,
        MessagesModule,
        DraftRecoveryModule,
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    app.useLogger({ log: capture, error: capture, warn: capture, debug: capture, verbose: capture });
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
    sofiaId = (
      await lisa
        .post('/api/v1/recipients')
        .send({ firstName: 'Sofia', lastName: 'Test', relationship: 'Child' })
        .expect(201)
    ).body.id;
  });

  afterAll(async () => {
    await prisma?.user.deleteMany({ where: { email: { in: emails } } });
    await app?.close();
  });

  it('creating a message saves version 1 (CREATED); the response carries the current version', async () => {
    const m = await newMessage('First words.');
    expect(m.version).toBe(1);
    const list = await versions(m.id);
    expect(list).toEqual([
      { id: expect.any(String), version: 1, reason: 'CREATED', createdAt: expect.any(String), isCurrent: true },
    ]);
  });

  it('a meaningful edit adds the next version; a no-op save (or recipients only) adds none', async () => {
    const m = await newMessage('A');
    await lisa.patch(`${base}/${m.id}`).send({ textContent: 'B' }).expect(200);
    await lisa.patch(`${base}/${m.id}`).send({ textContent: 'B' }).expect(200);
    await lisa.patch(`${base}/${m.id}`).send({ recipientIds: [sofiaId] }).expect(200);
    const list = await versions(m.id);
    expect(list.map((v) => [v.version, v.reason, v.isCurrent])).toEqual([
      [2, 'EDITED', true],
      [1, 'CREATED', false],
    ]);
  });

  it('the list is metadata only, newest first; a version is read on its own', async () => {
    const m = await newMessage('Old text.', 'Old title');
    await lisa.patch(`${base}/${m.id}`).send({ title: 'New title', textContent: 'New text.' }).expect(200);
    const [newest, oldest] = await versions(m.id);
    expect(newest.version).toBe(2);
    expect(Object.keys(newest).sort()).toEqual(['createdAt', 'id', 'isCurrent', 'reason', 'version']);
    const detail = (await lisa.get(`${base}/${m.id}/versions/${oldest.id}`).expect(200)).body;
    expect(detail).toEqual({
      id: oldest.id,
      version: 1,
      reason: 'CREATED',
      createdAt: expect.any(String),
      isCurrent: false,
      title: 'Old title',
      contentType: 'TEXT',
      textContent: 'Old text.',
    });
  });

  it('restoring keeps the current content in history and records the restore as a new version', async () => {
    const m = await newMessage('Version A');
    await lisa.patch(`${base}/${m.id}`).send({ textContent: 'Version B' }).expect(200);
    const [, a] = await versions(m.id);
    const restored = (await lisa.post(`${base}/${m.id}/versions/${a.id}/restore`).expect(200)).body;
    expect(restored).toMatchObject({ id: m.id, status: 'DRAFT', textContent: 'Version A', version: 3 });
    expect(restored.recipients.map((r: { id: string }) => r.id)).toEqual([sofiaId]);
    const list = await versions(m.id);
    expect(list.map((v) => [v.version, v.reason])).toEqual([
      [3, 'RESTORED'],
      [2, 'EDITED'],
      [1, 'CREATED'],
    ]);
    // Version B is still there to go back to.
    const b = (await lisa.get(`${base}/${m.id}/versions/${list[1].id}`).expect(200)).body;
    expect(b.textContent).toBe('Version B');
    // Recent changes: one "earlier version restored", ids only.
    const activity = await prisma.customerActivity.findMany({
      where: { user: { email: emails[0] }, type: 'MESSAGE_VERSION_RESTORED' },
    });
    expect(activity).toEqual([expect.objectContaining({ entityId: m.id })]);
  });

  it('restoring the content that is already current changes nothing', async () => {
    const m = await newMessage('Same');
    const [v1] = await versions(m.id);
    await lisa.post(`${base}/${m.id}/versions/${v1.id}/restore`).expect(200);
    expect(await versions(m.id)).toHaveLength(1);
  });

  it('a message from before version history: its old content becomes version 1 on the next save', async () => {
    const m = await newMessage('Legacy text');
    await prisma.messageVersion.deleteMany({ where: { messageId: m.id } });
    expect((await lisa.get(`${base}/${m.id}`).expect(200)).body.version).toBe(0);
    expect(await versions(m.id)).toEqual([]);
    await lisa.patch(`${base}/${m.id}`).send({ textContent: 'Edited' }).expect(200);
    const list = await versions(m.id);
    expect(list.map((v) => v.version)).toEqual([2, 1]);
    const v1 = (await lisa.get(`${base}/${m.id}/versions/${list[1].id}`).expect(200)).body;
    expect(v1.textContent).toBe('Legacy text');
  });

  it('SCHEDULED and RELEASED: history is readable, restore is 409 and nothing changes', async () => {
    const m = await newMessage('Kept as is');
    await lisa.patch(`${base}/${m.id}`).send({ textContent: 'Scheduled text' }).expect(200);
    const [, v1] = await versions(m.id);
    // Scheduling itself is covered by the schedules suite; only the status matters here.
    const scheduledFor = new Date(Date.now() + 86_400_000);
    await prisma.message.update({
      where: { id: m.id },
      data: { status: 'SCHEDULED', schedule: { create: { triggerType: 'FIXED_DATE', scheduledFor } } },
    });
    for (const status of ['SCHEDULED', 'RELEASED'] as const) {
      await prisma.message.update({ where: { id: m.id }, data: { status } });
      await lisa.post(`${base}/${m.id}/versions/${v1.id}/restore`).expect(409);
      expect(await versions(m.id)).toHaveLength(2);
      const after = await prisma.message.findUniqueOrThrow({
        where: { id: m.id },
        include: { schedule: true, recipients: true },
      });
      expect(after).toMatchObject({ status, textContent: 'Scheduled text' });
      expect(after.schedule?.scheduledFor).toEqual(scheduledFor);
      expect(after.recipients.map((r) => r.recipientId)).toEqual([sofiaId]);
    }
  });

  it("another Customer can't list, read or restore Lisa's versions (404, nothing changes)", async () => {
    const m = await newMessage('Only for Lisa');
    await lisa.patch(`${base}/${m.id}`).send({ textContent: 'Lisa edit' }).expect(200);
    const [, v1] = await versions(m.id);
    await john.get(`${base}/${m.id}/versions`).expect(404);
    await john.get(`${base}/${m.id}/versions/${v1.id}`).expect(404);
    await john.post(`${base}/${m.id}/versions/${v1.id}/restore`).expect(404);
    // A version id under a message of his own is also 404.
    const johnRecipient = (
      await john
        .post('/api/v1/recipients')
        .send({ firstName: 'Mia', lastName: 'Test', relationship: 'Child' })
        .expect(201)
    ).body.id;
    const his = (
      await john
        .post(base)
        .send({ title: 'His', contentType: 'TEXT', textContent: 'x', recipientIds: [johnRecipient] })
        .expect(201)
    ).body;
    await john.get(`${base}/${his.id}/versions/${v1.id}`).expect(404);
    await john.post(`${base}/${his.id}/versions/${v1.id}/restore`).expect(404);
    expect((await lisa.get(`${base}/${m.id}`).expect(200)).body.textContent).toBe('Lisa edit');
    await request(app.getHttpServer()).get(`${base}/${m.id}/versions`).expect(401);
  });

  it('concurrent saves never share or skip a version number', async () => {
    const m = await newMessage('Start');
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => lisa.patch(`${base}/${m.id}`).send({ textContent: `Parallel ${i}` })),
    );
    expect(results.map((r) => r.status)).toEqual(Array(6).fill(200));
    const numbers = (await versions(m.id)).map((v) => v.version);
    expect(numbers).toEqual([7, 6, 5, 4, 3, 2, 1]);
  });

  it('never logs or audits private text', async () => {
    const m = await newMessage(SECRET);
    await lisa.patch(`${base}/${m.id}`).send({ textContent: `${SECRET} edited` }).expect(200);
    const [, v1] = await versions(m.id);
    await lisa.post(`${base}/${m.id}/versions/${v1.id}/restore`).expect(200);
    await lisa
      .put(`/api/v1/users/me/drafts/MESSAGE/${m.id}`)
      .send({ payload: { title: 'For Sofia', contentType: 'TEXT', textContent: `${SECRET} unsaved` }, baseRevision: '3' })
      .expect(200);
    expect(JSON.stringify(logged)).not.toContain(SECRET);
    const audit = await prisma.auditLog.findMany({ select: { metadata: true } });
    expect(JSON.stringify(audit)).not.toContain(SECRET);
  });
});
