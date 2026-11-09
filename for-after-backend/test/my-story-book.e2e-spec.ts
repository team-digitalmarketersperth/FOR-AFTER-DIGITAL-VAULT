import { ConfigModule } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import session from 'express-session';
import request from 'supertest';
import { AuthModule } from '../src/auth/auth.module.js';
import { configureApp } from '../src/config/app.setup.js';
import { MyStoryModule } from '../src/my-story/my-story.module.js';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

// GET /my-story/book: the owner's answers in chapters. Real HTTP, guards,
// sessions and PostgreSQL; fictional users, removed afterwards.
describe('My Story book (e2e, PostgreSQL)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const run = Date.now();
  const emails = ['lisa', 'john'].map((name) => `book.${name}.${run}@example.test`);
  const password = 'StrongPassword123!';
  type Agent = ReturnType<typeof request.agent>;
  let lisa: Agent;
  let john: Agent;
  const BOOK = '/api/v1/my-story/book';
  const answer = (key: string) => `/api/v1/my-story/prompts/${key}/response`;
  const signIn = async (email: string) => {
    const agent = request.agent(app.getHttpServer());
    await agent.post('/api/v1/auth/login').send({ email, password }).expect(200);
    return agent;
  };
  const ownerId = async (email: string) => (await prisma.user.findUniqueOrThrow({ where: { email } })).id;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule, AuthModule, MyStoryModule],
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

  it('requires a signed-in Customer; an empty story is an empty book', async () => {
    await request(app.getHttpServer()).get(BOOK).expect(401);
    const { body } = await lisa.get(BOOK).expect(200);
    expect(body).toEqual({ chapters: [], unsorted: [] });
  });

  it('chapters in catalogue order, prompts in catalogue order, exact words, no private notes', async () => {
    const text = 'First paragraph.\n\nSecond paragraph,\nwith a line break.';
    // Saved out of order on purpose.
    await lisa.put(answer('family.tradition')).send({ textContent: 'Sunday lunch.', privateNote: 'NOTE-FAMILY' }).expect(200);
    await lisa.put(answer('childhood.home')).send({ textContent: text, privateNote: 'NOTE-HOME' }).expect(200);
    await lisa.put(answer('childhood.earliest-memory')).send({ textContent: 'Rain on the roof.' }).expect(200);
    const { body } = await lisa.get(BOOK).expect(200);
    expect(body.chapters.map((c: { category: string }) => c.category)).toEqual(['CHILDHOOD', 'FAMILY']);
    const childhood = body.chapters[0].entries;
    expect(childhood.map((e: { promptKey: string }) => e.promptKey)).toEqual(['childhood.earliest-memory', 'childhood.home']);
    expect(childhood[1].textContent).toBe(text);
    expect(childhood[1].prompt).toBe('What was the place you grew up in like?');
    const raw = JSON.stringify(body);
    expect(raw).not.toMatch(/NOTE-|privateNote|ownerUserId|deletedAt/);
  });

  it('memory-only and media-only answers count; an empty upload shell does not', async () => {
    const owner = await ownerId(emails[0]);
    const memory = await prisma.memoryVaultItem.create({ data: { ownerUserId: owner, title: 'The blue bike', category: 'CHILDHOOD' } });
    await lisa.put(answer('childhood.school')).send({ memoryVaultItemIds: [memory.id] }).expect(200);
    // A READY photo with no words (storage is not involved in reading the book).
    const response = await prisma.myStoryResponse.create({
      data: { ownerUserId: owner, promptKey: 'travel.place', promptTextSnapshot: 'What is a place you have been that you still think about?', promptVersion: 1 },
    });
    await prisma.myStoryMediaAsset.create({
      data: { ownerUserId: owner, myStoryResponseId: response.id, kind: 'PHOTO', status: 'READY', storageKey: `book-test/${run}.jpg`, originalFileName: 'p.jpg', mimeType: 'image/jpeg', sizeBytes: 1 },
    });
    // Still uploading: not content yet.
    const shell = await prisma.myStoryResponse.create({
      data: { ownerUserId: owner, promptKey: 'work.first-job', promptTextSnapshot: 'x', promptVersion: 1 },
    });
    await prisma.myStoryMediaAsset.create({
      data: { ownerUserId: owner, myStoryResponseId: shell.id, kind: 'PHOTO', status: 'PENDING_UPLOAD', storageKey: `book-test/${run}-p.jpg`, originalFileName: 'p.jpg', mimeType: 'image/jpeg', sizeBytes: 1 },
    });
    const { body } = await lisa.get(BOOK).expect(200);
    expect(body.chapters.map((c: { category: string }) => c.category)).toEqual(['CHILDHOOD', 'FAMILY', 'TRAVEL']);
    const school = body.chapters[0].entries.find((e: { promptKey: string }) => e.promptKey === 'childhood.school');
    expect(school).toMatchObject({ textContent: null, memories: [{ id: memory.id, title: 'The blue bike' }] });
    expect(body.chapters[2].entries[0]).toMatchObject({ promptKey: 'travel.place', textContent: null, mediaCount: 1 });
    expect(JSON.stringify(body)).not.toContain('work.first-job');
  });

  it('keeps answers whose prompt is no longer in the catalogue, with their own wording', async () => {
    await prisma.myStoryResponse.create({
      data: { ownerUserId: await ownerId(emails[0]), promptKey: 'gone.old-question', promptTextSnapshot: 'An old question?', promptVersion: 1, textContent: 'Still kept.' },
    });
    const { body } = await lisa.get(BOOK).expect(200);
    expect(body.unsorted).toEqual([expect.objectContaining({ promptKey: 'gone.old-question', prompt: 'An old question?', textContent: 'Still kept.' })]);
  });

  it('is per owner: another Customer sees only their own (empty) book', async () => {
    const { body } = await john.get(BOOK).expect(200);
    expect(body).toEqual({ chapters: [], unsorted: [] });
  });

  it('follows edits and deletes: an emptied chapter disappears', async () => {
    await lisa.put(answer('family.tradition')).send({ textContent: 'Sunday lunch, always.' }).expect(200);
    let { body } = await lisa.get(BOOK).expect(200);
    expect(body.chapters[1].entries[0].textContent).toBe('Sunday lunch, always.');
    await lisa.delete(answer('family.tradition')).expect(204);
    ({ body } = await lisa.get(BOOK).expect(200));
    expect(body.chapters.map((c: { category: string }) => c.category)).toEqual(['CHILDHOOD', 'TRAVEL']);
  });
});
