import { ConfigModule } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import session from 'express-session';
import request from 'supertest';
import { adminSignIn } from './admin-sign-in.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { configureApp } from '../src/config/app.setup.js';
import { MessagesModule } from '../src/messages/messages.module.js';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { RecipientsModule } from '../src/recipients/recipients.module.js';

// Real HTTP, validation, guards and PostgreSQL (DATABASE_URL from .env).
// Sessions use MemoryStore so Redis is not needed. Fictional data only; the
// test users are removed afterwards (cascade removes recipients and messages).
describe('Messages (e2e, PostgreSQL)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const run = Date.now();
  const emails = ['lisa', 'john', 'admin'].map(
    (name) => `msg.${name}.${run}@example.test`,
  );
  const password = 'StrongPassword123!';
  const base = '/api/v1/messages';

  const signIn = async (email: string) => {
    const agent = request.agent(app.getHttpServer());
    await agent
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(200);
    return agent;
  };
  const addRecipient = async (
    agent: ReturnType<typeof request.agent>,
    firstName: string,
  ): Promise<string> =>
    (
      await agent
        .post('/api/v1/recipients')
        .send({ firstName, lastName: 'Test', relationship: 'Child' })
        .expect(201)
    ).body.id;

  let lisa: ReturnType<typeof request.agent>;
  let john: ReturnType<typeof request.agent>;
  let sofiaId: string;
  let davidId: string;
  let michaelId: string;
  let messageId: string;
  // GET /messages is a page of summaries: { items, pagination }.
  const ids = (res: { body: { items: { id: string }[] } }) =>
    res.body.items.map((m) => m.id);
  const recipientIds = (res: { body: { recipients: { id: string }[] } }) =>
    res.body.recipients.map((r) => r.id).sort();
  const messageCount = () =>
    prisma.message.count({ where: { owner: { email: emails[0] } } });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        AuthModule,
        RecipientsModule,
        MessagesModule,
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
    davidId = await addRecipient(lisa, 'David');
    michaelId = await addRecipient(john, 'Michael');
  });

  afterAll(async () => {
    await prisma?.user.deleteMany({ where: { email: { in: emails } } });
    await app?.close();
  });

  const forSofia = () => ({
    title: 'For Sofia',
    contentType: 'TEXT',
    textContent: 'I am proud of you.',
    recipientIds: [sofiaId],
  });

  it('requires a session (401)', () =>
    request(app.getHttpServer()).post(base).send(forSofia()).expect(401));

  it('rejects bad input (400)', async () => {
    for (const body of [
      { ...forSofia(), title: '  ' },
      { ...forSofia(), title: null },
      { ...forSofia(), recipientIds: [] },
      { ...forSofia(), recipientIds: [sofiaId, sofiaId] },
      { ...forSofia(), recipientIds: ['not-a-uuid'] },
      { ...forSofia(), ownerUserId: crypto.randomUUID() },
      { ...forSofia(), status: 'RELEASED' },
      // PHOTO/AUDIO/MIXED are valid since Step 8, VIDEO since Phase 12.
      { ...forSofia(), contentType: 'DOCUMENT' },
      { ...forSofia(), contentType: 'text' },
    ]) {
      await lisa.post(base).send(body).expect(400);
    }
    await lisa.get(`${base}/not-a-uuid`).expect(400);
    expect(await messageCount()).toBe(0);
  });

  it('creates DRAFT messages for one and for several own recipients', async () => {
    const one = await lisa.post(base).send(forSofia()).expect(201);
    messageId = one.body.id;
    expect(one.body).toMatchObject({
      title: 'For Sofia',
      contentType: 'TEXT',
      status: 'DRAFT',
      recipients: [
        {
          id: sofiaId,
          firstName: 'Sofia',
          lastName: 'Test',
          relationship: 'Child',
        },
      ],
    });
    for (const hidden of ['ownerUserId', 'deletedAt']) {
      expect(one.body).not.toHaveProperty(hidden);
    }
    expect(Object.keys(one.body.recipients[0]).sort()).toEqual([
      'firstName',
      'id',
      'lastName',
      'relationship',
    ]);

    const both = await lisa
      .post(base)
      .send({
        title: 'For my children',
        textContent: 'Always look after each other.',
        recipientIds: [sofiaId, davidId],
      })
      .expect(201);
    expect(recipientIds(both)).toEqual([sofiaId, davidId].sort());

    const list = await lisa.get(base).expect(200);
    expect(ids(list)).toEqual([both.body.id, messageId]);
    expect((await john.get(base).expect(200)).body).toEqual({
      items: [],
      pagination: { page: 1, limit: 25, total: 0, pages: 0 },
    });
  });

  it('reads and updates own draft', async () => {
    const url = `${base}/${messageId}`;
    await lisa.get(url).expect(200);
    expect(
      (await lisa.patch(url).send({ title: 'For Sofia, always' }).expect(200))
        .body.title,
    ).toBe('For Sofia, always');
    expect(
      (await lisa.patch(url).send({ textContent: 'Still proud.' }).expect(200))
        .body.textContent,
    ).toBe('Still proud.');
    const reassigned = await lisa
      .patch(url)
      .send({ recipientIds: [sofiaId, davidId] })
      .expect(200);
    expect(recipientIds(reassigned)).toEqual([sofiaId, davidId].sort());

    for (const body of [
      { title: null },
      { contentType: null },
      { recipientIds: [] },
      { status: 'RELEASED' },
      { ownerUserId: crypto.randomUUID() },
      { contentType: 'DOCUMENT' },
    ]) {
      await lisa.patch(url).send(body).expect(400);
    }
  });

  it('refuses another customer’s recipient with a generic 400 and writes nothing', async () => {
    const before = await messageCount();
    for (const ids of [[michaelId], [sofiaId, michaelId]]) {
      const res = await lisa
        .post(base)
        .send({ ...forSofia(), recipientIds: ids })
        .expect(400);
      expect(res.body.message).toBe('One or more recipients are invalid.');
      expect(JSON.stringify(res.body)).not.toMatch(/Michael|john|owner/i);
    }
    expect(await messageCount()).toBe(before);

    // A failed reassignment leaves the existing assignments untouched.
    const url = `${base}/${messageId}`;
    await lisa
      .patch(url)
      .send({ title: 'Should not apply', recipientIds: [sofiaId, michaelId] })
      .expect(400);
    const after = await lisa.get(url).expect(200);
    expect(recipientIds(after)).toEqual([sofiaId, davidId].sort());
    expect(after.body.title).toBe('For Sofia, always');
  });

  it('refuses a deleted recipient', async () => {
    const goneId = await addRecipient(lisa, 'Gone');
    await lisa.delete(`/api/v1/recipients/${goneId}`).expect(204);
    await lisa
      .post(base)
      .send({ ...forSofia(), recipientIds: [goneId] })
      .expect(400);
  });

  it('isolates users: John gets a plain 404 for Lisa’s message', async () => {
    const url = `${base}/${messageId}`;
    const responses = [
      await john.get(url).expect(404),
      await john.patch(url).send({ title: 'Hacked' }).expect(404),
      await john.delete(url).expect(404),
    ];
    for (const res of responses) {
      expect(JSON.stringify(res.body)).not.toMatch(/owner|belongs|Sofia/i);
    }
    expect((await lisa.get(url).expect(200)).body.title).toBe(
      'For Sofia, always',
    );
  });

  it('admin sessions are refused (401: the admin cookie is never read here)', async () => {
    await prisma.user.update({
      where: { email: emails[2] },
      data: { role: 'ADMIN' },
    });
    // Step 16: an admin session needs password + TOTP. Its own cookie is never
    // read on Customer routes, so it gets 401 like any other non-Customer.
    const { agent: admin } = await adminSignIn(app, emails[2], password);
    await admin.get(base).expect(401);
    await admin.get(`${base}/${messageId}`).expect(401);
  });

  it('only DRAFT messages can be edited or deleted (409)', async () => {
    const res = await lisa.post(base).send(forSofia()).expect(201);
    await prisma.message.update({
      where: { id: res.body.id },
      data: { status: 'SCHEDULED' },
    });
    const url = `${base}/${res.body.id}`;
    await lisa.patch(url).send({ title: 'Changed' }).expect(409);
    await lisa.delete(url).expect(409);
  });

  it('soft-deletes: row stays in the database but disappears from the API', async () => {
    const url = `${base}/${messageId}`;
    await lisa.delete(url).expect(204);
    await lisa.get(url).expect(404);
    await lisa.patch(url).send({ title: 'X' }).expect(404);
    await lisa.delete(url).expect(404);
    expect(ids(await lisa.get(base).expect(200))).not.toContain(messageId);

    const row = await prisma.message.findUnique({
      where: { id: messageId },
      include: { recipients: true },
    });
    expect(row?.deletedAt).toBeInstanceOf(Date);
    expect(row?.recipients).toHaveLength(2);
  });

  it('lists a stable page of summaries: no full text, no internals', async () => {
    // John's own messages; Lisa's must never show up or be counted.
    const longText = `${'Dear Michael, '.repeat(100)}THE-END-${run}`;
    const created: string[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await john
        .post(base)
        .send({
          title: `Page test ${i}`,
          textContent: i === 0 ? longText : `Short ${i}`,
          recipientIds: [michaelId],
        })
        .expect(201);
      created.push(res.body.id);
    }
    const gone = (
      await john
        .post(base)
        .send({ title: 'Deleted', recipientIds: [michaelId] })
        .expect(201)
    ).body.id;
    await john.delete(`${base}/${gone}`).expect(204);
    // Same createdAt for all: the id tiebreaker alone must keep pages stable.
    await prisma.message.updateMany({
      where: { id: { in: created } },
      data: { createdAt: new Date('2026-01-01T00:00:00Z') },
    });
    const expected = [...created].sort().reverse();

    const page1 = await john.get(`${base}?page=1&limit=2`).expect(200);
    expect(page1.body.pagination).toEqual({
      page: 1,
      limit: 2,
      total: 5,
      pages: 3,
    });
    const page2 = await john.get(`${base}?page=2&limit=2`).expect(200);
    const page3 = await john.get(`${base}?page=3&limit=2`).expect(200);
    expect([...ids(page1), ...ids(page2), ...ids(page3)]).toEqual(expected);
    // Repeating a request gives the same page.
    expect(ids(await john.get(`${base}?page=2&limit=2`).expect(200))).toEqual(
      ids(page2),
    );

    const past = await john.get(`${base}?page=9&limit=2`).expect(200);
    expect(past.body).toEqual({
      items: [],
      pagination: { page: 9, limit: 2, total: 5, pages: 3 },
    });

    // Defaults and the maximum page size.
    const all = await john.get(base).expect(200);
    expect(all.body.pagination).toMatchObject({ page: 1, limit: 25 });
    expect(ids(all)).toEqual(expected);
    expect(ids(all)).not.toContain(gone);
    expect(
      (await john.get(`${base}?limit=100`).expect(200)).body.pagination.limit,
    ).toBe(100);
    for (const query of [
      'limit=101',
      'limit=0',
      'page=0',
      'page=-1',
      'page=abc',
      'limit=1.5',
      'page=',
    ]) {
      await john.get(`${base}?${query}`).expect(400);
    }

    // Summary shape: only what the list renders.
    const item = all.body.items.find(
      (m: { id: string }) => m.id === created[0],
    );
    expect(Object.keys(item).sort()).toEqual([
      'contentType',
      'id',
      'recipients',
      'status',
      'textPreview',
      'title',
      'updatedAt',
    ]);
    expect(item.textPreview).toHaveLength(201);
    expect(item.textPreview.endsWith('…')).toBe(true);
    expect(Object.keys(item.recipients[0]).sort()).toEqual([
      'firstName',
      'id',
      'lastName',
      'relationship',
    ]);
    const raw = JSON.stringify(all.body);
    expect(raw).not.toContain(`THE-END-${run}`);
    expect(raw).not.toMatch(
      /textContent|ownerUserId|deletedAt|storageKey|url/i,
    );

    // The detail endpoint still returns the full text.
    const detail = await john.get(`${base}/${created[0]}`).expect(200);
    expect(detail.body.textContent).toBe(longText);

    // Lisa's list never includes John's messages, and vice versa.
    const lisaIds = ids(await lisa.get(`${base}?limit=100`).expect(200));
    expect(lisaIds.some((id) => created.includes(id))).toBe(false);
    expect((await lisa.get(base).expect(200)).body.pagination.total).toBe(
      lisaIds.length,
    );
  });
});
