import { ConfigModule } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import session from 'express-session';
import request from 'supertest';
import { adminSignIn } from './admin-sign-in.js';
import { FAKE_MALWARE, FakeMalwareScanner } from './fake-malware-scanner.js';
import { FakeMediaStorage, fileStart } from './fake-media-storage.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { configureApp } from '../src/config/app.setup.js';
import { MediaCleanup } from '../src/media/media-cleanup.service.js';
import { MediaModule } from '../src/media/media.module.js';
import { MalwareScanner } from '../src/media/scanner/malware-scanner.service.js';
import { MediaStorage } from '../src/media/storage/media-storage.service.js';
import { MessageSchedulesModule } from '../src/message-schedules/message-schedules.module.js';
import { MessagesModule } from '../src/messages/messages.module.js';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { RecipientsModule } from '../src/recipients/recipients.module.js';

// Real HTTP, validation, guards, sessions and PostgreSQL; the media provider
// is an in-memory fake (test/fake-media-storage.ts), so no ImageKit account,
// key or network is ever used here. Fictional data only; the test users are
// removed afterwards.
describe('Media (e2e, PostgreSQL, fake provider)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let cleanup: MediaCleanup;
  const run = Date.now();
  const emails = ['lisa', 'john', 'admin'].map(
    (name) => `media.${name}.${run}@example.test`,
  );
  const password = 'StrongPassword123!';
  const storage = new FakeMediaStorage();
  const scanner = new FakeMalwareScanner();

  type Agent = ReturnType<typeof request.agent>;
  type Upload = Parameters<FakeMediaStorage['upload']>[0];
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
  let mediaFileId: string;
  let base: string;
  const photo = {
    kind: 'PHOTO',
    originalFileName: 'family.jpg',
    mimeType: 'image/jpeg',
    sizeBytes: 100_000,
  };
  const audio = { ...photo, kind: 'AUDIO', mimeType: 'audio/mpeg' };
  const video = {
    kind: 'VIDEO',
    originalFileName: 'hello.webm',
    mimeType: 'video/webm',
    sizeBytes: 3_000_000,
  };
  const noLeaks = (body: unknown) =>
    expect(JSON.stringify(body)).not.toMatch(
      /storageKey|storageProvider|providerFileId|ownerUserId|deletedAt|for-after\/users|lisa|secret/i,
    );
  // The browser's direct upload of a file matching the request.
  const put = (upload: Upload, body: { sizeBytes: number; mimeType: string }) =>
    storage.upload(upload, {
      sizeBytes: body.sizeBytes,
      contentType: body.mimeType,
    });
  const rowOf = (id: string) =>
    prisma.mediaAsset.findUniqueOrThrow({ where: { id } });

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
      .overrideProvider(MalwareScanner)
      .useValue(scanner)
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app, new session.MemoryStore());
    await app.init();
    prisma = app.get(PrismaService);
    cleanup = app.get(MediaCleanup);

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
    await lisa
      .post(`${base}/not-a-uuid/complete`)
      .send({ providerFileId: 'f1' })
      .expect(400);
    await lisa.get(`${base}/not-a-uuid/access-url`).expect(400);
    await lisa.delete(`${base}/not-a-uuid`).expect(400);
  });

  it('rejects invalid upload requests (400) without signing anything', async () => {
    for (const body of [
      { ...photo, kind: 'VIDEO', mimeType: 'image/jpeg' },
      { ...video, mimeType: 'video/quicktime' },
      { ...photo, mimeType: 'image/svg+xml' },
      { ...photo, mimeType: 'audio/mpeg' },
      { ...photo, kind: 'AUDIO', mimeType: 'image/jpeg' },
      { ...photo, sizeBytes: 20 * 1024 * 1024 + 1 },
      // ImageKit Free plan limits.
      { ...audio, sizeBytes: 25 * 1024 * 1024 + 1 },
      { ...video, sizeBytes: 100 * 1024 * 1024 + 1 },
      { ...photo, sizeBytes: 0 },
      { ...photo, sizeBytes: -5 },
      { ...photo, extra: true },
      { ...photo, ownerUserId: crypto.randomUUID() },
      { ...photo, storageKey: 'users/someone/evil.jpg' },
      { ...photo, status: 'READY' },
    ]) {
      await lisa.post(`${base}/upload-url`).send(body).expect(400);
    }
    expect(storage.createUpload).not.toHaveBeenCalled();
    expect(await prisma.mediaAsset.count({ where: { messageId } })).toBe(0);
  });

  it('issues upload auth: PENDING_UPLOAD row on ImageKit, server-chosen path, nothing internal exposed', async () => {
    const res = await lisa.post(`${base}/upload-url`).send(photo).expect(201);
    expect(Object.keys(res.body).sort()).toEqual([
      'expiresAt',
      'mediaAssetId',
      'upload',
    ]);
    expect(res.body.upload.url).toBe('https://upload.test/files');
    mediaId = res.body.mediaAssetId;

    const row = await rowOf(mediaId);
    expect(row.status).toBe('PENDING_UPLOAD');
    expect(row.storageProvider).toBe('IMAGEKIT');
    expect(row.providerFileId).toBeNull();
    expect(row.storageKey).toMatch(
      new RegExp(
        `^/for-after/users/[0-9a-f-]+/messages/${messageId}/photo/${mediaId}\\.jpg$`,
      ),
    );
    expect(storage.createUpload).toHaveBeenCalledWith(
      row.storageKey,
      'image/jpeg',
      100_000,
      Number(process.env.MEDIA_UPLOAD_URL_TTL_SECONDS ?? 600),
    );

    // Not READY yet: no access URL.
    await lisa.get(`${base}/${mediaId}/access-url`).expect(409);
    mediaFileId = put(res.body.upload, photo);
  });

  it('complete needs a valid provider file id; one for another path → 409, stays PENDING', async () => {
    await lisa.post(`${base}/${mediaId}/complete`).expect(400);
    await lisa
      .post(`${base}/${mediaId}/complete`)
      .send({ providerFileId: '../x' })
      .expect(400);
    await lisa
      .post(`${base}/${mediaId}/complete`)
      .send({ providerFileId: 'no-such-file' })
      .expect(409);
    // John's own upload: a real file, but not at this asset's path.
    const mia = await john
      .post('/api/v1/recipients')
      .send({ firstName: 'Mia' })
      .expect(201);
    const johnMsg = (
      await john
        .post('/api/v1/messages')
        .send({ title: 'J', recipientIds: [mia.body.id] })
        .expect(201)
    ).body.id;
    const johnUpload = await john
      .post(`/api/v1/messages/${johnMsg}/media/upload-url`)
      .send(photo)
      .expect(201);
    const johnsFile = put(johnUpload.body.upload, photo);
    await lisa
      .post(`${base}/${mediaId}/complete`)
      .send({ providerFileId: johnsFile })
      .expect(409);
    expect((await rowOf(mediaId)).status).toBe('PENDING_UPLOAD');
    expect(storage.files.has(johnsFile)).toBe(true);
  });

  it('complete verifies with the provider and marks READY; repeating is idempotent', async () => {
    const done = await lisa
      .post(`${base}/${mediaId}/complete`)
      .send({ providerFileId: mediaFileId })
      .expect(200);
    expect(done.body).toMatchObject({ status: 'READY', kind: 'PHOTO' });
    expect(done.body.uploadedAt).toBeTruthy();
    noLeaks(done.body);
    expect((await rowOf(mediaId)).providerFileId).toBe(mediaFileId);

    storage.verifyUpload.mockClear();
    const again = await lisa
      .post(`${base}/${mediaId}/complete`)
      .send({ providerFileId: mediaFileId })
      .expect(200);
    expect(again.body.uploadedAt).toBe(done.body.uploadedAt);
    expect(storage.verifyUpload).not.toHaveBeenCalled();
  });

  it.each([
    ['a size mismatch', { sizeBytes: 5_000 }],
    // Named .jpg and declared image/jpeg, but the bytes are HTML.
    [
      'bytes that are not a JPEG',
      { bytes: new TextEncoder().encode('<html>') },
    ],
    ['a public file', { isPrivate: false }],
  ])('%s → 400, FAILED (never READY), file deleted', async (_, over) => {
    const res = await lisa.post(`${base}/upload-url`).send(photo).expect(201);
    const id = res.body.mediaAssetId;
    const fileId = storage.upload(res.body.upload, {
      sizeBytes: photo.sizeBytes,
      contentType: photo.mimeType,
      ...over,
    });
    await lisa
      .post(`${base}/${id}/complete`)
      .send({ providerFileId: fileId })
      .expect(400);
    const row = await rowOf(id);
    expect(row.status).toBe('FAILED');
    expect(row.storageDeletedAt).toBeInstanceOf(Date);
    expect(storage.files.has(fileId)).toBe(false);
    await lisa
      .post(`${base}/${id}/complete`)
      .send({ providerFileId: fileId })
      .expect(409);
    await lisa.get(`${base}/${id}/access-url`).expect(409);
  });

  // Phase 12B: provider check → magic bytes → malware scan → READY.
  it.each([photo, audio, video])(
    'infected $kind → 400 generic, FAILED for good, file deleted, no access',
    async (body) => {
      const res = await lisa.post(`${base}/upload-url`).send(body).expect(201);
      const id = res.body.mediaAssetId;
      const fileId = storage.upload(res.body.upload, {
        sizeBytes: body.sizeBytes,
        contentType: body.mimeType,
        bytes: new Uint8Array([
          ...fileStart(body.mimeType),
          ...Buffer.from(FAKE_MALWARE),
        ]),
      });
      const rejected = await lisa
        .post(`${base}/${id}/complete`)
        .send({ providerFileId: fileId })
        .expect(400);
      expect(rejected.body.message).toBe(
        'This file could not be accepted. Please choose a different file.',
      );
      const row = await rowOf(id);
      expect(row.status).toBe('FAILED');
      expect(row.uploadedAt).toBeNull();
      expect(row.storageDeletedAt).toBeInstanceOf(Date);
      expect(storage.files.has(fileId)).toBe(false);
      // The same provider file can never be retried into READY.
      await lisa
        .post(`${base}/${id}/complete`)
        .send({ providerFileId: fileId })
        .expect(409);
      await lisa.get(`${base}/${id}/access-url`).expect(409);
      await john.get(`${base}/${id}/access-url`).expect(404);
    },
  );

  it('scanner outage → 503 generic, stays PENDING_UPLOAD; a retry once it is back → READY', async () => {
    const res = await lisa.post(`${base}/upload-url`).send(photo).expect(201);
    const id = res.body.mediaAssetId;
    const fileId = put(res.body.upload, photo);
    scanner.scan.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    const down = await lisa
      .post(`${base}/${id}/complete`)
      .send({ providerFileId: fileId })
      .expect(503);
    expect(down.body.message).toBe(
      "We couldn't finish checking this file. Please try again.",
    );
    expect(JSON.stringify(down.body)).not.toMatch(/ECONNREFUSED|clam/i);
    expect((await rowOf(id)).status).toBe('PENDING_UPLOAD');
    expect(storage.files.has(fileId)).toBe(true);
    await lisa.get(`${base}/${id}/access-url`).expect(409);
    await lisa
      .post(`${base}/${id}/complete`)
      .send({ providerFileId: fileId })
      .expect(200);
    expect((await rowOf(id)).status).toBe('READY');
    await lisa.delete(`${base}/${id}`).expect(204);
  });

  it('VIDEO: upload auth, verification, READY, Customer preview', async () => {
    const res = await lisa.post(`${base}/upload-url`).send(video).expect(201);
    const id = res.body.mediaAssetId;
    expect((await rowOf(id)).storageKey).toMatch(/\/video\/[0-9a-f-]+\.webm$/);
    const done = await lisa
      .post(`${base}/${id}/complete`)
      .send({ providerFileId: put(res.body.upload, video) })
      .expect(200);
    expect(done.body).toMatchObject({ kind: 'VIDEO', status: 'READY' });
    const access = await lisa.get(`${base}/${id}/access-url`).expect(200);
    expect(access.body.url).toMatch(/^https:\/\/media\.test\/signed/);
    await lisa.delete(`${base}/${id}`).expect(204);
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
      url: 'https://media.test/signed?expires=300',
      expiresAt: expect.any(String),
    });
  });

  it('isolates users: John gets a plain 404 for Lisa’s message and media', async () => {
    const responses = [
      await john.get(base).expect(404),
      await john.post(`${base}/upload-url`).send(photo).expect(404),
      await john
        .post(`${base}/${mediaId}/complete`)
        .send({ providerFileId: mediaFileId })
        .expect(404),
      await john.get(`${base}/${mediaId}/access-url`).expect(404),
      await john.delete(`${base}/${mediaId}`).expect(404),
    ];
    for (const res of responses) noLeaks(res.body);
    expect((await rowOf(mediaId)).deletedAt).toBeNull();
  });

  it('a SCHEDULED message is locked for media changes but still readable', async () => {
    const url = `/api/v1/messages/${messageId}/schedule`;
    // TEXT + a photo + FAILED assets is not schedulable (Step 8)...
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

  it('soft-deletes: gone from the API at once, row kept, provider file deleted', async () => {
    storage.deleteObject.mockClear();
    await lisa.delete(`${base}/${mediaId}`).expect(204);
    const row = await rowOf(mediaId);
    expect(row.deletedAt).toBeInstanceOf(Date);
    expect(row.storageDeletedAt).toBeInstanceOf(Date);
    expect(storage.deleteObject).toHaveBeenCalledWith(
      expect.objectContaining({
        storageKey: row.storageKey,
        providerFileId: mediaFileId,
      }),
    );
    expect(storage.files.has(mediaFileId)).toBe(false);

    const ids = (await lisa.get(base).expect(200)).body.map(
      (m: { id: string }) => m.id,
    );
    expect(ids).not.toContain(mediaId);
    await lisa.get(`${base}/${mediaId}/access-url`).expect(404);
    await lisa
      .post(`${base}/${mediaId}/complete`)
      .send({ providerFileId: mediaFileId })
      .expect(404);
    await lisa.delete(`${base}/${mediaId}`).expect(404);
  });

  it('a provider failure still returns 204, never restores access, and the reconciler retries', async () => {
    const res = await lisa.post(`${base}/upload-url`).send(audio).expect(201);
    const id = res.body.mediaAssetId;
    const fileId = put(res.body.upload, audio);
    await lisa
      .post(`${base}/${id}/complete`)
      .send({ providerFileId: fileId })
      .expect(200);
    storage.deleteObject.mockRejectedValueOnce(
      new Error('ImageKit 500 secret-key-id'),
    );
    const del = await lisa.delete(`${base}/${id}`).expect(204);
    expect(del.text).toBe('');
    await lisa.get(`${base}/${id}/access-url`).expect(404);
    let row = await rowOf(id);
    expect(row.deletedAt).toBeInstanceOf(Date);
    expect(row.storageDeletedAt).toBeNull();
    expect(storage.files.has(fileId)).toBe(true);

    // A later reconcile run (after the upload token's lifetime) retries.
    await cleanup.reconcile(new Date(Date.now() + 11 * 60_000));
    row = await rowOf(id);
    expect(row.storageDeletedAt).toBeInstanceOf(Date);
    expect(storage.files.has(fileId)).toBe(false);
    // Retrying again is a no-op for this row.
    storage.deleteObject.mockClear();
    await cleanup.reconcile(new Date(Date.now() + 11 * 60_000));
    expect(storage.deleteObject).not.toHaveBeenCalledWith(
      expect.objectContaining({ storageKey: row.storageKey }),
    );
  });

  describe('deleting a message cleans up its media', () => {
    const newDraft = async (agent: Agent) => {
      const who = await agent
        .post('/api/v1/recipients')
        .send({ firstName: 'Cleanup' })
        .expect(201);
      return (
        await agent
          .post('/api/v1/messages')
          .send({ title: 'To delete', recipientIds: [who.body.id] })
          .expect(201)
      ).body.id as string;
    };
    const requestUpload = async (agent: Agent, msg: string, body = photo) =>
      (
        await agent
          .post(`/api/v1/messages/${msg}/media/upload-url`)
          .send(body)
          .expect(201)
      ).body as { mediaAssetId: string; upload: Upload };
    // upload-url → browser upload → complete; returns [assetId, fileId].
    const uploaded = async (
      agent: Agent,
      msg: string,
      body = photo,
      over: { sizeBytes?: number } = {},
    ) => {
      const { mediaAssetId, upload } = await requestUpload(agent, msg, body);
      const fileId = put(upload, { ...body, ...over });
      await agent
        .post(`/api/v1/messages/${msg}/media/${mediaAssetId}/complete`)
        .send({ providerFileId: fileId });
      return [mediaAssetId, fileId] as const;
    };

    it('soft-deletes PHOTO, AUDIO, VIDEO (READY), PENDING_UPLOAD and FAILED media; deletes only their files', async () => {
      const msg = await newDraft(lisa);
      const m = `/api/v1/messages/${msg}/media`;
      const [readyPhoto, photoFile] = await uploaded(lisa, msg);
      const [readyAudio, audioFile] = await uploaded(lisa, msg, audio);
      const [readyVideo, videoFile] = await uploaded(lisa, msg, video);
      const pending = (await requestUpload(lisa, msg, audio)).mediaAssetId;
      const [failed] = await uploaded(lisa, msg, photo, { sizeBytes: 1 });
      expect((await rowOf(failed)).status).toBe('FAILED');
      // Another message of Lisa's and John's media stay untouched.
      const [other, otherFile] = await uploaded(lisa, await newDraft(lisa));
      const [johns, johnsFile] = await uploaded(john, await newDraft(john));

      const live = [readyPhoto, readyAudio, readyVideo, pending, failed];
      storage.deleteObject.mockClear();
      const res = await lisa.delete(`/api/v1/messages/${msg}`).expect(204);
      expect(res.text).toBe('');

      const rows = await prisma.mediaAsset.findMany({
        where: { id: { in: live } },
        select: {
          id: true,
          status: true,
          deletedAt: true,
          storageDeletedAt: true,
        },
      });
      expect(rows).toHaveLength(5);
      // Statuses are kept as they were (history); deletedAt hides them.
      for (const r of rows) expect(r.deletedAt).toBeInstanceOf(Date);
      for (const file of [photoFile, audioFile, videoFile]) {
        expect(storage.files.has(file)).toBe(false);
      }
      // The pending upload's token may still be in use: its path is checked
      // by the reconciler later, not now.
      expect(rows.find((r) => r.id === pending)!.storageDeletedAt).toBeNull();
      for (const id of [readyPhoto, readyAudio, readyVideo]) {
        expect(rows.find((r) => r.id === id)!.storageDeletedAt).toBeInstanceOf(
          Date,
        );
      }
      expect(storage.files.has(otherFile)).toBe(true);
      expect(storage.files.has(johnsFile)).toBe(true);
      for (const id of [other, johns]) {
        expect((await rowOf(id)).deletedAt).toBeNull();
      }

      // Nothing is reachable through the deleted message any more.
      await lisa.get(m).expect(404);
      for (const id of live) {
        await lisa.get(`${m}/${id}/access-url`).expect(404);
        await lisa
          .post(`${m}/${id}/complete`)
          .send({ providerFileId: photoFile })
          .expect(404);
        await lisa.delete(`${m}/${id}`).expect(404);
      }
      await lisa.post(`${m}/upload-url`).send(photo).expect(404);

      // Deleting again is a plain 404 and touches no storage.
      storage.deleteObject.mockClear();
      await lisa.delete(`/api/v1/messages/${msg}`).expect(404);
      expect(storage.deleteObject).not.toHaveBeenCalled();

      // Later, the reconciler clears the pending upload's path too.
      await cleanup.reconcile(new Date(Date.now() + 11 * 60_000));
      expect((await rowOf(pending)).storageDeletedAt).toBeInstanceOf(Date);
    });

    it('a provider failure still returns 204, leaks nothing and never restores access', async () => {
      const msg = await newDraft(lisa);
      const m = `/api/v1/messages/${msg}/media`;
      const [a] = await uploaded(lisa, msg);
      const [b] = await uploaded(lisa, msg, audio);
      storage.deleteObject.mockClear();
      storage.deleteObject.mockRejectedValueOnce(
        new Error('ImageKit AccessDenied key=secret-key-id'),
      );
      const res = await lisa.delete(`/api/v1/messages/${msg}`).expect(204);
      expect(res.text).toBe('');
      // The other file is still attempted.
      expect(storage.deleteObject).toHaveBeenCalledTimes(2);
      for (const id of [a, b]) {
        expect((await rowOf(id)).deletedAt).toBeInstanceOf(Date);
        await lisa.get(`${m}/${id}/access-url`).expect(404);
      }
      const msgRow = await prisma.message.findUniqueOrThrow({
        where: { id: msg },
      });
      expect(msgRow.deletedAt).toBeInstanceOf(Date);
    });

    it('John cannot delete Lisa’s message or reach its media', async () => {
      const msg = await newDraft(lisa);
      const [a] = await uploaded(lisa, msg);
      storage.deleteObject.mockClear();
      await john.delete(`/api/v1/messages/${msg}`).expect(404);
      expect(storage.deleteObject).not.toHaveBeenCalled();
      expect((await rowOf(a)).deletedAt).toBeNull();
    });

    it('a SCHEDULED message cannot be deleted, so its media stay (409)', async () => {
      const msg = await newDraft(lisa);
      const [a] = await uploaded(lisa, msg);
      await prisma.message.update({
        where: { id: msg },
        data: { status: 'SCHEDULED' },
      });
      storage.deleteObject.mockClear();
      await lisa.delete(`/api/v1/messages/${msg}`).expect(409);
      expect(storage.deleteObject).not.toHaveBeenCalled();
      expect((await rowOf(a)).deletedAt).toBeNull();
      // Back to DRAFT so any release reconciler ignores it.
      await prisma.message.update({
        where: { id: msg },
        data: { status: 'DRAFT' },
      });
    });
  });
});
