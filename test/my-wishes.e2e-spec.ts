import { ConfigModule } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import session from 'express-session';
import request from 'supertest';
import { AuthModule } from '../src/auth/auth.module.js';
import { configureApp } from '../src/config/app.setup.js';
import { TEXT_CONTENT_MAX } from '../src/messages/dto/create-message.dto.js';
import { MyWishesModule } from '../src/my-wishes/my-wishes.module.js';
import { MY_WISHES_PROMPTS } from '../src/my-wishes/my-wishes.prompts.js';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

// Real HTTP, validation, guards, sessions and PostgreSQL. No storage needed.
// Fictional data only; the test users are removed afterwards.
describe('My Wishes (e2e, PostgreSQL)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const run = Date.now();
  const emails = ['lisa', 'john', 'admin'].map(
    (name) => `wishes.${name}.${run}@example.test`,
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
  const root = '/api/v1/my-wishes/prompts';
  const style = `${root}/ceremony.style`;
  const styleAnswer = `${style}/response`;
  const musicAnswer = `${root}/music-and-readings.music/response`;
  const rememberAnswer = `${root}/personal-message.remember/response`;
  const noLeaks = (body: unknown) =>
    expect(JSON.stringify(body)).not.toMatch(
      /ownerUserId|deletedAt|promptTextSnapshot/,
    );
  type PromptView = { key: string; answered: boolean; response: unknown };
  const promptIn = (body: PromptView[], key: string) =>
    body.find((p) => p.key === key)!;
  const rowsFor = (email: string, promptKey: string) =>
    prisma.myWishResponse.findMany({ where: { owner: { email }, promptKey } });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        AuthModule,
        MyWishesModule,
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
  });

  afterAll(async () => {
    await prisma?.user.deleteMany({ where: { email: { in: emails } } });
    await app?.close();
  });

  it('requires a session (401) and a customer (403)', async () => {
    const anon = request(app.getHttpServer());
    await anon.get(root).expect(401);
    await anon.get(style).expect(401);
    await anon.put(styleAnswer).send({ textContent: 'x' }).expect(401);
    await anon.delete(styleAnswer).expect(401);
    for (const role of ['ADMIN', 'SUPER_ADMIN'] as const) {
      await prisma.user.update({ where: { email: emails[2] }, data: { role } });
      const admin = await signIn(emails[2]);
      await admin.get(root).expect(403);
      await admin.get(styleAnswer).expect(403);
      await admin.put(styleAnswer).send({ textContent: 'x' }).expect(403);
      await admin.delete(styleAnswer).expect(403);
    }
  });

  it('lists the catalogue, unanswered, and filters by category', async () => {
    const all = await lisa.get(root).expect(200);
    expect(all.body.map((p: PromptView) => p.key)).toEqual(
      MY_WISHES_PROMPTS.map((p) => p.key),
    );
    expect(all.body[0]).toEqual({
      key: 'ceremony.style',
      category: 'CEREMONY',
      version: 1,
      prompt:
        'How would you like your farewell or celebration of life to feel?',
      answered: false,
      response: null,
    });
    const ceremony = await lisa.get(`${root}?category=CEREMONY`).expect(200);
    expect(ceremony.body.map((p: PromptView) => p.key)).toEqual([
      'ceremony.style',
      'ceremony.setting',
    ]);
    await lisa.get(`${root}?category=LEGAL`).expect(400);
    await lisa.get(`${root}?category=ceremony`).expect(400);
  });

  it('GET one prompt; unknown 404, malformed 400, unanswered response 404', async () => {
    expect((await lisa.get(style).expect(200)).body).toMatchObject({
      answered: false,
      response: null,
    });
    await lisa.get(`${root}/ceremony.unknown`).expect(404);
    await lisa.get(`${root}/legacy.remembered`).expect(404); // a My Story key
    await lisa
      .put(`${root}/ceremony.unknown/response`)
      .send({ textContent: 'x' })
      .expect(404);
    await lisa.get(`${root}/Ceremony.Style`).expect(400);
    await lisa.get(`${root}/..%2F..%2Fsecret`).expect(400);
    await lisa.get(`${root}/ceremony%2Fstyle`).expect(400);
    await lisa.get(styleAnswer).expect(404);
    await lisa.delete(styleAnswer).expect(404);
  });

  it('rejects invalid bodies (400)', async () => {
    for (const body of [
      {},
      { textContent: '' },
      { textContent: '   \n ' },
      { textContent: null },
      { textContent: 'x'.repeat(TEXT_CONTENT_MAX + 1) },
      { textContent: 'x', ownerUserId: crypto.randomUUID() },
      { textContent: 'x', promptVersion: 2 },
      { textContent: 'x', promptTextSnapshot: 'Another question' },
      { textContent: 'x', recipientIds: [] },
      { textContent: 'x', triggerType: 'ON_DEATH' },
      { textContent: 'x', acceptedLegalDisclaimer: true },
    ]) {
      await lisa.put(styleAnswer).send(body).expect(400);
    }
    expect(await rowsFor(emails[0], 'ceremony.style')).toEqual([]);
  });

  it('saves, updates, deletes and restores one logical answer', async () => {
    const first = await lisa
      .put(styleAnswer)
      .send({
        textContent:
          'I would like something simple, warm and focused on family.',
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
    expect((await lisa.get(styleAnswer).expect(200)).body).toEqual(first.body);
    const list = await lisa.get(root).expect(200);
    expect(promptIn(list.body, 'ceremony.style')).toMatchObject({
      answered: true,
      response: { id },
    });
    noLeaks(list.body);

    const updated = await lisa
      .put(styleAnswer)
      .send({
        textContent:
          'I would like something relaxed, warm and centred around family and close friends.',
      })
      .expect(200);
    expect(updated.body.id).toBe(id);
    let rows = await rowsFor(emails[0], 'ceremony.style');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      promptTextSnapshot:
        'How would you like your farewell or celebration of life to feel?',
      promptVersion: 1,
      textContent: updated.body.textContent,
    });

    await lisa
      .put(musicAnswer)
      .send({
        textContent:
          'I would like music that feels warm and familiar to my family.',
      })
      .expect(200);
    const both = await lisa.get(root).expect(200);
    expect(promptIn(both.body, 'ceremony.style').answered).toBe(true);
    expect(promptIn(both.body, 'music-and-readings.music').answered).toBe(true);

    await lisa.delete(styleAnswer).expect(204);
    await lisa.get(styleAnswer).expect(404);
    expect((await lisa.get(style).expect(200)).body).toMatchObject({
      answered: false,
      response: null,
    });
    rows = await rowsFor(emails[0], 'ceremony.style');
    expect(rows).toHaveLength(1);
    expect(rows[0].deletedAt).not.toBeNull();

    const restored = await lisa
      .put(styleAnswer)
      .send({ textContent: 'I decided to record this wish again.' })
      .expect(200);
    expect(restored.body.id).toBe(id);
    rows = await rowsFor(emails[0], 'ceremony.style');
    expect(rows).toHaveLength(1);
    expect(rows[0].deletedAt).toBeNull();
    expect((await lisa.get(style).expect(200)).body.answered).toBe(true);
  });

  it('keeps Lisa and John completely separate', async () => {
    const lisaText = 'I would like my family to remember to laugh together.';
    const johnText = 'I would like my friends to take a walk by the sea.';
    await lisa.put(rememberAnswer).send({ textContent: lisaText }).expect(200);
    await lisa.post('/api/v1/auth/logout').expect(200);

    const john = await signIn(emails[1]);
    await john.get(rememberAnswer).expect(404);
    await john.delete(rememberAnswer).expect(404);
    const johnList = await john.get(root).expect(200);
    expect(johnList.body.every((p: PromptView) => !p.answered)).toBe(true);
    expect(JSON.stringify(johnList.body)).not.toContain(lisaText);

    await john.put(rememberAnswer).send({ textContent: johnText }).expect(200);
    const johnAnswer = await john.get(rememberAnswer).expect(200);
    expect(johnAnswer.body.textContent).toBe(johnText);

    lisa = await signIn(emails[0]);
    const lisaAnswer = await lisa.get(rememberAnswer).expect(200);
    expect(lisaAnswer.body.textContent).toBe(lisaText);
    expect(lisaAnswer.body.id).not.toBe(johnAnswer.body.id);
    expect(await rowsFor(emails[0], 'personal-message.remember')).toHaveLength(
      1,
    );
    expect(await rowsFor(emails[1], 'personal-message.remember')).toHaveLength(
      1,
    );
  });

  it('created no Messages, schedules, memories or story answers', async () => {
    const owner = { owner: { email: { in: emails } } };
    expect(await prisma.message.count({ where: owner })).toBe(0);
    expect(
      await prisma.messageSchedule.count({ where: { message: owner } }),
    ).toBe(0);
    expect(await prisma.memoryVaultItem.count({ where: owner })).toBe(0);
    expect(await prisma.myStoryResponse.count({ where: owner })).toBe(0);
  });
});
