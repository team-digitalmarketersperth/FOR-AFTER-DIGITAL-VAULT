import { ConfigModule } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import session from 'express-session';
import request from 'supertest';
import { adminSignIn } from './admin-sign-in.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { configureApp } from '../src/config/app.setup.js';
import { TEXT_CONTENT_MAX } from '../src/messages/dto/create-message.dto.js';
import { MyWishesDisclaimer } from '../src/my-wishes/my-wishes-disclaimer.service.js';
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
  const notice = '/api/v1/my-wishes/disclaimer';
  const acknowledge = `${notice}/acknowledgement`;
  const APPROVED_V1 =
    'My Wishes records personal preferences and guidance only. It is not a will, legal document, medical directive, financial instruction or substitute for professional advice.';
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

  it('requires a Customer session (401, admins included)', async () => {
    const anon = request(app.getHttpServer());
    await anon.get(root).expect(401);
    await anon.get(style).expect(401);
    await anon.put(styleAnswer).send({ textContent: 'x' }).expect(401);
    await anon.delete(styleAnswer).expect(401);
    for (const role of ['ADMIN', 'SUPER_ADMIN'] as const) {
      await prisma.user.update({ where: { email: emails[2] }, data: { role } });
      // Step 16: each role enrolls MFA afresh (test reset only). The admin
      // cookie is never read on Customer routes: 401.
      await prisma.adminMfaCredential.deleteMany({
        where: { user: { email: emails[2] } },
      });
      const { agent: admin } = await adminSignIn(app, emails[2], password);
      await admin.get(root).expect(401);
      await admin.get(styleAnswer).expect(401);
      await admin.put(styleAnswer).send({ textContent: 'x' }).expect(401);
      await admin.delete(styleAnswer).expect(401);
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
    // Phase 15B: {} and { textContent: null } are valid shapes (a wish may be
    // files only); an empty wish is refused by the service (see below).
    for (const body of [
      { textContent: '' },
      { textContent: '   \n ' },
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

  // Phase 15A (approved 2026-10-08): the API serves the notice; a Customer
  // acknowledges its current version once before writing wishes.
  it('the notice comes from the API; saving waits for an acknowledgement of the current version', async () => {
    const before = await lisa.get(notice).expect(200);
    expect(before.body).toEqual({
      version: 1,
      text: APPROVED_V1,
      requiresAcknowledgement: true,
      acknowledged: false,
      acknowledgedAt: null,
    });
    // No backfill: a new (or existing) Customer starts unacknowledged.
    expect(
      await prisma.myWishesDisclaimerAcknowledgement.count({
        where: { user: { email: emails[0] } },
      }),
    ).toBe(0);
    const blocked = await lisa
      .put(styleAnswer)
      .send({ textContent: 'A quiet ceremony.' })
      .expect(409);
    expect(blocked.body.message).toBe(
      'Please acknowledge the current My Wishes notice before saving.',
    );
    expect(await rowsFor(emails[0], 'ceremony.style')).toEqual([]);
    // Reading never needs it.
    await lisa.get(root).expect(200);

    for (const body of [
      {},
      { version: '1' },
      { version: 0 },
      { version: 1, userId: crypto.randomUUID() },
      { version: 1, acknowledgedAt: '2020-01-01T00:00:00Z' },
      { version: 1, text: 'Different words' },
    ])
      await lisa.post(acknowledge).send(body).expect(400);
    const stale = await lisa.post(acknowledge).send({ version: 2 }).expect(409);
    expect(stale.body.message).toBe(
      'The My Wishes notice has changed. Please read the current version.',
    );

    // Three submits at once: one acknowledgement, one audit event.
    const results = await Promise.all(
      [1, 2, 3].map(() => lisa.post(acknowledge).send({ version: 1 })),
    );
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(results[0].body).toMatchObject({ version: 1, acknowledged: true });
    expect(
      await prisma.myWishesDisclaimerAcknowledgement.count({
        where: { user: { email: emails[0] } },
      }),
    ).toBe(1);
    const audits = await prisma.auditLog.findMany({
      where: {
        eventType: 'MY_WISHES_DISCLAIMER_ACKNOWLEDGED',
        actorUserId: (
          await prisma.user.findUniqueOrThrow({ where: { email: emails[0] } })
        ).id,
      },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorType: 'CUSTOMER',
      metadata: { disclaimerVersion: 1 },
      ipPrefix: null,
      userAgent: null,
    });
    const after = await lisa.get(notice).expect(200);
    expect(after.body.acknowledged).toBe(true);
    expect(after.body.acknowledgedAt).toEqual(results[0].body.acknowledgedAt);
  });

  it('saves, updates, deletes and restores one logical answer', async () => {
    // Phase 15B: no text and no file is not a wish; nothing is created.
    for (const body of [{}, { textContent: null }])
      await lisa.put(styleAnswer).send(body).expect(400);
    expect(await rowsFor(emails[0], 'ceremony.style')).toEqual([]);
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
      'mediaCount',
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
    // John's acknowledgement is his own: Lisa's does not count for him.
    expect((await john.get(notice).expect(200)).body.acknowledged).toBe(false);
    await john.put(rememberAnswer).send({ textContent: johnText }).expect(409);
    await john.post(acknowledge).send({ version: 1 }).expect(200);
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

  it('a new notice version: reading and deleting still work, writing waits for the new acknowledgement', async () => {
    // Test-only: swap the current notice (the version lives in code, not the DB).
    const current = app.get(MyWishesDisclaimer) as {
      version: number;
      text: string;
    };
    const original = { ...current };
    try {
      current.version = 2;
      current.text = 'A test-only second version of the notice.';
      const status = await lisa.get(notice).expect(200);
      expect(status.body).toMatchObject({
        version: 2,
        text: 'A test-only second version of the notice.',
        acknowledged: false,
      });
      // Existing wishes stay readable; a v1 acknowledgement does not let writes through.
      await lisa.get(rememberAnswer).expect(200);
      await lisa
        .put(rememberAnswer)
        .send({ textContent: 'Edited.' })
        .expect(409);
      await lisa.post(acknowledge).send({ version: 1 }).expect(409);
      await lisa.post(acknowledge).send({ version: 2 }).expect(200);
      await lisa
        .put(rememberAnswer)
        .send({ textContent: 'Edited.' })
        .expect(200);
      // Both acknowledgements are kept as history.
      const rows = await prisma.myWishesDisclaimerAcknowledgement.findMany({
        where: { user: { email: emails[0] } },
        orderBy: { disclaimerVersion: 'asc' },
      });
      expect(rows.map((r) => r.disclaimerVersion)).toEqual([1, 2]);
      // Version 3, not acknowledged: deleting still works.
      current.version = 3;
      await lisa.get(rememberAnswer).expect(200);
      await lisa.delete(rememberAnswer).expect(204);
      await lisa
        .put(rememberAnswer)
        .send({ textContent: 'Again.' })
        .expect(409);
    } finally {
      Object.assign(current, original);
    }
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
