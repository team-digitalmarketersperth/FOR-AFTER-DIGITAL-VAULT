import { ConfigModule } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import session from 'express-session';
import request from 'supertest';
import { adminSignIn } from './admin-sign-in.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { configureApp } from '../src/config/app.setup.js';
import { TEXT_CONTENT_MAX } from '../src/messages/dto/create-message.dto.js';
import { MyStoryModule } from '../src/my-story/my-story.module.js';
import { MY_STORY_PROMPTS } from '../src/my-story/my-story.prompts.js';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

// Real HTTP, validation, guards, sessions and PostgreSQL. No storage needed.
// Fictional data only; the test users are removed afterwards.
describe('My Story (e2e, PostgreSQL)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const run = Date.now();
  const emails = ['lisa', 'john', 'admin'].map(
    (name) => `story.${name}.${run}@example.test`,
  );
  const password = 'StrongPassword123!';

  type Agent = ReturnType<typeof request.agent>;
  const signIn = async (email: string) => {
    const agent = request.agent(app.getHttpServer());
    await agent
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(200);
    return agent;
  };

  let lisa: Agent;
  let john: Agent;
  const root = '/api/v1/my-story/prompts';
  const early = `${root}/childhood.earliest-memory`;
  const earlyAnswer = `${early}/response`;
  const legacyAnswer = `${root}/legacy.remembered/response`;
  const noLeaks = (body: unknown) =>
    expect(JSON.stringify(body)).not.toMatch(
      /ownerUserId|deletedAt|promptTextSnapshot/,
    );
  type PromptView = { key: string; answered: boolean; response: unknown };
  const promptIn = (body: PromptView[], key: string) =>
    body.find((p) => p.key === key)!;
  const rowsFor = (email: string, promptKey: string) =>
    prisma.myStoryResponse.findMany({
      where: { owner: { email }, promptKey },
    });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        AuthModule,
        MyStoryModule,
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

  it('requires a session (401) and a customer (403)', async () => {
    const anon = request(app.getHttpServer());
    await anon.get(root).expect(401);
    await anon.get(early).expect(401);
    await anon.put(earlyAnswer).send({ textContent: 'x' }).expect(401);
    await anon.delete(earlyAnswer).expect(401);
    for (const role of ['ADMIN', 'SUPER_ADMIN'] as const) {
      await prisma.user.update({ where: { email: emails[2] }, data: { role } });
      // Step 16: each role enrolls MFA afresh (test reset only).
      await prisma.adminMfaCredential.deleteMany({
        where: { user: { email: emails[2] } },
      });
      const { agent: admin } = await adminSignIn(app, emails[2], password);
      await admin.get(root).expect(403);
      await admin.get(earlyAnswer).expect(403);
      await admin.put(earlyAnswer).send({ textContent: 'x' }).expect(403);
      await admin.delete(earlyAnswer).expect(403);
    }
  });

  it('lists the catalogue, unanswered, and filters by category', async () => {
    const all = await lisa.get(root).expect(200);
    expect(all.body.map((p: PromptView) => p.key)).toEqual(
      MY_STORY_PROMPTS.map((p) => p.key),
    );
    expect(all.body[0]).toEqual({
      key: 'childhood.earliest-memory',
      category: 'CHILDHOOD',
      version: 1,
      prompt: 'What is one of your earliest memories?',
      answered: false,
      response: null,
    });
    const childhood = await lisa.get(`${root}?category=CHILDHOOD`).expect(200);
    expect(childhood.body.map((p: PromptView) => p.key)).toEqual([
      'childhood.earliest-memory',
      'childhood.home',
    ]);
    await lisa.get(`${root}?category=RECIPES`).expect(400);
    await lisa.get(`${root}?category=childhood`).expect(400);
    await lisa.get(`${root}?search=x`).expect(400);
  });

  it('GET one prompt; unknown 404, malformed 400, unanswered response 404', async () => {
    const one = await lisa.get(early).expect(200);
    expect(one.body).toMatchObject({ answered: false, response: null });
    await lisa.get(`${root}/legacy.unknown`).expect(404);
    await lisa.get(`${root}/legacy.unknown/response`).expect(404);
    await lisa
      .put(`${root}/legacy.unknown/response`)
      .send({ textContent: 'x' })
      .expect(404);
    await lisa.get(`${root}/Legacy.Remembered`).expect(400);
    await lisa.get(`${root}/..%2F..%2Fetc`).expect(400);
    await lisa.get(earlyAnswer).expect(404);
    await lisa.delete(earlyAnswer).expect(404);
  });

  it('rejects invalid bodies (400)', async () => {
    for (const body of [
      {},
      { textContent: '' },
      { textContent: '   \n ' },
      { textContent: null },
      { textContent: 42 },
      { textContent: 'x'.repeat(TEXT_CONTENT_MAX + 1) },
      { textContent: 'x', ownerUserId: crypto.randomUUID() },
      { textContent: 'x', promptVersion: 2 },
      { textContent: 'x', promptTextSnapshot: 'Another question' },
      { textContent: 'x', promptKey: 'family.influence' },
      { textContent: 'x', recipientIds: [] },
      { textContent: 'x', scheduledFor: '2030-01-01T00:00:00Z' },
    ]) {
      await lisa.put(earlyAnswer).send(body).expect(400);
    }
    expect(await rowsFor(emails[0], 'childhood.earliest-memory')).toEqual([]);
  });

  it('saves, reads, updates, deletes and restores one logical answer', async () => {
    const first = await lisa
      .put(earlyAnswer)
      .send({
        textContent: 'I remember playing in the garden outside our first home.',
      })
      .expect(200);
    expect(Object.keys(first.body).sort()).toEqual([
      'createdAt',
      'id',
      'promptKey',
      'textContent',
      'updatedAt',
    ]);
    const id = first.body.id;

    const list = await lisa.get(root).expect(200);
    expect(promptIn(list.body, 'childhood.earliest-memory')).toMatchObject({
      answered: true,
      response: { id, textContent: first.body.textContent },
    });
    noLeaks(list.body);
    noLeaks((await lisa.get(early).expect(200)).body);
    const got = await lisa.get(earlyAnswer).expect(200);
    expect(got.body).toEqual(first.body);

    const updated = await lisa
      .put(earlyAnswer)
      .send({
        textContent:
          'My earliest memory is playing with my sister in our garden.',
      })
      .expect(200);
    expect(updated.body.id).toBe(id);
    expect(updated.body.textContent).toContain('my sister');
    let rows = await rowsFor(emails[0], 'childhood.earliest-memory');
    expect(rows).toHaveLength(1);
    // Snapshot and version come from the catalogue.
    expect(rows[0]).toMatchObject({
      promptTextSnapshot: 'What is one of your earliest memories?',
      promptVersion: 1,
      deletedAt: null,
    });

    await lisa.delete(earlyAnswer).expect(204);
    await lisa.get(earlyAnswer).expect(404);
    await lisa.delete(earlyAnswer).expect(404);
    const afterDelete = await lisa.get(root).expect(200);
    expect(
      promptIn(afterDelete.body, 'childhood.earliest-memory'),
    ).toMatchObject({ answered: false, response: null });
    rows = await rowsFor(emails[0], 'childhood.earliest-memory');
    expect(rows).toHaveLength(1);
    expect(rows[0].deletedAt).not.toBeNull();

    const restored = await lisa
      .put(earlyAnswer)
      .send({ textContent: 'I decided to write this memory again.' })
      .expect(200);
    expect(restored.body.id).toBe(id);
    rows = await rowsFor(emails[0], 'childhood.earliest-memory');
    expect(rows).toHaveLength(1);
    expect(rows[0].deletedAt).toBeNull();
    expect(
      promptIn(
        (await lisa.get(root).expect(200)).body,
        'childhood.earliest-memory',
      ),
    ).toMatchObject({ answered: true });
  });

  it('stores text exactly as written, markup included', async () => {
    const raw = '  <b>Not HTML</b> & "quotes"\n\nSecond paragraph.  ';
    const res = await lisa
      .put(`${root}/values.guiding-values/response`)
      .send({ textContent: raw })
      .expect(200);
    expect(res.body.textContent).toBe(raw);
    const long = 'x'.repeat(TEXT_CONTENT_MAX);
    await lisa
      .put(`${root}/values.guiding-values/response`)
      .send({ textContent: long })
      .expect(200);
  });

  it('keeps Lisa and John completely separate', async () => {
    const lisaText = 'I hope my family remembers my kindness.';
    const johnText = 'I hope people remember my curiosity.';
    await lisa.put(legacyAnswer).send({ textContent: lisaText }).expect(200);

    await john.get(legacyAnswer).expect(404);
    await john.delete(legacyAnswer).expect(404);
    const johnList = await john.get(root).expect(200);
    expect(JSON.stringify(johnList.body)).not.toContain(lisaText);
    expect(johnList.body.every((p: PromptView) => !p.answered)).toBe(true);

    await john.put(legacyAnswer).send({ textContent: johnText }).expect(200);
    const johnAnswer = await john.get(legacyAnswer).expect(200);
    expect(johnAnswer.body.textContent).toBe(johnText);
    expect(JSON.stringify((await john.get(root)).body)).not.toContain(lisaText);

    lisa = await signIn(emails[0]);
    const lisaAnswer = await lisa.get(legacyAnswer).expect(200);
    expect(lisaAnswer.body.textContent).toBe(lisaText);
    expect(lisaAnswer.body.id).not.toBe(johnAnswer.body.id);
    expect(await rowsFor(emails[0], 'legacy.remembered')).toHaveLength(1);
    expect(await rowsFor(emails[1], 'legacy.remembered')).toHaveLength(1);
  });
});
