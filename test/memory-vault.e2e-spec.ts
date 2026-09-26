import { ConfigModule } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import session from 'express-session';
import request from 'supertest';
import { AuthModule } from '../src/auth/auth.module.js';
import { configureApp } from '../src/config/app.setup.js';
import { MediaStorage } from '../src/media/storage/media-storage.service.js';
import { MemoryVaultModule } from '../src/memory-vault/memory-vault.module.js';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

// Real HTTP, validation, guards, sessions and PostgreSQL; object storage is a
// deterministic mock, so no bucket or credential is ever used here.
// Fictional data only; the test users are removed afterwards.
describe('Memory Vault (e2e, PostgreSQL, mocked storage)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const run = Date.now();
  const emails = ['lisa', 'john', 'admin'].map(
    (name) => `memory.${name}.${run}@example.test`,
  );
  const password = 'StrongPassword123!';
  const storage = {
    createUploadUrl: vi.fn(async () => 'https://storage.test/signed-put'),
    createAccessUrl: vi.fn(async () => 'https://storage.test/signed-get'),
    headObject: vi.fn(async () => ({
      sizeBytes: 100_000,
      contentType: 'image/jpeg',
    })),
    deleteObject: vi.fn(async () => undefined),
  };

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
  let memoryId: string;
  let mediaId: string;
  let item: string;
  let media: string;
  const root = '/api/v1/memory-vault';
  const photo = {
    kind: 'PHOTO',
    originalFileName: 'family.jpg',
    mimeType: 'image/jpeg',
    sizeBytes: 100_000,
  };
  const noLeaks = (body: unknown) =>
    expect(JSON.stringify(body)).not.toMatch(
      /storageKey|ownerUserId|deletedAt|users\/|memory\.lisa|bucket|secret/i,
    );

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        AuthModule,
        MemoryVaultModule,
      ],
    })
      .overrideProvider(MediaStorage)
      .useValue(storage)
      .compile();
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

  it('requires a session (401), a customer (403) and UUIDs (400)', async () => {
    await request(app.getHttpServer()).get(root).expect(401);
    await request(app.getHttpServer())
      .post(root)
      .send({ title: 'x', category: 'FAMILY' })
      .expect(401);
    for (const role of ['ADMIN', 'SUPER_ADMIN'] as const) {
      await prisma.user.update({ where: { email: emails[2] }, data: { role } });
      const admin = await signIn(emails[2]);
      await admin.get(root).expect(403);
      await admin
        .post(root)
        .send({ title: 'x', category: 'FAMILY' })
        .expect(403);
    }
    const id = crypto.randomUUID();
    await lisa.get(`${root}/not-a-uuid`).expect(400);
    await lisa.patch(`${root}/not-a-uuid`).send({ title: 'x' }).expect(400);
    await lisa.delete(`${root}/not-a-uuid`).expect(400);
    await lisa.get(`${root}/not-a-uuid/media`).expect(400);
    await lisa
      .post(`${root}/not-a-uuid/media/upload-url`)
      .send(photo)
      .expect(400);
    await lisa.post(`${root}/${id}/media/not-a-uuid/complete`).expect(400);
    await lisa.get(`${root}/${id}/media/not-a-uuid/access-url`).expect(400);
    await lisa.delete(`${root}/${id}/media/not-a-uuid`).expect(400);
  });

  it('rejects invalid memory bodies (400)', async () => {
    const ok = { title: 'x', category: 'FAMILY' };
    for (const body of [
      { category: 'FAMILY' },
      { ...ok, title: '   ' },
      { ...ok, category: 'PETS' },
      { title: 'x' },
      { ...ok, ownerUserId: crypto.randomUUID() },
      { ...ok, deletedAt: null },
      { ...ok, recipientIds: [] },
      { ...ok, status: 'DRAFT' },
      { ...ok, contentType: 'MIXED' },
      { ...ok, imageUrl: 'https://example.test/a.jpg' },
    ]) {
      await lisa.post(root).send(body).expect(400);
    }
    await lisa.get(`${root}?category=PETS`).expect(400);
    await lisa.get(`${root}?search=x`).expect(400);
  });

  it('creates, lists (newest first, by category), reads and updates', async () => {
    const created = await lisa
      .post(root)
      .send({
        title: '  Christmas With My Family  ',
        category: 'FAMILY',
        textContent: 'One of my favourite family memories.',
      })
      .expect(201);
    expect(Object.keys(created.body).sort()).toEqual([
      'category',
      'createdAt',
      'id',
      'textContent',
      'title',
      'updatedAt',
    ]);
    expect(created.body.title).toBe('Christmas With My Family');
    memoryId = created.body.id;
    item = `${root}/${memoryId}`;
    media = `${item}/media`;

    const trip = await lisa
      .post(root)
      .send({ title: 'My First Trip to Perth', category: 'TRAVEL' })
      .expect(201);
    expect(trip.body.textContent).toBeNull();

    const list = await lisa.get(root).expect(200);
    expect(list.body.map((m: { id: string }) => m.id)).toEqual([
      trip.body.id,
      memoryId,
    ]);
    noLeaks(list.body);
    const family = await lisa.get(`${root}?category=FAMILY`).expect(200);
    expect(family.body.map((m: { id: string }) => m.id)).toEqual([memoryId]);

    noLeaks((await lisa.get(item).expect(200)).body);

    const patched = await lisa
      .patch(item)
      .send({ category: 'CHILDHOOD', textContent: 'Updated fictional memory.' })
      .expect(200);
    expect(patched.body).toMatchObject({
      title: 'Christmas With My Family',
      category: 'CHILDHOOD',
      textContent: 'Updated fictional memory.',
    });
    // Missing text is kept; null clears it.
    await lisa.patch(`${root}/${trip.body.id}`).send({ textContent: 'x' });
    const kept = await lisa
      .patch(`${root}/${trip.body.id}`)
      .send({ title: 'Perth, 1998' })
      .expect(200);
    expect(kept.body.textContent).toBe('x');
    const cleared = await lisa
      .patch(`${root}/${trip.body.id}`)
      .send({ textContent: null })
      .expect(200);
    expect(cleared.body.textContent).toBeNull();
    for (const body of [
      { ownerUserId: crypto.randomUUID() },
      { mediaAssets: [] },
      { storageKey: 'x' },
      { status: 'READY' },
      { title: null },
    ]) {
      await lisa.patch(item).send(body).expect(400);
    }
  });

  it('rejects invalid upload requests (400) without signing anything', async () => {
    for (const body of [
      { ...photo, kind: 'VIDEO', mimeType: 'video/mp4' },
      { ...photo, mimeType: 'image/svg+xml' },
      { ...photo, mimeType: 'audio/mpeg' },
      { ...photo, kind: 'AUDIO', mimeType: 'image/jpeg' },
      { ...photo, sizeBytes: 20 * 1024 * 1024 + 1 },
      {
        ...photo,
        kind: 'AUDIO',
        mimeType: 'audio/mpeg',
        sizeBytes: 100 * 1024 * 1024 + 1,
      },
      { ...photo, sizeBytes: 0 },
      { ...photo, ownerUserId: crypto.randomUUID() },
      { ...photo, storageKey: 'users/someone/evil.jpg' },
      { ...photo, fileUrl: 'https://example.test/a.jpg' },
    ]) {
      await lisa.post(`${media}/upload-url`).send(body).expect(400);
    }
    expect(storage.createUploadUrl).not.toHaveBeenCalled();
    expect(
      await prisma.memoryVaultMediaAsset.count({
        where: { memoryVaultItemId: memoryId },
      }),
    ).toBe(0);
  });

  it('PHOTO: upload URL → complete → READY → list → access URL', async () => {
    const res = await lisa.post(`${media}/upload-url`).send(photo).expect(201);
    expect(Object.keys(res.body).sort()).toEqual([
      'expiresAt',
      'mediaAssetId',
      'requiredHeaders',
      'uploadUrl',
    ]);
    expect(res.body.requiredHeaders).toEqual({ 'Content-Type': 'image/jpeg' });
    noLeaks(res.body);
    mediaId = res.body.mediaAssetId;
    const row = await prisma.memoryVaultMediaAsset.findUniqueOrThrow({
      where: { id: mediaId },
    });
    expect(row.status).toBe('PENDING_UPLOAD');
    expect(row.storageKey).toMatch(
      new RegExp(
        `^users/[0-9a-f-]+/memory-vault/${memoryId}/${mediaId}\\.jpg$`,
      ),
    );

    // Not uploaded yet: 409, stays PENDING; no access URL.
    await lisa.get(`${media}/${mediaId}/access-url`).expect(409);
    storage.headObject.mockResolvedValueOnce(null as never);
    await lisa.post(`${media}/${mediaId}/complete`).expect(409);

    const done = await lisa.post(`${media}/${mediaId}/complete`).expect(200);
    expect(done.body).toMatchObject({ status: 'READY', kind: 'PHOTO' });
    expect(done.body.uploadedAt).toBeTruthy();
    noLeaks(done.body);
    const again = await lisa.post(`${media}/${mediaId}/complete`).expect(200);
    expect(again.body.uploadedAt).toBe(done.body.uploadedAt);

    const list = await lisa.get(media).expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ id: mediaId, status: 'READY' });
    noLeaks(list.body);

    const access = await lisa.get(`${media}/${mediaId}/access-url`).expect(200);
    expect(access.body).toEqual({
      url: 'https://storage.test/signed-get',
      expiresAt: expect.any(String),
    });
  });

  it('AUDIO and a wrong-size upload: FAILED, never READY', async () => {
    const res = await lisa
      .post(`${media}/upload-url`)
      .send({
        ...photo,
        kind: 'AUDIO',
        mimeType: 'audio/mpeg',
        sizeBytes: 5_000,
      })
      .expect(201);
    const id = res.body.mediaAssetId;
    await lisa.post(`${media}/${id}/complete`).expect(400);
    const row = await prisma.memoryVaultMediaAsset.findUniqueOrThrow({
      where: { id },
    });
    expect(row.status).toBe('FAILED');
    await lisa.get(`${media}/${id}/access-url`).expect(409);
    await lisa.delete(`${media}/${id}`).expect(204);
  });

  it('isolates users: John gets a plain 404 for Lisa’s memory and media', async () => {
    const responses = [
      await john.get(item).expect(404),
      await john.patch(item).send({ title: 'Mine now' }).expect(404),
      await john.delete(item).expect(404),
      await john.post(`${media}/upload-url`).send(photo).expect(404),
      await john.post(`${media}/${mediaId}/complete`).expect(404),
      await john.get(media).expect(404),
      await john.get(`${media}/${mediaId}/access-url`).expect(404),
      await john.delete(`${media}/${mediaId}`).expect(404),
    ];
    for (const res of responses) noLeaks(res.body);
    expect((await john.get(root).expect(200)).body).toEqual([]);
    const row = await prisma.memoryVaultItem.findUniqueOrThrow({
      where: { id: memoryId },
    });
    expect(row.deletedAt).toBeNull();
    expect(row.title).toBe('Christmas With My Family');
  });

  it('deletes media: soft delete, storage delete attempted, then gone', async () => {
    storage.deleteObject.mockClear();
    await lisa.delete(`${media}/${mediaId}`).expect(204);
    const row = await prisma.memoryVaultMediaAsset.findUniqueOrThrow({
      where: { id: mediaId },
    });
    expect(row.deletedAt).toBeInstanceOf(Date);
    expect(storage.deleteObject).toHaveBeenCalledWith(row.storageKey);
    expect((await lisa.get(media).expect(200)).body).toEqual([]);
    await lisa.get(`${media}/${mediaId}/access-url`).expect(404);
  });

  it('deleting the memory hides it and all its media at once', async () => {
    const res = await lisa.post(`${media}/upload-url`).send(photo).expect(201);
    const id = res.body.mediaAssetId;
    await lisa.post(`${media}/${id}/complete`).expect(200);

    await lisa.delete(item).expect(204);
    const row = await prisma.memoryVaultItem.findUniqueOrThrow({
      where: { id: memoryId },
    });
    expect(row.deletedAt).toBeInstanceOf(Date);
    await lisa.get(item).expect(404);
    await lisa.patch(item).send({ title: 'x' }).expect(404);
    await lisa.delete(item).expect(404);
    await lisa.get(media).expect(404);
    await lisa.get(`${media}/${id}/access-url`).expect(404);
    await lisa.post(`${media}/${id}/complete`).expect(404);
    await lisa.post(`${media}/upload-url`).send(photo).expect(404);
    await lisa.delete(`${media}/${id}`).expect(404);
    const ids = (await lisa.get(root).expect(200)).body.map(
      (m: { id: string }) => m.id,
    );
    expect(ids).not.toContain(memoryId);
  });
});
