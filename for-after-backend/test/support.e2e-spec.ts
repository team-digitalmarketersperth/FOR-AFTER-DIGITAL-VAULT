import { ConfigModule } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import session from 'express-session';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { adminSignIn } from './admin-sign-in.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { configureApp } from '../src/config/app.setup.js';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { SupportModule } from '../src/support/support.module.js';

// Step 7 support: real HTTP, guards, validation, sessions, PostgreSQL and the
// Redis throttler. Fictional people and text only; nothing is sent anywhere.
describe('Support requests (e2e, PostgreSQL)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const run = Date.now();
  const emails = ['lisa', 'john', 'admin'].map((name) => `support.${name}.${run}@example.test`);
  const password = 'StrongPassword123!';
  const mine = '/api/v1/support/requests';
  const inbox = '/api/v1/admin/support/requests';
  const SUBJECT = `Cannot add a photo ${run}`;
  const DESCRIPTION = `The upload button spins forever on my memory page ${run}.`;
  const NOTE = `Internal: checked the scanner logs ${run}`;
  const REPLY = `Thanks, we are looking into it ${run}`;

  type Agent = ReturnType<typeof request.agent>;
  let lisa: Agent;
  let john: Agent;
  let admin: Agent;
  let lisaId: string;
  let adminId: string;
  let requestId: string;
  const signIn = async (email: string) => {
    const agent = request.agent(app.getHttpServer());
    await agent.post('/api/v1/auth/login').send({ email, password }).expect(200);
    return agent;
  };
  const create = (agent: Agent, over: object = {}) =>
    agent.post(mine).send({ clientRequestId: randomUUID(), subject: SUBJECT, category: 'UPLOADS_STORAGE', description: DESCRIPTION, ...over });
  const status = (to: string, expected: string) =>
    admin.patch(`${inbox}/${requestId}/status`).send({ status: to, expectedStatus: expected });

  beforeAll(async () => {
    // Own throttle counters per run, so the rate-limit test never leaks into reruns.
    process.env.THROTTLE_KEY_PREFIX = `for_after:test_support_throttle:${run}:`;
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule, AuthModule, SupportModule],
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
    await prisma.user.update({ where: { email: emails[2] }, data: { role: 'ADMIN' } });
    lisa = await signIn(emails[0]);
    john = await signIn(emails[1]);
    ({ agent: admin } = await adminSignIn(app, emails[2], password));
    lisaId = (await prisma.user.findUniqueOrThrow({ where: { email: emails[0] } })).id;
    adminId = (await prisma.user.findUniqueOrThrow({ where: { email: emails[2] } })).id;
  });

  afterAll(async () => {
    delete process.env.THROTTLE_KEY_PREFIX;
    await prisma?.user.deleteMany({ where: { email: { in: emails } } });
    await app?.close();
  });

  it('principals: anonymous 401; admins cannot use the Customer routes; Customers cannot use the inbox', async () => {
    const anon = request(app.getHttpServer());
    await anon.get(mine).expect(401);
    await anon.post(mine).send({}).expect(401);
    await anon.get(inbox).expect(401);
    await admin.get(mine).expect(401);
    await admin.post(mine).send({}).expect(401);
    await lisa.get(inbox).expect(401);
    await lisa.post(`${inbox}/${randomUUID()}/notes`).send({ clientRequestId: randomUUID(), body: 'x' }).expect(401);
    // A password-only admin challenge has no session at all.
    const half = request.agent(app.getHttpServer());
    await prisma.user.update({ where: { email: emails[1] }, data: { role: 'ADMIN' } });
    await half.post('/api/v1/auth/login').send({ email: emails[1], password }).expect(200);
    await half.get(inbox).expect(401);
    await prisma.user.update({ where: { email: emails[1] }, data: { role: 'CUSTOMER' } });
  });

  it('create: validated plain text; owner and status from the server; a retry returns the first; no-store', async () => {
    // Forged owner/status/author fields are refused outright.
    for (const extra of [{ ownerUserId: randomUUID() }, { status: 'RESOLVED' }, { authorRole: 'ADMIN' }]) {
      await create(lisa, extra).expect(400);
    }
    await create(lisa, { subject: 'x'.repeat(151) }).expect(400);
    await create(lisa, { description: 'short' }).expect(400);
    await create(lisa, { category: 'BILLING' }).expect(400);
    await create(lisa, { clientRequestId: 'not-a-uuid' }).expect(400);

    const clientRequestId = randomUUID();
    const first = await create(lisa, { clientRequestId }).expect(201);
    expect(first.headers['cache-control']).toBe('no-store');
    expect(first.body).toEqual({
      id: expect.any(String),
      subject: SUBJECT,
      category: 'UPLOADS_STORAGE',
      status: 'OPEN',
      description: DESCRIPTION,
      createdAt: expect.any(String),
      lastPublicActivityAt: expect.any(String),
      messages: [],
    });
    requestId = first.body.id;
    const retry = await create(lisa, { clientRequestId }).expect(201);
    expect(retry.body.id).toBe(requestId);
    expect(await prisma.supportRequest.count({ where: { ownerUserId: lisaId } })).toBe(1);
    const row = await prisma.supportRequest.findUniqueOrThrow({ where: { id: requestId } });
    expect(row.ownerUserId).toBe(lisaId);
  });

  it("ownership: another Customer can't list, read or follow up (404, nothing revealed)", async () => {
    const list = await john.get(mine).expect(200);
    expect(list.body).toEqual({ items: [], pagination: { page: 1, limit: 25, total: 0, pages: 0 } });
    const read = await john.get(`${mine}/${requestId}`).expect(404);
    const missing = await john.get(`${mine}/${randomUUID()}`).expect(404);
    expect(read.body.message).toBe(missing.body.message);
    await john.post(`${mine}/${requestId}/messages`).send({ clientRequestId: randomUUID(), body: 'hi' }).expect(404);
    expect(JSON.stringify(read.body)).not.toContain(SUBJECT);
  });

  it('internal notes: admin-only, never in Customer responses, totals or public times', async () => {
    const before = (await lisa.get(`${mine}/${requestId}`).expect(200)).body;
    const noted = await admin.post(`${inbox}/${requestId}/notes`).send({ clientRequestId: randomUUID(), body: NOTE }).expect(201);
    expect(noted.body.internalNotes).toEqual([{ id: expect.any(String), authorUserId: adminId, body: NOTE, createdAt: expect.any(String) }]);
    expect(noted.body.status).toBe('OPEN');
    const after = await lisa.get(`${mine}/${requestId}`).expect(200);
    expect(after.body).toEqual(before);
    const list = await lisa.get(mine).expect(200);
    expect(JSON.stringify([after.body, list.body])).not.toMatch(new RegExp(`${run}.*Internal|scanner logs|internalNotes`));
    expect(list.body.items[0].lastPublicActivityAt).toBe(before.lastPublicActivityAt);
  });

  it('public reply: visible to the Customer as "support" (no admin identity); status unchanged', async () => {
    const before = (await lisa.get(`${mine}/${requestId}`).expect(200)).body;
    await new Promise((r) => setTimeout(r, 5));
    const clientRequestId = randomUUID();
    await admin.post(`${inbox}/${requestId}/replies`).send({ clientRequestId, body: REPLY }).expect(201);
    // A network retry creates nothing new.
    await admin.post(`${inbox}/${requestId}/replies`).send({ clientRequestId, body: REPLY }).expect(201);
    const after = (await lisa.get(`${mine}/${requestId}`).expect(200)).body;
    expect(after.messages).toEqual([{ id: expect.any(String), authorRole: 'ADMIN', body: REPLY, createdAt: expect.any(String) }]);
    expect(after.status).toBe('OPEN');
    expect(after.lastPublicActivityAt > before.lastPublicActivityAt).toBe(true);
    expect(JSON.stringify(after)).not.toContain(adminId);
    expect(JSON.stringify(after)).not.toContain(emails[2]);
  });

  it('status: server-side transitions, stale changes are 409, follow-up reopens waiting, resolved is closed to follow-ups', async () => {
    await status('WAITING_FOR_CUSTOMER', 'OPEN').expect(200);
    await status('IN_PROGRESS', 'OPEN').expect(409); // another admin's change is not overwritten
    await status('WAITING_FOR_CUSTOMER', 'WAITING_FOR_CUSTOMER').expect(400);
    await admin.patch(`${inbox}/${requestId}/status`).send({ status: 'CLOSED', expectedStatus: 'OPEN' }).expect(400);

    const followUp = await lisa.post(`${mine}/${requestId}/messages`).send({ clientRequestId: randomUUID(), body: 'Still spinning.' }).expect(201);
    expect(followUp.body.status).toBe('OPEN');
    expect(followUp.body.messages.at(-1)).toMatchObject({ authorRole: 'CUSTOMER', body: 'Still spinning.' });
    // A Customer cannot set status.
    await lisa.post(`${mine}/${requestId}/messages`).send({ clientRequestId: randomUUID(), body: 'x', status: 'RESOLVED' }).expect(400);

    await status('RESOLVED', 'OPEN').expect(200);
    const closed = await lisa.post(`${mine}/${requestId}/messages`).send({ clientRequestId: randomUUID(), body: 'One more thing' }).expect(409);
    expect(closed.body.message).toMatch(/create a new request/);
    expect((await lisa.get(`${mine}/${requestId}`).expect(200)).body.status).toBe('RESOLVED'); // still readable
    await status('IN_PROGRESS', 'RESOLVED').expect(400);
    await status('OPEN', 'RESOLVED').expect(200); // reopen

    // Two admins changing at once: exactly one wins.
    const results = await Promise.all([status('IN_PROGRESS', 'OPEN'), status('WAITING_FOR_CUSTOMER', 'OPEN')]);
    expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([200, 409]);
  });

  it('inbox: filters, bounds, stable order; detail keeps replies and notes apart', async () => {
    const list = await admin.get(inbox).query({ accountId: lisaId }).expect(200);
    expect(list.headers['cache-control']).toBe('no-store');
    expect(list.body.items).toEqual([
      expect.objectContaining({ id: requestId, ownerUserId: lisaId, subject: SUBJECT, category: 'UPLOADS_STORAGE' }),
    ]);
    expect((await admin.get(inbox).query({ reference: requestId, category: 'TECHNICAL' }).expect(200)).body.items).toEqual([]);
    await admin.get(inbox).query({ status: 'DONE' }).expect(400);
    await admin.get(inbox).query({ search: 'photo' }).expect(400);
    await admin.get(inbox).query({ from: '2024-01-01T00:00:00Z', to: '2026-01-01T00:00:00Z' }).expect(400);
    const detail = (await admin.get(`${inbox}/${requestId}`).expect(200)).body;
    expect(detail.internalNotes.map((n: { body: string }) => n.body)).toEqual([NOTE]);
    expect(detail.messages.map((m: { body: string }) => m.body)).toEqual([REPLY, 'Still spinning.']);
    // A note's submission id reused on another request is not treated as a retry.
    const other = (await create(lisa).expect(201)).body.id;
    const id = randomUUID();
    await admin.post(`${inbox}/${requestId}/notes`).send({ clientRequestId: id, body: 'a' }).expect(201);
    await admin.post(`${inbox}/${other}/notes`).send({ clientRequestId: id, body: 'b' }).expect(409);
  });

  it('audit: every mutation recorded with references and statuses only, never subjects or text', async () => {
    const rows = await prisma.auditLog.findMany({ where: { subjectType: 'SupportRequest', subjectId: requestId } });
    expect(new Set(rows.map((r) => r.eventType))).toEqual(
      new Set(['SUPPORT_REQUEST_CREATED', 'SUPPORT_NOTE_ADDED', 'SUPPORT_REPLY_SENT', 'SUPPORT_STATUS_CHANGED']),
    );
    // The retried reply wrote one row, not two.
    expect(rows.filter((r) => r.eventType === 'SUPPORT_REPLY_SENT')).toHaveLength(1);
    const reopened = rows.find((r) => r.actorType === 'CUSTOMER' && r.eventType === 'SUPPORT_STATUS_CHANGED');
    expect(reopened?.metadata).toEqual({ previousStatus: 'WAITING_FOR_CUSTOMER', newStatus: 'OPEN', by: 'customer_follow_up' });
    expect(JSON.stringify(rows)).not.toMatch(/spinning|photo|scanner|Cannot add|looking into/);
  });

  it('rate limit: Customer creation is limited per IP in Redis (429), and nothing past it is stored', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 12 && !codes.includes(429); i++) codes.push((await create(john)).status);
    expect(codes).toContain(429);
    const created = await prisma.supportRequest.count({ where: { owner: { email: emails[1] } } });
    expect(created).toBe(codes.filter((c) => c === 201).length);
    expect(created).toBeLessThanOrEqual(10);
  });
});
