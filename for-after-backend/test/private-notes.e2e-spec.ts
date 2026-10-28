import { ConfigModule } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import session from 'express-session';
import request from 'supertest';
import { AuthModule } from '../src/auth/auth.module.js';
import { configureApp } from '../src/config/app.setup.js';
import { MalwareScanner } from '../src/media/scanner/malware-scanner.service.js';
import { MediaStorage } from '../src/media/storage/media-storage.service.js';
import { MemoryVaultModule } from '../src/memory-vault/memory-vault.module.js';
import { MessagesModule } from '../src/messages/messages.module.js';
import { MyStoryModule } from '../src/my-story/my-story.module.js';
import { MyWishesModule } from '../src/my-wishes/my-wishes.module.js';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { RecipientsModule } from '../src/recipients/recipients.module.js';
import { RedisModule } from '../src/redis/redis.module.js';
import { FakeMalwareScanner } from './fake-malware-scanner.js';
import { FakeMediaStorage } from './fake-media-storage.js';

// Private notes to self (docs/private-notes.md): owner-only on Messages,
// memories, story answers and wishes; never copied into a Message, searched,
// versioned or shown to another Customer. Release/Recipient Portal exclusion
// is in recipient-portal.e2e-spec.ts. Real HTTP and PostgreSQL; fictional data.
describe('Private notes to self (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const run = Date.now();
  const customers = ['lisa', 'john'].map((n) => `notes.${n}.${run}@example.test`);
  const password = 'StrongPassword123!';
  type Agent = ReturnType<typeof request.agent>;
  let lisa: Agent;
  let john: Agent;
  let sofia: string;
  const api = (path: string) => `/api/v1${path}`;
  const STORY = api('/my-story/prompts/childhood.earliest-memory/response');
  const WISH = api('/my-wishes/prompts/ceremony.style/response');
  const share = (path: string) =>
    lisa
      .post(path)
      .send({ title: 'Shared', contentType: 'TEXT', includeText: true, mediaAssetIds: [], recipientIds: [sofia] })
      .expect(201);
  // The new Message: the source text, never its note.
  const expectCopied = async (body: { id: string; textContent: string; privateNote: unknown }, text: string, note: RegExp) => {
    expect(body.textContent).toBe(text);
    expect(body.privateNote).toBeNull();
    const row = await prisma.message.findUniqueOrThrow({ where: { id: body.id }, include: { versions: true } });
    expect(JSON.stringify(row)).not.toMatch(note);
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        RedisModule,
        AuthModule,
        RecipientsModule,
        MessagesModule,
        MemoryVaultModule,
        MyStoryModule,
        MyWishesModule,
      ],
    })
      .overrideProvider(MediaStorage)
      .useValue(new FakeMediaStorage())
      .overrideProvider(MalwareScanner)
      .useValue(new FakeMalwareScanner())
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app, new session.MemoryStore());
    await app.init();
    prisma = app.get(PrismaService);
    const agents: Agent[] = [];
    for (const [i, email] of customers.entries()) {
      await request(app.getHttpServer())
        .post(api('/auth/register'))
        .send({ email, password, firstName: ['Lisa', 'John'][i], lastName: 'Test' })
        .expect(201);
      const agent = request.agent(app.getHttpServer());
      await agent.post(api('/auth/login')).send({ email, password }).expect(200);
      agents.push(agent);
    }
    [lisa, john] = agents;
    sofia = (await lisa.post(api('/recipients')).send({ firstName: 'Sofia' }).expect(201)).body.id;
  });

  afterAll(async () => {
    await prisma?.user.deleteMany({ where: { email: { in: customers } } });
    await app?.close();
  });

  it('Message: set (trimmed), update, clear; summary omits it; not versioned; other Customer 404', async () => {
    const created = (
      await lisa
        .post(api('/messages'))
        .send({ title: 'For Sofia', textContent: 'Many happy returns.', privateNote: '  Rewrite later.  ', recipientIds: [sofia] })
        .expect(201)
    ).body;
    expect(created.privateNote).toBe('Rewrite later.');
    const path = api(`/messages/${created.id}`);
    const versions = async () => (await lisa.get(`${path}/versions`).expect(200)).body.items.length;
    const before = await versions();
    expect((await lisa.patch(path).send({ privateNote: 'After Sarah graduates.' }).expect(200)).body.privateNote).toBe(
      'After Sarah graduates.',
    );
    // A note-only change is not a content version, and versions never carry it.
    expect(await versions()).toBe(before);
    const all = (await lisa.get(`${path}/versions`).expect(200)).body.items;
    const detail = (await lisa.get(`${path}/versions/${all[0].id}`).expect(200)).body;
    expect(JSON.stringify([all, detail])).not.toMatch(/privateNote|Sarah graduates/);
    const list = (await lisa.get(api('/messages')).expect(200)).body;
    expect(JSON.stringify(list)).not.toMatch(/privateNote|Sarah graduates/);
    await john.get(path).expect(404);
    await john.patch(path).send({ privateNote: 'Mine now.' }).expect(404);
    await lisa.patch(path).send({ privateNote: 'x'.repeat(2001) }).expect(400);
    expect((await lisa.patch(path).send({ privateNote: '   ' }).expect(200)).body.privateNote).toBeNull();
  });

  it('Memory: owner-only, out of the list and search, never copied into a Message', async () => {
    const memory = (
      await lisa
        .post(api('/memory-vault'))
        .send({ title: 'Our trip to Italy', category: 'TRAVEL', textContent: 'Rome in spring.', privateNote: 'Find the better photo after graduation.' })
        .expect(201)
    ).body;
    const path = api(`/memory-vault/${memory.id}`);
    expect((await lisa.get(path).expect(200)).body.privateNote).toBe('Find the better photo after graduation.');
    const list = (await lisa.get(api('/memory-vault')).expect(200)).body;
    expect(JSON.stringify(list)).not.toMatch(/privateNote|better photo/);
    expect((await lisa.get(api('/memory-vault?search=graduation')).expect(200)).body.items).toEqual([]);
    await john.get(path).expect(404);
    await john.patch(path).send({ privateNote: 'Mine now.' }).expect(404);
    expect((await lisa.patch(path).send({ privateNote: null }).expect(200)).body.privateNote).toBeNull();
    await lisa.patch(path).send({ privateNote: 'Find the better photo.' }).expect(200);
    await expectCopied((await share(`${path}/messages`)).body, 'Rome in spring.', /better photo/);
  });

  it('My Story: owner-only, never copied into a Message', async () => {
    const saved = (
      await lisa.put(STORY).send({ textContent: 'My first job was...', privateNote: 'Ask Mum about the exact year.' }).expect(200)
    ).body;
    expect(saved.privateNote).toBe('Ask Mum about the exact year.');
    // Note-only edit keeps the answer's text.
    const edited = (await lisa.put(STORY).send({ privateNote: 'Ask Dad too.' }).expect(200)).body;
    expect(edited).toMatchObject({ textContent: 'My first job was...', privateNote: 'Ask Dad too.' });
    await john.get(STORY).expect(404);
    await expectCopied((await share(`${STORY}/messages`)).body, 'My first job was...', /Ask Dad/);
  });

  it('My Wishes: owner-only, never copied into a Message; a deleted wish does not bring its note back', async () => {
    const saved = (await lisa.put(WISH).send({ textContent: 'I would prefer...', privateNote: 'Review this next year.' }).expect(200)).body;
    expect(saved.privateNote).toBe('Review this next year.');
    await john.get(WISH).expect(404);
    await expectCopied((await share(`${WISH}/messages`)).body, 'I would prefer...', /next year/);
    await lisa.delete(WISH).expect(204);
    expect((await lisa.put(WISH).send({ textContent: 'Again.' }).expect(200)).body.privateNote).toBeNull();
  });
});
