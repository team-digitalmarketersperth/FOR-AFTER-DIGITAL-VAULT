import { ConfigModule } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import session from 'express-session';
import request from 'supertest';
import { AuthModule } from '../src/auth/auth.module.js';
import { configureApp } from '../src/config/app.setup.js';
import { DraftRecoveryModule } from '../src/draft-recovery/draft-recovery.module.js';
import { textRevision } from '../src/draft-recovery/draft-recovery.service.js';
import { MessagesModule } from '../src/messages/messages.module.js';
import { MyStoryModule } from '../src/my-story/my-story.module.js';
import { MyWishesModule } from '../src/my-wishes/my-wishes.module.js';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { RecipientsModule } from '../src/recipients/recipients.module.js';

// Server-side autosave (draft recovery): real HTTP, guards and PostgreSQL.
// Fictional data only; the test users are removed afterwards (cascade).
describe('Draft recovery (e2e, PostgreSQL)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const run = Date.now();
  const emails = ['lisa', 'john'].map((n) => `draft.${n}.${run}@example.test`);
  const password = 'StrongPassword123!';
  const drafts = '/api/v1/users/me/drafts';
  const story = 'milestones.favourite-day';
  const wish = 'ceremony.style';
  type Agent = ReturnType<typeof request.agent>;
  let lisa: Agent;
  let john: Agent;
  let sofiaId: string;

  const signIn = async (email: string) => {
    const agent = request.agent(app.getHttpServer());
    await agent.post('/api/v1/auth/login').send({ email, password }).expect(200);
    return agent;
  };
  const newMessage = async () =>
    (
      await lisa
        .post('/api/v1/messages')
        .send({ title: 'For Sofia', contentType: 'TEXT', textContent: 'Saved.', recipientIds: [sofiaId] })
        .expect(201)
    ).body as { id: string; version: number };
  const msgDraft = (textContent: string) => ({ title: 'For Sofia', contentType: 'TEXT', textContent });
  const rowsFor = (email: string) => prisma.draftRecovery.findMany({ where: { user: { email } } });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        AuthModule,
        RecipientsModule,
        MessagesModule,
        MyStoryModule,
        MyWishesModule,
        DraftRecoveryModule,
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

  it('requires a session', () => request(app.getHttpServer()).get(`${drafts}/NEW_MESSAGE`).expect(401));

  describe('an existing DRAFT message', () => {
    it('autosaves, returns the latest draft, and never touches the message or its versions', async () => {
      const m = await newMessage();
      const url = `${drafts}/MESSAGE/${m.id}`;
      expect((await lisa.get(url).expect(200)).body).toEqual({});
      await lisa.put(url).send({ payload: msgDraft('Unsaved 1'), baseRevision: '1' }).expect(200);
      const saved = (await lisa.put(url).send({ payload: msgDraft('Unsaved 2'), baseRevision: '1' }).expect(200)).body;
      expect(saved).toMatchObject({ key: m.id, baseRevision: '1', currentRevision: '1', conflict: false });
      const got = (await lisa.get(url).expect(200)).body;
      expect(got.payload).toEqual(msgDraft('Unsaved 2'));
      const message = (await lisa.get(`/api/v1/messages/${m.id}`).expect(200)).body;
      expect(message).toMatchObject({ textContent: 'Saved.', version: 1 });
      expect(await prisma.messageVersion.count({ where: { messageId: m.id } })).toBe(1);
      // Autosave is not a "Recent change".
      const activity = await prisma.customerActivity.count({
        where: { user: { email: emails[0] }, entityId: m.id, type: { not: 'MESSAGE_CREATED' } },
      });
      expect(activity).toBe(0);
    });

    it('the same payload again writes nothing', async () => {
      const m = await newMessage();
      const url = `${drafts}/MESSAGE/${m.id}`;
      const first = (await lisa.put(url).send({ payload: msgDraft('Same'), baseRevision: '1' }).expect(200)).body;
      await new Promise((r) => setTimeout(r, 20));
      const again = (await lisa.put(url).send({ payload: msgDraft('Same'), baseRevision: '1' }).expect(200)).body;
      expect(again.updatedAt).toBe(first.updatedAt);
    });

    it('an explicit save clears it; a discard clears it', async () => {
      const m = await newMessage();
      const url = `${drafts}/MESSAGE/${m.id}`;
      await lisa.put(url).send({ payload: msgDraft('Unsaved'), baseRevision: '1' }).expect(200);
      await lisa.patch(`/api/v1/messages/${m.id}`).send({ textContent: 'Unsaved' }).expect(200);
      expect((await lisa.get(url).expect(200)).body).toEqual({});
      await lisa.put(url).send({ payload: msgDraft('Again'), baseRevision: '2' }).expect(200);
      await lisa.delete(url).expect(204);
      expect((await lisa.get(url).expect(200)).body).toEqual({});
    });

    it('a draft identical to what is saved is cleared, not offered', async () => {
      const m = await newMessage();
      const url = `${drafts}/MESSAGE/${m.id}`;
      await lisa.put(url).send({ payload: msgDraft('Saved.  '), baseRevision: '1' }).expect(200);
      expect((await lisa.get(url).expect(200)).body).toEqual({});
      expect(await rowsFor(emails[0]).then((r) => r.filter((d) => d.key === m.id))).toEqual([]);
    });

    it('flags a conflict when the message was saved elsewhere after the draft started', async () => {
      const m = await newMessage();
      const url = `${drafts}/MESSAGE/${m.id}`;
      // Another tab saves (version 2) while this tab still edits from version 1.
      await lisa.patch(`/api/v1/messages/${m.id}`).send({ textContent: 'Other tab' }).expect(200);
      await lisa.put(url).send({ payload: msgDraft('This tab'), baseRevision: '1' }).expect(200);
      expect((await lisa.get(url).expect(200)).body).toMatchObject({
        baseRevision: '1',
        currentRevision: '2',
        conflict: true,
      });
    });

    it('SCHEDULED or RELEASED: autosave is 409 and the status never changes', async () => {
      const m = await newMessage();
      const url = `${drafts}/MESSAGE/${m.id}`;
      for (const status of ['SCHEDULED', 'RELEASED'] as const) {
        await prisma.message.update({ where: { id: m.id }, data: { status } });
        await lisa.put(url).send({ payload: msgDraft('x'), baseRevision: '1' }).expect(409);
        expect((await prisma.message.findUniqueOrThrow({ where: { id: m.id } })).status).toBe(status);
      }
    });

    it('rejects anything but the editable text fields', async () => {
      const m = await newMessage();
      const url = `${drafts}/MESSAGE/${m.id}`;
      for (const payload of [
        { ...msgDraft('x'), status: 'RELEASED' },
        { ...msgDraft('x'), ownerUserId: crypto.randomUUID() },
        { ...msgDraft('x'), recipientIds: [sofiaId] },
        { ...msgDraft('x'), contentType: 'DOCUMENT' },
        { ...msgDraft('x'), textContent: 'x'.repeat(20_001) },
        { title: 'only a title' },
        'a string',
        ['an', 'array'],
      ]) {
        await lisa.put(url).send({ payload, baseRevision: '1' }).expect(400);
      }
      await lisa.put(url).send({ payload: msgDraft('x'), baseRevision: '1', userId: 'x' }).expect(400);
      await lisa.put(`${drafts}/SOMETHING/${m.id}`).send({ payload: msgDraft('x'), baseRevision: '1' }).expect(400);
      await lisa.put(`${drafts}/MESSAGE/not-a-uuid`).send({ payload: msgDraft('x'), baseRevision: '1' }).expect(404);
    });

    it("another Customer can't read, overwrite or discard Lisa's draft", async () => {
      const m = await newMessage();
      const url = `${drafts}/MESSAGE/${m.id}`;
      await lisa.put(url).send({ payload: msgDraft('Lisa only'), baseRevision: '1' }).expect(200);
      await john.get(url).expect(404);
      await john.put(url).send({ payload: msgDraft('John'), baseRevision: '1' }).expect(404);
      await john.delete(url).expect(204);
      expect((await lisa.get(url).expect(200)).body.payload.textContent).toBe('Lisa only');
    });
  });

  describe('a never-saved new message', () => {
    it('the server issues the key; the newest is offered; saving the message clears it', async () => {
      const issued = (await lisa.post(`${drafts}/NEW_MESSAGE`).send({ payload: msgDraft('Draft 1') }).expect(201)).body;
      expect(issued.key).toMatch(/^[0-9a-f-]{36}$/);
      await lisa
        .put(`${drafts}/NEW_MESSAGE/${issued.key}`)
        .send({ payload: msgDraft('Draft 1b'), baseRevision: 'none' })
        .expect(200);
      expect((await lisa.get(`${drafts}/NEW_MESSAGE`).expect(200)).body).toMatchObject({
        key: issued.key,
        payload: msgDraft('Draft 1b'),
        conflict: false,
      });
      // A key the server never issued (or someone else's) is 404.
      await lisa
        .put(`${drafts}/NEW_MESSAGE/${crypto.randomUUID()}`)
        .send({ payload: msgDraft('x'), baseRevision: 'none' })
        .expect(404);
      await john
        .put(`${drafts}/NEW_MESSAGE/${issued.key}`)
        .send({ payload: msgDraft('x'), baseRevision: 'none' })
        .expect(404);
      expect((await john.get(`${drafts}/NEW_MESSAGE`).expect(200)).body).toEqual({});
      // No Message row exists until the explicit save.
      const before = await prisma.message.count({ where: { owner: { email: emails[0] } } });
      await lisa
        .post('/api/v1/messages')
        .send({ ...msgDraft('Draft 1b'), recipientIds: [sofiaId], recoveryDraftKey: issued.key })
        .expect(201);
      expect(await prisma.message.count({ where: { owner: { email: emails[0] } } })).toBe(before + 1);
      expect((await lisa.get(`${drafts}/NEW_MESSAGE`).expect(200)).body).toEqual({});
    });

    it('keeps at most the 5 newest unsaved new messages', async () => {
      for (let i = 0; i < 7; i++) {
        await lisa.post(`${drafts}/NEW_MESSAGE`).send({ payload: msgDraft(`n${i}`) }).expect(201);
      }
      const rows = (await rowsFor(emails[0])).filter((d) => d.type === 'NEW_MESSAGE');
      expect(rows).toHaveLength(5);
      expect((await lisa.get(`${drafts}/NEW_MESSAGE`).expect(200)).body.payload.textContent).toBe('n6');
    });
  });

  describe('My Story', () => {
    const url = `${drafts}/MY_STORY/${story}`;
    const answer = `/api/v1/my-story/prompts/${story}/response`;

    it('autosaves an unsaved answer; the explicit save clears it', async () => {
      // Nothing saved yet: the base is the hash of no text.
      await lisa.put(url).send({ payload: { textContent: 'Half a memory' }, baseRevision: textRevision('') }).expect(200);
      expect((await lisa.get(url).expect(200)).body).toMatchObject({
        payload: { textContent: 'Half a memory' },
        conflict: false,
      });
      // Not an answer until saved.
      expect((await lisa.get(`/api/v1/my-story/prompts/${story}`).expect(200)).body.answered).toBe(false);
      await lisa.put(answer).send({ textContent: 'A whole memory' }).expect(200);
      expect((await lisa.get(url).expect(200)).body).toEqual({});
    });

    it('flags a conflict when the saved answer changed after the draft started', async () => {
      await lisa.put(url).send({ payload: { textContent: 'Edited here' }, baseRevision: textRevision('Older text') }).expect(200);
      expect((await lisa.get(url).expect(200)).body).toMatchObject({
        currentRevision: textRevision('A whole memory'),
        conflict: true,
      });
      await lisa.delete(url).expect(204);
    });

    it("is per Customer: John's draft for the same prompt is his own", async () => {
      await lisa.put(url).send({ payload: { textContent: 'Lisa story' }, baseRevision: 'x' }).expect(200);
      expect((await john.get(url).expect(200)).body).toEqual({});
      await john.put(url).send({ payload: { textContent: 'John story' }, baseRevision: 'none' }).expect(200);
      expect((await lisa.get(url).expect(200)).body.payload.textContent).toBe('Lisa story');
    });

    it('unknown prompts and extra fields are refused', async () => {
      await lisa.put(`${drafts}/MY_STORY/no.such-prompt`).send({ payload: { textContent: 'x' }, baseRevision: 'none' }).expect(404);
      await lisa
        .put(url)
        .send({ payload: { textContent: 'x', promptTextSnapshot: 'y' }, baseRevision: 'none' })
        .expect(400);
    });
  });

  describe('My Wishes', () => {
    const url = `${drafts}/MY_WISHES/${wish}`;

    it('autosaves without any notice acknowledgement (the notice is informational)', async () => {
      await lisa.put(url).send({ payload: { textContent: 'A quiet ceremony' }, baseRevision: 'none' }).expect(200);
      expect((await lisa.get(url).expect(200)).body.payload.textContent).toBe('A quiet ceremony');
      // Not a saved wish.
      expect((await lisa.get(`/api/v1/my-wishes/prompts/${wish}`).expect(200)).body.answered).toBe(false);
      // John never sees Lisa's draft; his own is separate.
      expect((await john.get(url).expect(200)).body).toEqual({});
      await john.put(url).send({ payload: { textContent: 'x' }, baseRevision: 'none' }).expect(200);
      expect((await lisa.get(url).expect(200)).body.payload.textContent).toBe('A quiet ceremony');
    });

    it('the explicit save clears it', async () => {
      await lisa.put(`/api/v1/my-wishes/prompts/${wish}/response`).send({ textContent: 'Saved wish' }).expect(200);
      expect((await lisa.get(url).expect(200)).body).toEqual({});
    });
  });

  it('expired drafts are never offered and are removed on the next autosave', async () => {
    const m = await newMessage();
    const url = `${drafts}/MESSAGE/${m.id}`;
    await lisa.put(url).send({ payload: msgDraft('Old'), baseRevision: '1' }).expect(200);
    await prisma.draftRecovery.updateMany({
      where: { user: { email: emails[0] }, key: m.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await lisa.get(url).expect(200)).body).toEqual({});
    await lisa.put(`${drafts}/MY_STORY/${story}`).send({ payload: { textContent: 'sweep' }, baseRevision: 'none' }).expect(200);
    expect((await rowsFor(emails[0])).some((d) => d.key === m.id)).toBe(false);
  });
});
