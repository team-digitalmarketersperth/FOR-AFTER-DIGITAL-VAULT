import { ConfigModule } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import session from 'express-session';
import request from 'supertest';
import { AuthModule } from '../src/auth/auth.module.js';
import { configureApp } from '../src/config/app.setup.js';
import { MediaModule } from '../src/media/media.module.js';
import { MalwareScanner } from '../src/media/scanner/malware-scanner.service.js';
import { MediaStorage } from '../src/media/storage/media-storage.service.js';
import { STORAGE_FULL } from '../src/media/storage-quota.service.js';
import { MemoryVaultModule } from '../src/memory-vault/memory-vault.module.js';
import { MessagesModule } from '../src/messages/messages.module.js';
import { MyStoryModule } from '../src/my-story/my-story.module.js';
import { MyWishesModule } from '../src/my-wishes/my-wishes.module.js';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { RecipientsModule } from '../src/recipients/recipients.module.js';
import { FakeMalwareScanner } from './fake-malware-scanner.js';
import { FakeMediaStorage } from './fake-media-storage.js';

// Storage Manager: the read-only list + breakdown over real PostgreSQL, and
// deletion through each feature's own endpoint. Synthetic READY rows are
// written straight to the database (no real files); the provider and scanner
// are fakes. A tiny limit makes "full" cheap.
describe('Storage Manager (e2e, PostgreSQL)', () => {
  const LIMIT = 10_000;
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const run = Date.now();
  const emails = ['ana', 'ben'].map(
    (n) => `storage-mgr.${n}.${run}@example.test`,
  );
  const password = 'StrongPassword123!';
  const storage = new FakeMediaStorage();
  type Agent = ReturnType<typeof request.agent>;
  let ana: Agent;
  let ben: Agent;
  const api = (p: string) => `/api/v1${p}`;
  const owner: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const STORY = 'childhood.earliest-memory';
  const WISH = 'ceremony.style';

  const signIn = async (email: string) => {
    const agent = request.agent(app.getHttpServer());
    await agent.post(api('/auth/login')).send({ email, password }).expect(200);
    return agent;
  };
  const usage = async (agent: Agent) =>
    (await agent.get(api('/users/me/storage')).expect(200)).body;
  const items = async (agent: Agent, query = '') =>
    (await agent.get(api(`/users/me/storage/items${query}`)).expect(200)).body;
  // A synthetic file row, as a finished upload leaves it.
  const file = (
    ownerUserId: string,
    kind: 'PHOTO' | 'AUDIO' | 'VIDEO',
    sizeBytes: number,
    createdAt: Date,
  ) => {
    const id = randomUUID();
    return {
      id,
      ownerUserId,
      kind,
      sizeBytes,
      createdAt,
      status: 'READY' as const,
      storageKey: `/test/storage-mgr/${run}/${id}`,
      providerFileId: `provider-${id}`,
      originalFileName: 'synthetic-private-name.bin',
      mimeType:
        kind === 'PHOTO'
          ? 'image/jpeg'
          : kind === 'AUDIO'
            ? 'audio/mpeg'
            : 'video/mp4',
      uploadedAt: createdAt,
    };
  };
  const day = (n: number) => new Date(Date.UTC(2026, 8, n));

  beforeAll(async () => {
    process.env.STORAGE_LIMIT_BYTES = String(LIMIT);
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        AuthModule,
        RecipientsModule,
        MessagesModule,
        MediaModule,
        MemoryVaultModule,
        MyStoryModule,
        MyWishesModule,
      ],
    })
      .overrideProvider(MediaStorage)
      .useValue(storage)
      .overrideProvider(MalwareScanner)
      .useValue(new FakeMalwareScanner())
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app, new session.MemoryStore());
    await app.init();
    prisma = app.get(PrismaService);
    for (const email of emails) {
      await request(app.getHttpServer())
        .post(api('/auth/register'))
        .send({ email, password, firstName: 'Test', lastName: 'User' })
        .expect(201);
    }
    ana = await signIn(emails[0]);
    ben = await signIn(emails[1]);
    for (const [i, email] of emails.entries()) {
      owner[i ? 'ben' : 'ana'] = (
        await prisma.user.findUniqueOrThrow({ where: { email } })
      ).id;
    }

    // Ana: one file in every source; three messages in three states.
    const a = owner.ana;
    const recipient = await prisma.recipient.create({
      data: { ownerUserId: a, firstName: 'Sofia', lastName: 'Rossi' },
    });
    ids.recipient = recipient.id;
    const message = (
      title: string,
      status: 'DRAFT' | 'SCHEDULED' | 'RELEASED',
    ) =>
      prisma.message.create({
        data: { ownerUserId: a, title, contentType: 'MIXED', status },
      });
    ids.draft = (await message('Draft letter', 'DRAFT')).id;
    ids.scheduled = (await message('Birthday video', 'SCHEDULED')).id;
    ids.released = (await message('Released letter', 'RELEASED')).id;
    ids.memory = (
      await prisma.memoryVaultItem.create({
        data: {
          ownerUserId: a,
          title: 'Family holiday',
          category: 'OTHER',
          textContent: 'PRIVATE MEMORY TEXT',
        },
      })
    ).id;
    const promptCopy = { promptVersion: 1, textContent: 'PRIVATE ANSWER TEXT' };
    const story = await prisma.myStoryResponse.create({
      data: {
        ownerUserId: a,
        promptKey: STORY,
        promptTextSnapshot: 'What is your earliest memory?',
        ...promptCopy,
      },
    });
    const wish = await prisma.myWishResponse.create({
      data: {
        ownerUserId: a,
        promptKey: WISH,
        promptTextSnapshot: 'What style of ceremony would you like?',
        ...promptCopy,
      },
    });

    const draftPhoto = file(a, 'PHOTO', 1500, day(5));
    const scheduledVideo = file(a, 'VIDEO', 3000, day(6));
    const releasedAudio = file(a, 'AUDIO', 500, day(7));
    const memoryPhoto = file(a, 'PHOTO', 2000, day(8));
    const storyAudio = file(a, 'AUDIO', 400, day(9));
    const wishPhoto = file(a, 'PHOTO', 300, day(10));
    const recipientPhoto = file(a, 'PHOTO', 100, day(11));
    Object.assign(ids, {
      draftPhoto: draftPhoto.id,
      scheduledVideo: scheduledVideo.id,
      releasedAudio: releasedAudio.id,
      memoryPhoto: memoryPhoto.id,
      storyAudio: storyAudio.id,
      wishPhoto: wishPhoto.id,
      recipientPhoto: recipientPhoto.id,
    });
    await prisma.mediaAsset.createMany({
      data: [
        { ...draftPhoto, messageId: ids.draft },
        { ...scheduledVideo, messageId: ids.scheduled },
        { ...releasedAudio, messageId: ids.released },
      ],
    });
    await prisma.memoryVaultMediaAsset.create({
      data: { ...memoryPhoto, memoryVaultItemId: ids.memory },
    });
    await prisma.myStoryMediaAsset.create({
      data: { ...storyAudio, myStoryResponseId: story.id },
    });
    await prisma.myWishMediaAsset.create({
      data: { ...wishPhoto, myWishResponseId: wish.id },
    });
    await prisma.recipientPhoto.create({
      data: { ...recipientPhoto, kind: 'PHOTO', recipientId: ids.recipient },
    });
    // Not files: an upload in progress, a FAILED one and a deleted one.
    await prisma.memoryVaultMediaAsset.createMany({
      data: [
        {
          ...file(a, 'PHOTO', 700, day(12)),
          status: 'PENDING_UPLOAD',
          memoryVaultItemId: ids.memory,
        },
        {
          ...file(a, 'PHOTO', 900, day(12)),
          status: 'FAILED',
          memoryVaultItemId: ids.memory,
        },
        {
          ...file(a, 'PHOTO', 800, day(12)),
          deletedAt: new Date(),
          memoryVaultItemId: ids.memory,
        },
      ],
    });

    // Ben: one large file that must never appear for Ana.
    const benMemory = await prisma.memoryVaultItem.create({
      data: { ownerUserId: owner.ben, title: 'Ben secret', category: 'OTHER' },
    });
    ids.benMemory = benMemory.id;
    const benPhoto = file(owner.ben, 'PHOTO', 9000, day(1));
    ids.benPhoto = benPhoto.id;
    await prisma.memoryVaultMediaAsset.create({
      data: { ...benPhoto, memoryVaultItemId: benMemory.id },
    });
  });

  afterAll(async () => {
    delete process.env.STORAGE_LIMIT_BYTES;
    await prisma?.user.deleteMany({ where: { email: { in: emails } } });
    await app?.close();
  });

  it('summary: owner-scoped totals and a per-source breakdown that sums to used', async () => {
    const u = await usage(ana);
    expect(u).toMatchObject({
      usedBytes: 7800,
      reservedBytes: 700,
      limitBytes: LIMIT,
      remainingBytes: 1500,
      percentage: 85,
      level: 'WARNING',
    });
    expect(u.breakdown).toEqual([
      { source: 'MESSAGE', bytes: 5000 },
      { source: 'MEMORY_VAULT', bytes: 2000 },
      { source: 'MY_STORY', bytes: 400 },
      { source: 'MY_WISHES', bytes: 300 },
      { source: 'RECIPIENT_PHOTO', bytes: 100 },
    ]);
    const sum = u.breakdown.reduce(
      (t: number, b: { bytes: number }) => t + b.bytes,
      0,
    );
    expect(sum).toBe(u.usedBytes);
    // Ben sees only his own 9000 bytes (90 %: HIGH).
    expect(await usage(ben)).toMatchObject({ usedBytes: 9000, level: 'HIGH' });
  });

  it('items: largest first by default, READY and live only, safe fields only', async () => {
    const page = await items(ana);
    expect(page.pagination).toEqual({ page: 1, limit: 25, total: 7, pages: 1 });
    expect(page.items.map((i: { sizeBytes: number }) => i.sizeBytes)).toEqual([
      3000, 2000, 1500, 500, 400, 300, 100,
    ]);
    const byId = Object.fromEntries(
      page.items.map((i: { id: string }) => [i.id, i]),
    );
    expect(byId[ids.memoryPhoto]).toEqual({
      id: ids.memoryPhoto,
      type: 'PHOTO',
      sizeBytes: 2000,
      source: 'MEMORY_VAULT',
      sourceId: ids.memory,
      displayName: 'Family holiday',
      createdAt: day(8).toISOString(),
      canDelete: true,
      deleteRestriction: null,
    });
    expect(byId[ids.storyAudio]).toMatchObject({
      source: 'MY_STORY',
      sourceId: STORY,
      displayName: 'What is your earliest memory?',
    });
    expect(byId[ids.wishPhoto]).toMatchObject({
      source: 'MY_WISHES',
      sourceId: WISH,
    });
    expect(byId[ids.recipientPhoto]).toMatchObject({
      source: 'RECIPIENT_PHOTO',
      sourceId: ids.recipient,
      displayName: 'Sofia Rossi',
      canDelete: true,
    });
    // Message media follows the message's own rule (DRAFT only).
    expect(byId[ids.draftPhoto]).toMatchObject({
      canDelete: true,
      deleteRestriction: null,
      displayName: 'Draft letter',
    });
    expect(byId[ids.scheduledVideo]).toMatchObject({
      canDelete: false,
      deleteRestriction: 'MESSAGE_SCHEDULED',
    });
    expect(byId[ids.releasedAudio]).toMatchObject({
      canDelete: false,
      deleteRestriction: 'MESSAGE_RELEASED',
    });
    // No provider internals, private text, owner or file names, ever.
    const text = JSON.stringify(page);
    for (const secret of [
      'storageKey',
      'providerFileId',
      'provider-',
      '/test/storage-mgr',
      'ownerUserId',
      'deletedAt',
      'storageDeletedAt',
      'synthetic-private-name',
      'PRIVATE MEMORY TEXT',
      'PRIVATE ANSWER TEXT',
      'http',
      owner.ana,
      'Ben secret',
      ids.benPhoto,
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it('sorting, type and source filters, paging: all in PostgreSQL and composable', async () => {
    const sizes = (p: { items: { sizeBytes: number }[] }) =>
      p.items.map((i) => i.sizeBytes);
    expect(sizes(await items(ana, '?sort=created_desc'))).toEqual([
      100, 300, 400, 2000, 500, 3000, 1500,
    ]);
    expect(sizes(await items(ana, '?sort=created_asc'))).toEqual([
      1500, 3000, 500, 2000, 400, 300, 100,
    ]);
    expect(sizes(await items(ana, '?type=PHOTO'))).toEqual([
      2000, 1500, 300, 100,
    ]);
    expect(sizes(await items(ana, '?type=AUDIO'))).toEqual([500, 400]);
    expect(sizes(await items(ana, '?type=VIDEO'))).toEqual([3000]);
    expect(sizes(await items(ana, '?source=MESSAGE'))).toEqual([
      3000, 1500, 500,
    ]);
    expect(sizes(await items(ana, '?source=MESSAGE&type=PHOTO'))).toEqual([
      1500,
    ]);
    const p1 = await items(ana, '?limit=3');
    const p2 = await items(ana, '?limit=3&page=2');
    const p3 = await items(ana, '?limit=3&page=3');
    expect([...sizes(p1), ...sizes(p2), ...sizes(p3)]).toEqual([
      3000, 2000, 1500, 500, 400, 300, 100,
    ]);
    expect(p3.pagination).toEqual({ page: 3, limit: 3, total: 7, pages: 3 });
    const empty = await items(ana, '?page=9');
    expect(empty).toEqual({
      items: [],
      pagination: { page: 9, limit: 25, total: 7, pages: 1 },
    });
    expect((await items(ana, '?source=MY_WISHES&type=VIDEO')).items).toEqual(
      [],
    );
    for (const bad of [
      '?type=DOC',
      '?source=OTHER',
      '?sort=name',
      '?limit=101',
      '?page=0',
      '?ownerUserId=x',
    ]) {
      await ana.get(api(`/users/me/storage/items${bad}`)).expect(400);
    }
  });

  it('a Customer session is required; another Customer sees none of Ana’s files', async () => {
    await request(app.getHttpServer())
      .get(api('/users/me/storage/items'))
      .expect(401);
    const page = await items(ben);
    expect(page.items.map((i: { id: string }) => i.id)).toEqual([ids.benPhoto]);
    // Even a filter on Ana's source cannot reveal her rows.
    expect((await items(ben, '?source=MESSAGE')).items).toEqual([]);
  });

  it('Message rules hold: SCHEDULED and RELEASED media cannot be deleted (409), not even by a crafted request', async () => {
    await ana
      .delete(api(`/messages/${ids.scheduled}/media/${ids.scheduledVideo}`))
      .expect(409);
    await ana
      .delete(api(`/messages/${ids.released}/media/${ids.releasedAudio}`))
      .expect(409);
    // The id of a file under another message is not found there.
    await ana
      .delete(api(`/messages/${ids.draft}/media/${ids.scheduledVideo}`))
      .expect(404);
    expect((await usage(ana)).usedBytes).toBe(7800);
  });

  it('another Customer cannot delete Ana’s media through any source route', async () => {
    await ben
      .delete(api(`/messages/${ids.draft}/media/${ids.draftPhoto}`))
      .expect(404);
    await ben
      .delete(api(`/memory-vault/${ids.memory}/media/${ids.memoryPhoto}`))
      .expect(404);
    await ben
      .delete(api(`/recipients/${ids.recipient}/photo/${ids.recipientPhoto}`))
      .expect(404);
    await ben
      .delete(
        api(`/my-story/prompts/${STORY}/response/media/${ids.storyAudio}`),
      )
      .expect(404);
    await ben
      .delete(api(`/my-wishes/prompts/${WISH}/response/media/${ids.wishPhoto}`))
      .expect(404);
    expect((await items(ana)).pagination.total).toBe(7);
  });

  it('a full quota blocks new uploads but never deletion; usage drops at once', async () => {
    // Fill Ana up: one more READY file takes her to 100 %.
    await prisma.memoryVaultMediaAsset.create({
      data: {
        ...file(owner.ana, 'PHOTO', 1500, day(13)),
        memoryVaultItemId: ids.memory,
      },
    });
    expect(await usage(ana)).toMatchObject({
      level: 'FULL',
      percentage: 100,
      remainingBytes: 0,
    });
    const upload = await ana
      .post(api(`/memory-vault/${ids.memory}/media/upload-url`))
      .send({
        kind: 'PHOTO',
        mimeType: 'image/jpeg',
        sizeBytes: 10,
        originalFileName: 'x.jpg',
      })
      .expect(409);
    expect(upload.body.message).toBe(STORAGE_FULL);
    // Listing still works when full.
    expect((await items(ana)).pagination.total).toBe(8);

    // Each source's own delete endpoint works while full.
    await ana
      .delete(api(`/memory-vault/${ids.memory}/media/${ids.memoryPhoto}`))
      .expect(204);
    await ana
      .delete(api(`/messages/${ids.draft}/media/${ids.draftPhoto}`))
      .expect(204);
    await ana
      .delete(
        api(`/my-story/prompts/${STORY}/response/media/${ids.storyAudio}`),
      )
      .expect(204);
    await ana
      .delete(api(`/my-wishes/prompts/${WISH}/response/media/${ids.wishPhoto}`))
      .expect(204);
    // Removing a Recipient's photo keeps the Recipient.
    await ana
      .delete(api(`/recipients/${ids.recipient}/photo/${ids.recipientPhoto}`))
      .expect(204);
    await ana.get(api(`/recipients/${ids.recipient}`)).expect(200);

    const u = await usage(ana);
    expect(u).toMatchObject({ usedBytes: 5000, level: 'NORMAL' });
    expect(u.breakdown).toEqual([
      { source: 'MESSAGE', bytes: 3500 },
      { source: 'MEMORY_VAULT', bytes: 1500 },
      { source: 'MY_STORY', bytes: 0 },
      { source: 'MY_WISHES', bytes: 0 },
      { source: 'RECIPIENT_PHOTO', bytes: 0 },
    ]);
    expect(
      (await items(ana)).items.map((i: { id: string }) => i.id),
    ).not.toContain(ids.memoryPhoto);
    // Uploads are possible again.
    await ana
      .post(api(`/memory-vault/${ids.memory}/media/upload-url`))
      .send({
        kind: 'PHOTO',
        mimeType: 'image/jpeg',
        sizeBytes: 10,
        originalFileName: 'x.jpg',
      })
      .expect(201);
  });

  it('a repeated delete is a safe 404; a failing provider delete never restores the file', async () => {
    await ana
      .delete(api(`/memory-vault/${ids.memory}/media/${ids.memoryPhoto}`))
      .expect(404);
    storage.deleteObject.mockRejectedValueOnce(new Error('provider down'));
    const [left] = (await items(ana, '?source=MEMORY_VAULT')).items;
    await ana
      .delete(api(`/memory-vault/${ids.memory}/media/${left.id}`))
      .expect(204);
    expect((await items(ana, '?source=MEMORY_VAULT')).items).toEqual([]);
    const row = await prisma.memoryVaultMediaAsset.findUniqueOrThrow({
      where: { id: left.id },
    });
    expect(row.deletedAt).not.toBeNull();
    // The cleanup reconciler retries the provider object later.
    expect(row.storageDeletedAt).toBeNull();
  });
});
