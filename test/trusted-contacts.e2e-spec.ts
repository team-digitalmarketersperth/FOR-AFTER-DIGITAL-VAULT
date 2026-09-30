import { ConfigModule } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import session from 'express-session';
import request from 'supertest';
import { adminSignIn } from './admin-sign-in.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { configureApp } from '../src/config/app.setup.js';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { TrustedContactsModule } from '../src/trusted-contacts/trusted-contacts.module.js';

// Real HTTP, validation, guards and PostgreSQL (DATABASE_URL from .env).
// Sessions use MemoryStore so Redis is not needed. Fictional data only; the
// test users are removed afterwards (cascade removes their contacts).
describe('Trusted contacts (e2e, PostgreSQL)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const run = Date.now();
  const emails = ['lisa', 'john', 'admin'].map(
    (name) => `tc.${name}.${run}@example.test`,
  );
  const password = 'StrongPassword123!';
  const base = '/api/v1/trusted-contacts';

  const signIn = async (email: string) => {
    const agent = request.agent(app.getHttpServer());
    await agent
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(200);
    return agent;
  };

  let lisa: ReturnType<typeof request.agent>;
  let john: ReturnType<typeof request.agent>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        AuthModule,
        TrustedContactsModule,
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
  });

  afterAll(async () => {
    await prisma?.user.deleteMany({ where: { email: { in: emails } } });
    await app?.close();
  });

  const david = {
    firstName: ' David ',
    lastName: 'Smith',
    relationship: 'Spouse',
    email: ' David@Example.com ',
    mobile: '+61400000000',
  };
  let davidId: string;

  it('requires a session (401)', () =>
    request(app.getHttpServer()).post(base).send(david).expect(401));

  it('rejects bad input (400)', async () => {
    for (const body of [
      { firstName: 'David' },
      { firstName: 'David', email: null, mobile: null },
      { firstName: 'David', email: 'bad-email' },
      { firstName: 'David', mobile: 'call me' },
      { ...david, ownerUserId: crypto.randomUUID() },
      { ...david, canReportDeath: true },
      { ...david, firstName: null },
    ]) {
      await lisa.post(base).send(body).expect(400);
    }
    await lisa.get(`${base}/not-a-uuid`).expect(400);
  });

  it('creates, lists, reads and updates own contact', async () => {
    const created = await lisa.post(base).send(david).expect(201);
    davidId = created.body.id;
    expect(created.body).toMatchObject({
      firstName: 'David',
      email: 'david@example.com',
      mobile: '+61400000000',
    });
    expect(created.body).not.toHaveProperty('ownerUserId');
    expect(created.body).not.toHaveProperty('deletedAt');

    const list = await lisa.get(base).expect(200);
    expect(list.body.map((c: { id: string }) => c.id)).toEqual([davidId]);

    await lisa.get(`${base}/${davidId}`).expect(200);
    const updated = await lisa
      .patch(`${base}/${davidId}`)
      .send({ relationship: 'Husband' })
      .expect(200);
    expect(updated.body.relationship).toBe('Husband');

    await lisa
      .patch(`${base}/${davidId}`)
      .send({ firstName: null })
      .expect(400);
    await lisa
      .patch(`${base}/${davidId}`)
      .send({ ownerUserId: crypto.randomUUID() })
      .expect(400);
  });

  it('keeps at least one contact method on PATCH', async () => {
    const res = await lisa
      .post(base)
      .send({ firstName: 'Emma', email: 'emma@example.com' })
      .expect(201);
    const url = `${base}/${res.body.id}`;

    await lisa.patch(url).send({ email: null }).expect(400);
    await lisa.patch(url).send({ email: null, mobile: null }).expect(400);
    await lisa.patch(url).send({ mobile: '+61400000001' }).expect(200);
    const emailCleared = await lisa
      .patch(url)
      .send({ email: null })
      .expect(200);
    expect(emailCleared.body).toMatchObject({
      email: null,
      mobile: '+61400000001',
    });
    await lisa.patch(url).send({ mobile: null }).expect(400);
    await lisa.patch(url).send({ email: 'emma@example.com' }).expect(200);
    const mobileCleared = await lisa
      .patch(url)
      .send({ mobile: null })
      .expect(200);
    expect(mobileCleared.body).toMatchObject({
      email: 'emma@example.com',
      mobile: null,
    });
  });

  it('isolates users: John gets a plain 404 for Lisa’s contact', async () => {
    const url = `${base}/${davidId}`;
    const responses = [
      await john.get(url).expect(404),
      await john.patch(url).send({ firstName: 'Hacked' }).expect(404),
      await john.patch(url).send({ email: null }).expect(404),
      await john.delete(url).expect(404),
    ];
    for (const res of responses) {
      expect(JSON.stringify(res.body)).not.toMatch(/owner|belongs|David/i);
    }
    expect((await john.get(base).expect(200)).body).toEqual([]);
    expect((await lisa.get(url).expect(200)).body.firstName).toBe('David');
  });

  it('non-CUSTOMER roles are refused (403)', async () => {
    await prisma.user.update({
      where: { email: emails[2] },
      data: { role: 'ADMIN' },
    });
    // Step 16: an admin session needs password + TOTP.
    const { agent: admin } = await adminSignIn(app, emails[2], password);
    await admin.post(base).send(david).expect(403);
    await admin.get(base).expect(403);
  });

  it('soft-deletes: row stays in the database but disappears from the API', async () => {
    await lisa.delete(`${base}/${davidId}`).expect(204);
    await lisa.get(`${base}/${davidId}`).expect(404);
    await lisa.delete(`${base}/${davidId}`).expect(404);
    const ids = (await lisa.get(base).expect(200)).body.map(
      (c: { id: string }) => c.id,
    );
    expect(ids).not.toContain(davidId);

    const row = await prisma.trustedContact.findUnique({
      where: { id: davidId },
    });
    expect(row?.deletedAt).toBeInstanceOf(Date);
  });

  it('the database itself refuses a contact with no email or mobile', async () => {
    const lisaUser = await prisma.user.findUniqueOrThrow({
      where: { email: emails[0] },
    });
    await expect(
      prisma.trustedContact.create({
        data: { ownerUserId: lisaUser.id, firstName: 'NoContact' },
      }),
    ).rejects.toThrow();
  });
});
