import { ConfigModule } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';
import session from 'express-session';
import request from 'supertest';
import { AuthModule } from '../src/auth/auth.module.js';
import { configureApp } from '../src/config/app.setup.js';
import { MediaModule } from '../src/media/media.module.js';
import { MalwareScanner } from '../src/media/scanner/malware-scanner.service.js';
import { MediaStorage } from '../src/media/storage/media-storage.service.js';
import { MemoryVaultModule } from '../src/memory-vault/memory-vault.module.js';
import { MessageReleaseService } from '../src/message-release/message-release.service.js';
import { MessageSchedulesModule } from '../src/message-schedules/message-schedules.module.js';
import { MessagesModule } from '../src/messages/messages.module.js';
import { MyStoryModule } from '../src/my-story/my-story.module.js';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { RecipientAuthModule } from '../src/recipient-auth/recipient-auth.module.js';
import {
  RecipientOtpDelivery,
  type OtpDeliveryInput,
} from '../src/recipient-auth/recipient-otp-delivery.js';
import { RecipientPortalModule } from '../src/recipient-portal/recipient-portal.module.js';
import { RecipientsModule } from '../src/recipients/recipients.module.js';
import { RedisModule } from '../src/redis/redis.module.js';
import { FAKE_MALWARE, FakeMalwareScanner } from './fake-malware-scanner.js';
import { FakeMediaStorage, fileStart } from './fake-media-storage.js';

// Phase 14B: rich My Story answers (photo/audio/video, linked memories) and
// Story → Message: an independent DRAFT that goes through the normal
// recipients, schedule, release, grant and Recipient Portal. The answer and
// its linked memories stay private. Real HTTP, PostgreSQL and Redis; fake
// ImageKit, scanner and OTP delivery. Fictional data; test users removed.
describe('My Story rich answers + Story → Message (e2e, Phase 14B)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let queue: Queue;
  const run = Date.now();
  const queueName = `test-my-story-rich-${run}`;
  const at = (name: string) => `${name}.${run}@example.test`;
  const customers = ['lisa', 'john'].map((n) => at(`story.${n}`));
  const password = 'StrongPassword123!';
  const SOFIA = at('story.sofia');

  const sent: OtpDeliveryInput[] = [];
  const delivery = {
    sendOtp: vi.fn(async (input: OtpDeliveryInput) => {
      sent.push(input);
    }),
  };
  const storage = new FakeMediaStorage();
  const scanner = new FakeMalwareScanner();

  type Agent = ReturnType<typeof request.agent>;
  let lisa: Agent;
  let john: Agent;
  const ids: Record<string, string> = {};
  const api = (path: string) => `/api/v1${path}`;
  const KEY = 'travel.journey';
  const story = (key = KEY) => api(`/my-story/prompts/${key}`);
  const answer = (key = KEY) => `${story(key)}/response`;
  const media = (key = KEY) => `${answer(key)}/media`;

  const signIn = async (email: string) => {
    const agent = request.agent(app.getHttpServer());
    await agent.post(api('/auth/login')).send({ email, password }).expect(200);
    return agent;
  };
  // Upload auth → (fake) direct ImageKit upload → verified complete.
  const attach = async (
    agent: Agent,
    kind: 'PHOTO' | 'AUDIO' | 'VIDEO',
    mimeType: string,
    { key = KEY, bytes = fileStart(mimeType), expect: status = 200 } = {},
  ) => {
    const res = await agent
      .post(`${media(key)}/upload-url`)
      .send({
        kind,
        mimeType,
        originalFileName: `${kind.toLowerCase()}.bin`,
        sizeBytes: bytes.length,
      })
      .expect(201);
    const fileId = storage.upload(res.body.upload, {
      sizeBytes: bytes.length,
      contentType: mimeType,
      bytes,
    });
    await agent
      .post(`${media(key)}/${res.body.mediaAssetId}/complete`)
      .send({ providerFileId: fileId })
      .expect(status);
    return res.body.mediaAssetId as string;
  };
  const schedule = (agent: Agent, id: string) =>
    agent.post(api(`/messages/${id}/schedule`)).send({
      triggerType: 'FIXED_DATE',
      scheduledFor: new Date(Date.now() + 3_600_000).toISOString(),
    });
  const memory = async (agent: Agent, title: string) =>
    (
      await agent
        .post(api('/memory-vault'))
        .send({
          title,
          category: 'TRAVEL',
          textContent: 'Private memory text.',
        })
        .expect(201)
    ).body.id as string;

  beforeAll(async () => {
    process.env.RELEASE_QUEUE_NAME = queueName;
    process.env.RELEASE_RECONCILE_INTERVAL_SECONDS = '3600';
    process.env.RECIPIENT_OTP_IP_REQUEST_LIMIT = '10000';
    process.env.RECIPIENT_OTP_VERIFY_IP_LIMIT = '10000';
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        RedisModule,
        AuthModule,
        RecipientsModule,
        MessagesModule,
        MessageSchedulesModule,
        MediaModule,
        MemoryVaultModule,
        MyStoryModule,
        RecipientAuthModule,
        RecipientPortalModule,
      ],
    })
      .overrideProvider(MediaStorage)
      .useValue(storage)
      .overrideProvider(MalwareScanner)
      .useValue(scanner)
      .overrideProvider(RecipientOtpDelivery)
      .useValue(delivery)
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app, new session.MemoryStore());
    await app.init();
    prisma = app.get(PrismaService);
    queue = new Queue(queueName, {
      connection: { url: process.env.REDIS_URL! },
    });

    for (const email of customers) {
      await request(app.getHttpServer())
        .post(api('/auth/register'))
        .send({ email, password, firstName: 'Test', lastName: 'User' })
        .expect(201);
    }
    lisa = await signIn(customers[0]);
    john = await signIn(customers[1]);
    ids.sofia = (
      await lisa
        .post(api('/recipients'))
        .send({ firstName: 'Sofia', email: SOFIA })
        .expect(201)
    ).body.id;
    ids.memA = await memory(lisa, 'Train to Kalgoorlie');
    ids.memB = await memory(lisa, 'Night in Esperance');
    ids.johnMem = await memory(john, 'John’s trip');
  });

  afterAll(async () => {
    await prisma?.user.deleteMany({ where: { email: { in: customers } } });
    await queue?.obliterate({ force: true }).catch(() => undefined);
    await queue?.close();
    await app?.close();
  });

  it('a file can start an answer: a shell is never “answered” until something is READY', async () => {
    const res = await lisa
      .post(`${media()}/upload-url`)
      .send({
        kind: 'PHOTO',
        mimeType: 'image/jpeg',
        originalFileName: 'a.jpg',
        sizeBytes: 6,
      })
      .expect(201);
    ids.pendingPhoto = res.body.mediaAssetId;
    // Uploading (PENDING): not an answer yet.
    expect((await lisa.get(story()).expect(200)).body).toMatchObject({
      answered: false,
      response: null,
    });
    await lisa.get(answer()).expect(404);
    // It reserves storage like any upload (Phase 12C).
    expect(
      (await lisa.get(api('/users/me/storage')).expect(200)).body.reservedBytes,
    ).toBe(6);
    const fileId = storage.upload(res.body.upload, {
      sizeBytes: 6,
      contentType: 'image/jpeg',
    });
    await lisa
      .post(`${media()}/${ids.pendingPhoto}/complete`)
      .send({ providerFileId: fileId })
      .expect(200);
    const got = await lisa.get(answer()).expect(200);
    expect(got.body).toMatchObject({
      textContent: null,
      mediaCount: 1,
      memories: [],
    });
    ids.photo = ids.pendingPhoto;
  });

  it('text + audio + video join the same answer; an infected file never becomes READY', async () => {
    await lisa
      .put(answer())
      .send({ textContent: 'My first trip was by train.' })
      .expect(200);
    ids.audio = await attach(lisa, 'AUDIO', 'audio/mpeg');
    ids.video = await attach(lisa, 'VIDEO', 'video/mp4');
    const bad = await attach(lisa, 'PHOTO', 'image/jpeg', {
      bytes: new Uint8Array([
        ...fileStart('image/jpeg'),
        ...Buffer.from(FAKE_MALWARE),
      ]),
      expect: 400,
    });
    await lisa.get(`${media()}/${bad}/access-url`).expect(409);
    const list = (await lisa.get(media()).expect(200)).body as {
      id: string;
      kind: string;
      status: string;
    }[];
    expect(list.map((m) => [m.kind, m.status])).toEqual([
      ['PHOTO', 'READY'],
      ['AUDIO', 'READY'],
      ['VIDEO', 'READY'],
      ['PHOTO', 'FAILED'],
    ]);
    expect((await lisa.get(answer()).expect(200)).body.mediaCount).toBe(3);
    const access = await lisa
      .get(`${media()}/${ids.video}/access-url`)
      .expect(200);
    expect(access.body.url).toMatch(/^https:\/\/media\.test\/signed/);
    expect(JSON.stringify(list)).not.toMatch(
      /storageKey|providerFileId|ownerUserId|my-story\//,
    );
  });

  it('another Customer can neither see, sign, change nor delete these files', async () => {
    expect((await john.get(media()).expect(200)).body).toEqual([]);
    await john.get(`${media()}/${ids.video}/access-url`).expect(404);
    await john.delete(`${media()}/${ids.video}`).expect(404);
    await john
      .post(`${media()}/${ids.video}/complete`)
      .send({ providerFileId: 'x' })
      .expect(404);
    await john.get(answer()).expect(404);
  });

  it('links own live memories; replace the set; another Customer’s or a deleted memory is refused', async () => {
    const linked = await lisa
      .put(answer())
      .send({ memoryVaultItemIds: [ids.memA, ids.memB] })
      .expect(200);
    expect(linked.body.memories).toEqual([
      { id: ids.memA, title: 'Train to Kalgoorlie', category: 'TRAVEL' },
      { id: ids.memB, title: 'Night in Esperance', category: 'TRAVEL' },
    ]);
    // Text was omitted: unchanged.
    expect(linked.body.textContent).toBe('My first trip was by train.');
    const replaced = await lisa
      .put(answer())
      .send({ memoryVaultItemIds: [ids.memB] })
      .expect(200);
    expect(replaced.body.memories.map((m: { id: string }) => m.id)).toEqual([
      ids.memB,
    ]);
    // John's memory looks like a missing one; nothing changes.
    const foreign = await lisa
      .put(answer())
      .send({ memoryVaultItemIds: [ids.johnMem] })
      .expect(400);
    expect(foreign.body.message).toBe('One or more memories are invalid.');
    await lisa
      .put(answer())
      .send({ memoryVaultItemIds: [ids.memA, ids.memB] })
      .expect(200);
    // A memory deleted later: hidden from the answer, the answer stays.
    await lisa.delete(api(`/memory-vault/${ids.memA}`)).expect(204);
    const after = await lisa.get(answer()).expect(200);
    expect(after.body.memories.map((m: { id: string }) => m.id)).toEqual([
      ids.memB,
    ]);
    await lisa
      .put(answer())
      .send({ memoryVaultItemIds: [ids.memA] })
      .expect(400);
  });

  it('a links-only answer is an answer; an empty one is refused', async () => {
    const key = 'travel.place';
    await lisa.put(answer(key)).send({}).expect(400);
    const res = await lisa
      .put(answer(key))
      .send({ memoryVaultItemIds: [ids.memB] })
      .expect(200);
    expect(res.body).toMatchObject({ textContent: null, mediaCount: 0 });
    // Clearing the only content is refused (the answer keeps its link).
    await lisa.put(answer(key)).send({ memoryVaultItemIds: [] }).expect(400);
    await lisa.delete(answer(key)).expect(204);
  });

  it('Story → Message: an independent DRAFT with copied text and READY copies; never the linked memories', async () => {
    const res = await lisa
      .post(`${answer()}/messages`)
      .send({
        title: 'For Sofia',
        contentType: 'MIXED',
        includeText: true,
        mediaAssetIds: [ids.photo, ids.audio, ids.video],
        recipientIds: [ids.sofia],
      })
      .expect(201);
    ids.message = res.body.id;
    expect(res.body).toMatchObject({
      status: 'DRAFT',
      contentType: 'MIXED',
      textContent: 'My first trip was by train.',
      recipients: [{ id: ids.sofia }],
    });
    expect(JSON.stringify(res.body)).not.toMatch(
      /memor|Kalgoorlie|Esperance|travel\.journey|promptKey|my-story/i,
    );
    const copies = await prisma.mediaAsset.findMany({
      where: { messageId: ids.message },
      orderBy: { createdAt: 'asc' },
    });
    const sources = await prisma.myStoryMediaAsset.findMany({
      where: { id: { in: [ids.photo, ids.audio, ids.video] } },
    });
    expect(copies.map((c) => [c.kind, c.status])).toEqual([
      ['PHOTO', 'READY'],
      ['AUDIO', 'READY'],
      ['VIDEO', 'READY'],
    ]);
    for (const c of copies) {
      expect(c.storageKey).toContain(`/messages/${ids.message}/`);
      expect(sources.map((s) => s.providerFileId)).not.toContain(
        c.providerFileId,
      );
      expect(sources.map((s) => s.id)).not.toContain(c.id);
    }
    // A Story file id is never a Message file id.
    await lisa
      .get(api(`/messages/${ids.message}/media/${ids.photo}/access-url`))
      .expect(404);
  });

  it('only own answers and files; explicit type; drafts still follow composition at scheduling', async () => {
    const body = (over: object) => ({
      title: 'x',
      contentType: 'PHOTO',
      includeText: false,
      mediaAssetIds: [ids.photo],
      recipientIds: [ids.sofia],
      ...over,
    });
    await john
      .post(`${answer()}/messages`)
      .send(body({ recipientIds: [] }))
      .expect(400);
    // John's own recipient, Lisa's answer: looks like a missing answer.
    const sam = (
      await john.post(api('/recipients')).send({ firstName: 'Sam' }).expect(201)
    ).body.id;
    await john
      .post(`${answer()}/messages`)
      .send(body({ recipientIds: [sam] }))
      .expect(404);
    for (const contentType of [undefined, 'STORY'])
      await lisa
        .post(`${answer()}/messages`)
        .send(body({ contentType }))
        .expect(400);
    // Another answer's file (or another Customer's) looks invalid.
    const other = await attach(lisa, 'PHOTO', 'image/png', {
      key: 'work.first-job',
    });
    await lisa
      .post(`${answer()}/messages`)
      .send(body({ mediaAssetIds: [other] }))
      .expect(400);
    await lisa
      .post(`${answer('work.first-job')}/messages`)
      .send(body({ mediaAssetIds: [ids.photo] }))
      .expect(400);
    // PHOTO with copied text, AUDIO with text, VIDEO with text, MIXED with
    // one kind: drafts are created, scheduling refuses them.
    for (const over of [
      { contentType: 'PHOTO', includeText: true },
      { contentType: 'AUDIO', includeText: true, mediaAssetIds: [ids.audio] },
      { contentType: 'VIDEO', includeText: true, mediaAssetIds: [ids.video] },
      { contentType: 'TEXT', includeText: true },
      { contentType: 'MIXED', includeText: false },
    ]) {
      const draft = await lisa
        .post(`${answer()}/messages`)
        .send(body(over))
        .expect(201);
      await schedule(lisa, draft.body.id).expect(409);
      await lisa.delete(api(`/messages/${draft.body.id}`)).expect(204);
    }
  });

  it('the message is released to the Recipient: message and copies only, never My Story or the memory', async () => {
    await schedule(lisa, ids.message).expect(201);
    expect(
      await app
        .get(MessageReleaseService)
        .release(ids.message, new Date(Date.now() + 3_700_000)),
    ).toMatchObject({ result: 'released' });
    expect(
      await prisma.recipientMessageAccessGrant.count({
        where: { messageId: ids.message, recipientId: ids.sofia },
      }),
    ).toBe(1);
    const otp = await request(app.getHttpServer())
      .post(api('/recipient-auth/request-otp'))
      .send({ email: SOFIA })
      .expect(202);
    const sofia = request.agent(app.getHttpServer());
    await sofia
      .post(api('/recipient-auth/verify-otp'))
      .send({
        challengeId: otp.body.challengeId,
        code: sent.findLast((s) => s.email === SOFIA)!.code,
      })
      .expect(200);
    const detail = await sofia
      .get(api(`/recipient/messages/${ids.message}`))
      .expect(200);
    expect(detail.body.textContent).toBe('My first trip was by train.');
    const files = await sofia
      .get(api(`/recipient/messages/${ids.message}/media`))
      .expect(200);
    expect(files.body).toHaveLength(3);
    for (const f of files.body)
      await sofia
        .get(api(`/recipient/messages/${ids.message}/media/${f.id}/access-url`))
        .expect(200);
    expect(JSON.stringify(detail.body)).not.toMatch(
      /Kalgoorlie|Esperance|journey|my-story/i,
    );
    // Customer-only routes: no Recipient access to My Story or memories.
    for (const path of [
      '/my-story/prompts',
      `/my-story/prompts/${KEY}/response`,
      `/my-story/prompts/${KEY}/response/media`,
      `/my-story/prompts/${KEY}/response/media/${ids.photo}/access-url`,
      `/memory-vault/${ids.memB}`,
    ])
      await sofia.get(api(path)).expect(401);
  });

  it('editing or deleting the answer and its files never changes the message (and the reverse)', async () => {
    await lisa
      .put(answer())
      .send({ textContent: 'My first big trip was by train.' })
      .expect(200);
    await lisa.delete(`${media()}/${ids.photo}`).expect(204);
    let msg = await lisa.get(api(`/messages/${ids.message}`)).expect(200);
    expect(msg.body.textContent).toBe('My first trip was by train.');
    let files = (
      await lisa.get(api(`/messages/${ids.message}/media`)).expect(200)
    ).body;
    expect(files.map((f: { status: string }) => f.status)).toEqual([
      'READY',
      'READY',
      'READY',
    ]);
    await lisa
      .get(api(`/messages/${ids.message}/media/${files[0].id}/access-url`))
      .expect(200);

    // A second message from the same answer, then deleted with its copy:
    // the answer, its files and its links are untouched.
    const second = await lisa
      .post(`${answer()}/messages`)
      .send({
        title: 'Again',
        contentType: 'AUDIO',
        includeText: false,
        mediaAssetIds: [ids.audio],
        recipientIds: [ids.sofia],
      })
      .expect(201);
    const [copy] = (
      await lisa.get(api(`/messages/${second.body.id}/media`)).expect(200)
    ).body;
    await lisa
      .delete(api(`/messages/${second.body.id}/media/${copy.id}`))
      .expect(204);
    await lisa.delete(api(`/messages/${second.body.id}`)).expect(204);
    const still = await lisa.get(answer()).expect(200);
    expect(still.body).toMatchObject({
      mediaCount: 2,
      memories: [{ id: ids.memB }],
    });
    await lisa.get(`${media()}/${ids.audio}/access-url`).expect(200);

    // Deleting the whole answer (files and links with it).
    await lisa.delete(answer()).expect(204);
    await lisa.get(answer()).expect(404);
    expect((await lisa.get(media()).expect(200)).body).toEqual([]);
    expect(
      await prisma.myStoryMemoryLink.count({
        where: { memoryVaultItemId: ids.memB },
      }),
    ).toBe(0);
    await lisa.get(api(`/memory-vault/${ids.memB}`)).expect(200);
    msg = await lisa.get(api(`/messages/${ids.message}`)).expect(200);
    expect(msg.body).toMatchObject({
      status: 'RELEASED',
      textContent: 'My first trip was by train.',
    });
    files = (await lisa.get(api(`/messages/${ids.message}/media`)).expect(200))
      .body;
    await lisa
      .get(api(`/messages/${ids.message}/media/${files[2].id}/access-url`))
      .expect(200);
    // Re-answering after the delete starts empty with the current wording.
    const again = await lisa
      .put(answer())
      .send({ textContent: 'Written again.' })
      .expect(200);
    expect(again.body).toMatchObject({
      mediaCount: 0,
      memories: [],
      promptTextSnapshot: 'Tell us about a journey that stayed with you.',
    });
  });
});
