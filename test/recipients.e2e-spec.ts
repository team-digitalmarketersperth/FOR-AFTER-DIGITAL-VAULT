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
import { RecipientsModule } from '../src/recipients/recipients.module.js';

// Real HTTP, validation, guards and PostgreSQL (DATABASE_URL from .env).
// Sessions use MemoryStore so Redis is not needed. Fictional data only; the
// test users are removed afterwards (cascade removes their recipients).
describe('Recipients (e2e, PostgreSQL)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const run = Date.now();
  const emails = ['lisa', 'john', 'admin'].map(
    (name) => `${name}.${run}@example.test`,
  );
  const password = 'StrongPassword123!';

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
        RecipientsModule,
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

  const sofia = {
    firstName: '  Sofia ',
    lastName: 'Smith',
    relationship: 'Daughter',
    email: ' Sofia@Example.com ',
    mobile: '+61400000000',
    birthday: '2001-03-15',
    privateNote: 'Loves family travel memories.',
  };
  let sofiaId: string;

  it('requires a session (401)', async () => {
    const server = request(app.getHttpServer());
    await server.post('/api/v1/recipients').send(sofia).expect(401);
    await server.get('/api/v1/recipients').expect(401);
  });

  it('rejects ownerUserId, unknown fields and bad input (400)', async () => {
    for (const body of [
      { ...sofia, ownerUserId: crypto.randomUUID() },
      { ...sofia, isAdmin: true },
      { ...sofia, email: 'not-an-email' },
      { ...sofia, birthday: '2001-02-30' },
      { ...sofia, firstName: '   ' },
      { ...sofia, privateNote: 'x'.repeat(2001) },
    ]) {
      await lisa.post('/api/v1/recipients').send(body).expect(400);
    }
    await lisa.get('/api/v1/recipients/not-a-uuid').expect(400);
  });

  it('creates, lists, reads and updates own recipient', async () => {
    const created = await lisa
      .post('/api/v1/recipients')
      .send(sofia)
      .expect(201);
    sofiaId = created.body.id;
    expect(created.body).toMatchObject({
      firstName: 'Sofia',
      email: 'sofia@example.com',
      birthday: '2001-03-15',
    });
    expect(created.body).not.toHaveProperty('ownerUserId');
    expect(created.body).not.toHaveProperty('deletedAt');

    const list = await lisa.get('/api/v1/recipients').expect(200);
    expect(list.body.map((r: { id: string }) => r.id)).toEqual([sofiaId]);

    await lisa.get(`/api/v1/recipients/${sofiaId}`).expect(200);

    const updated = await lisa
      .patch(`/api/v1/recipients/${sofiaId}`)
      .send({ relationship: 'Granddaughter', mobile: null })
      .expect(200);
    expect(updated.body).toMatchObject({
      relationship: 'Granddaughter',
      mobile: null,
      firstName: 'Sofia',
    });

    await lisa
      .patch(`/api/v1/recipients/${sofiaId}`)
      .send({ firstName: null })
      .expect(400);
    await lisa
      .patch(`/api/v1/recipients/${sofiaId}`)
      .send({ ownerUserId: crypto.randomUUID() })
      .expect(400);
  });

  it('isolates users: John gets a plain 404 for Lisa’s recipient', async () => {
    const url = `/api/v1/recipients/${sofiaId}`;
    const responses = [
      await john.get(url).expect(404),
      await john.patch(url).send({ firstName: 'Hacked' }).expect(404),
      await john.delete(url).expect(404),
    ];
    for (const res of responses) {
      expect(JSON.stringify(res.body)).not.toMatch(/owner|belongs|Sofia/i);
    }
    expect((await john.get('/api/v1/recipients').expect(200)).body).toEqual([]);
    // Untouched for Lisa.
    const still = await lisa.get(url).expect(200);
    expect(still.body.firstName).toBe('Sofia');
  });

  it('non-CUSTOMER roles are refused (403)', async () => {
    await prisma.user.update({
      where: { email: emails[2] },
      data: { role: 'ADMIN' },
    });
    // Step 16: an admin session needs password + TOTP.
    const { agent: admin } = await adminSignIn(app, emails[2], password);
    await admin.get('/api/v1/recipients').expect(403);
  });

  it('soft-deletes: row stays in the database but disappears from the API', async () => {
    await lisa.delete(`/api/v1/recipients/${sofiaId}`).expect(204);
    await lisa.get(`/api/v1/recipients/${sofiaId}`).expect(404);
    await lisa.delete(`/api/v1/recipients/${sofiaId}`).expect(404);
    expect((await lisa.get('/api/v1/recipients').expect(200)).body).toEqual([]);

    const row = await prisma.recipient.findUnique({ where: { id: sofiaId } });
    expect(row?.deletedAt).toBeInstanceOf(Date);
  });
});
