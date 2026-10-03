import { ConfigModule } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import session from 'express-session';
import request from 'supertest';
import { adminSignIn } from './admin-sign-in.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { configureApp } from '../src/config/app.setup.js';
import { MediaModule } from '../src/media/media.module.js';
import { MediaStorage } from '../src/media/storage/media-storage.service.js';
import { MessageSchedulesModule } from '../src/message-schedules/message-schedules.module.js';
import { MessagesModule } from '../src/messages/messages.module.js';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { RecipientsModule } from '../src/recipients/recipients.module.js';

// Real HTTP, validation, guards, sessions and PostgreSQL; object storage is a
// deterministic mock, so no bucket or credential is ever used here.
// Fictional data only; the test users are removed afterwards.
describe('Media (e2e, PostgreSQL, mocked storage)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const run = Date.now();
  const emails = ['lisa', 'john', 'admin'].map(
    (name) => `media.${name}.${run}@example.test`,
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
  let messageId: string;
  let mediaId: string;
  let base: string;
  const photo = {
    kind: 'PHOTO',
    originalFileName: 'family.jpg',
    mimeType: 'image/jpeg',
    sizeBytes: 100_000,
  };
  const noLeaks = (body: unknown) =>
    expect(JSON.stringify(body)).not.toMatch(
      /storageKey|ownerUserId|deletedAt|users\/|lisa|bucket|secret/i,
    );

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        AuthModule,
        RecipientsModule,
        MessagesModule,
        MessageSchedulesModule,
        MediaModule,
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
    const sofia = await lisa
      .post('/api/v1/recipients')
      .send({ firstName: 'Sofia' })
      .expect(201);
    messageId = (
      await lisa
        .post('/api/v1/messages')
        .send({
          title: 'Message A',
          textContent: 'Fictional text.',
          recipientIds: [sofia.body.id],
        })
        .expect(201)
    ).body.id;
    base = `/api/v1/messages/${messageId}/media`;
  });

  afterAll(async () => {
    await prisma?.user.deleteMany({ where: { email: { in: emails } } });
    await app?.close();
  });

  it('requires a Customer session (401, admins included) and UUIDs (400)', async () => {
    await request(app.getHttpServer())
      .post(`${base}/upload-url`)
      .send(photo)
      .expect(401);
    await prisma.user.update({
      where: { email: emails[2] },
      data: { role: 'ADMIN' },
    });
    // Step 16: an admin session needs password + TOTP. Its own cookie is never
    // read on Customer routes, so it gets 401 like any other non-Customer.
    const { agent: admin } = await adminSignIn(app, emails[2], password);
    await admin.get(base).expect(401);
    await admin.post(`${base}/upload-url`).send(photo).expect(401);
    await lisa.get('/api/v1/messages/not-a-uuid/media').expect(400);
    await lisa.post(`${base}/not-a-uuid/complete`).expect(400);
    await lisa.get(`${base}/not-a-uuid/access-url`).expect(400);
    await lisa.delete(`${base}/not-a-uuid`).expect(400);
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
      { ...photo, sizeBytes: -5 },
      { ...photo, extra: true },
      { ...photo, ownerUserId: crypto.randomUUID() },
      { ...photo, storageKey: 'users/someone/evil.jpg' },
      { ...photo, status: 'READY' },
    ]) {
      await lisa.post(`${base}/upload-url`).send(body).expect(400);
    }
    expect(storage.createUploadUrl).not.toHaveBeenCalled();
    expect(await prisma.mediaAsset.count({ where: { messageId } })).toBe(0);
  });

  it('issues an upload URL: PENDING_UPLOAD row, nothing internal exposed', async () => {
    const res = await lisa.post(`${base}/upload-url`).send(photo).expect(201);
    expect(Object.keys(res.body).sort()).toEqual([
      'expiresAt',
      'mediaAssetId',
      'requiredHeaders',
      'uploadUrl',
    ]);
    expect(res.body).toMatchObject({
      uploadUrl: 'https://storage.test/signed-put',
      requiredHeaders: { 'Content-Type': 'image/jpeg' },
    });
    noLeaks(res.body);
    mediaId = res.body.mediaAssetId;

    const row = await prisma.mediaAsset.findUniqueOrThrow({
      where: { id: mediaId },
    });
    expect(row.status).toBe('PENDING_UPLOAD');
    expect(row.storageKey).toMatch(
      new RegExp(`^users/[0-9a-f-]+/messages/${messageId}/${mediaId}\\.jpg$`),
    );
    expect(storage.createUploadUrl).toHaveBeenCalledWith(
      row.storageKey,
      'image/jpeg',
      Number(process.env.MEDIA_UPLOAD_URL_TTL_SECONDS ?? 600),
    );

    // Not READY yet: no access URL.
    await lisa.get(`${base}/${mediaId}/access-url`).expect(409);
  });

  it('complete before upload → 409, stays PENDING', async () => {
    storage.headObject.mockResolvedValueOnce(null as never);
    await lisa.post(`${base}/${mediaId}/complete`).expect(409);
    const row = await prisma.mediaAsset.findUniqueOrThrow({
      where: { id: mediaId },
    });
    expect(row.status).toBe('PENDING_UPLOAD');
  });

  it('complete verifies storage and marks READY; repeating is idempotent', async () => {
    const done = await lisa.post(`${base}/${mediaId}/complete`).expect(200);
    expect(done.body).toMatchObject({ status: 'READY', kind: 'PHOTO' });
    expect(done.body.uploadedAt).toBeTruthy();
    noLeaks(done.body);

    storage.headObject.mockClear();
    const again = await lisa.post(`${base}/${mediaId}/complete`).expect(200);
    expect(again.body.uploadedAt).toBe(done.body.uploadedAt);
    expect(storage.headObject).not.toHaveBeenCalled();
    expect(await prisma.mediaAsset.count({ where: { messageId } })).toBe(1);
  });

  it('a size mismatch marks the asset FAILED, never READY', async () => {
    const res = await lisa
      .post(`${base}/upload-url`)
      .send({ ...photo, originalFileName: 'other.jpg', sizeBytes: 5_000 })
      .expect(201);
    await lisa.post(`${base}/${res.body.mediaAssetId}/complete`).expect(400);
    const row = await prisma.mediaAsset.findUniqueOrThrow({
      where: { id: res.body.mediaAssetId },
    });
    expect(row.status).toBe('FAILED');
    await lisa.post(`${base}/${res.body.mediaAssetId}/complete`).expect(409);
  });

  it('lists and signs access for the owner only', async () => {
    const list = await lisa.get(base).expect(200);
    const mine = list.body.find((m: { id: string }) => m.id === mediaId);
    expect(mine).toMatchObject({
      status: 'READY',
      originalFileName: 'family.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 100_000,
    });
    noLeaks(list.body);

    const access = await lisa.get(`${base}/${mediaId}/access-url`).expect(200);
    expect(access.body).toEqual({
      url: 'https://storage.test/signed-get',
      expiresAt: expect.any(String),
    });
  });

  it('isolates users: John gets a plain 404 for Lisa’s message and media', async () => {
    const responses = [
      await john.get(base).expect(404),
      await john.post(`${base}/upload-url`).send(photo).expect(404),
      await john.post(`${base}/${mediaId}/complete`).expect(404),
      await john.get(`${base}/${mediaId}/access-url`).expect(404),
      await john.delete(`${base}/${mediaId}`).expect(404),
    ];
    for (const res of responses) noLeaks(res.body);
    const row = await prisma.mediaAsset.findUniqueOrThrow({
      where: { id: mediaId },
    });
    expect(row.deletedAt).toBeNull();
  });

  it('a SCHEDULED message is locked for media changes but still readable', async () => {
    const url = `/api/v1/messages/${messageId}/schedule`;
    // TEXT + a photo + a FAILED asset is not schedulable (Step 8)...
    await lisa.post(url).send({ triggerType: 'ON_DEATH' }).expect(409);
    // ...until it is MIXED (text + photo) and only READY media remain.
    await lisa
      .patch(`/api/v1/messages/${messageId}`)
      .send({ contentType: 'MIXED' })
      .expect(200);
    for (const m of (await lisa.get(base).expect(200)).body) {
      if (m.status !== 'READY')
        await lisa.delete(`${base}/${m.id}`).expect(204);
    }
    await lisa.post(url).send({ triggerType: 'ON_DEATH' }).expect(201);
    await lisa.post(`${base}/upload-url`).send(photo).expect(409);
    await lisa.delete(`${base}/${mediaId}`).expect(409);
    await lisa.get(base).expect(200);
    await lisa.get(`${base}/${mediaId}/access-url`).expect(200);
    await lisa.delete(url).expect(204);
  });

  it('soft-deletes: gone from the API, row kept, storage delete attempted', async () => {
    storage.deleteObject.mockClear();
    await lisa.delete(`${base}/${mediaId}`).expect(204);
    const row = await prisma.mediaAsset.findUniqueOrThrow({
      where: { id: mediaId },
    });
    expect(row.deletedAt).toBeInstanceOf(Date);
    expect(storage.deleteObject).toHaveBeenCalledWith(row.storageKey);

    const ids = (await lisa.get(base).expect(200)).body.map(
      (m: { id: string }) => m.id,
    );
    expect(ids).not.toContain(mediaId);
    await lisa.get(`${base}/${mediaId}/access-url`).expect(404);
    await lisa.post(`${base}/${mediaId}/complete`).expect(404);
    await lisa.delete(`${base}/${mediaId}`).expect(404);
  });

  it('a storage failure during delete still returns 204 and keeps it inaccessible', async () => {
    const res = await lisa
      .post(`${base}/upload-url`)
      .send({ ...photo, kind: 'AUDIO', mimeType: 'audio/mpeg' })
      .expect(201);
    const id = res.body.mediaAssetId;
    storage.deleteObject.mockRejectedValueOnce(new Error('storage down'));
    await lisa.delete(`${base}/${id}`).expect(204);
    await lisa.get(`${base}/${id}/access-url`).expect(404);
    const row = await prisma.mediaAsset.findUniqueOrThrow({ where: { id } });
    expect(row.deletedAt).toBeInstanceOf(Date);
  });
});
