import { ConfigModule } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import session from 'express-session';
import request from 'supertest';
import { adminSignIn } from './admin-sign-in.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { configureApp } from '../src/config/app.setup.js';
import { MediaModule } from '../src/media/media.module.js';
import { MalwareScanner } from '../src/media/scanner/malware-scanner.service.js';
import { MediaStorage } from '../src/media/storage/media-storage.service.js';
import { FAKE_MALWARE, FakeMalwareScanner } from './fake-malware-scanner.js';
import { FakeMediaStorage, fileStart } from './fake-media-storage.js';
import { MessageSchedulesModule } from '../src/message-schedules/message-schedules.module.js';
import { MessagesModule } from '../src/messages/messages.module.js';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { RecipientsModule } from '../src/recipients/recipients.module.js';

// Rich composition + schedule readiness (Step 8). Real HTTP, sessions and
// PostgreSQL; storage is a stateful mock: an object "exists" only after the
// test simulates the client's direct PUT. Fictional data, removed afterwards.
describe('Message composition + schedule readiness (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const run = Date.now();
  const emails = ['lisa', 'john', 'admin'].map(
    (name) => `comp.${name}.${run}@example.test`,
  );
  const password = 'StrongPassword123!';
  const SIZE = 1000;

  // In-memory provider: a file exists only after the simulated browser upload.
  const storage = new FakeMediaStorage();
  const scanner = new FakeMalwareScanner();
  type Kind = 'PHOTO' | 'AUDIO' | 'VIDEO';
  const FILE = {
    PHOTO: { originalFileName: 'photo.jpg', mimeType: 'image/jpeg' },
    AUDIO: { originalFileName: 'voice.mp3', mimeType: 'audio/mpeg' },
    VIDEO: { originalFileName: 'hello.mp4', mimeType: 'video/mp4' },
  };

  type Agent = ReturnType<typeof request.agent>;
  let lisa: Agent;
  let john: Agent;
  let sofiaId: string;

  const signIn = async (email: string) => {
    const agent = request.agent(app.getHttpServer());
    await agent
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(200);
    return agent;
  };
  const createMessage = async (body: object) =>
    (
      await lisa
        .post('/api/v1/messages')
        .send({ title: 'Fictional', recipientIds: [sofiaId], ...body })
        .expect(201)
    ).body.id as string;
  const media = (messageId: string) => `/api/v1/messages/${messageId}/media`;
  const schedule = (messageId: string) =>
    `/api/v1/messages/${messageId}/schedule`;
  // upload-url only: the asset stays PENDING_UPLOAD.
  const requestUpload = async (messageId: string, kind: Kind) => {
    const res = await lisa
      .post(`${media(messageId)}/upload-url`)
      .send({ kind, ...FILE[kind], sizeBytes: SIZE })
      .expect(201);
    return {
      id: res.body.mediaAssetId as string,
      upload: res.body.upload as Parameters<FakeMediaStorage['upload']>[0],
    };
  };
  // upload-url → (simulated direct upload) → complete
  const attach = async (messageId: string, kind: Kind, sizeBytes = SIZE) => {
    const { id, upload } = await requestUpload(messageId, kind);
    const fileId = storage.upload(upload, {
      sizeBytes,
      contentType: FILE[kind].mimeType,
    });
    const done = await lisa
      .post(`${media(messageId)}/${id}/complete`)
      .send({ providerFileId: fileId });
    return { id, status: done.status };
  };
  const attachReady = async (messageId: string, kind: Kind) => {
    const { id, status } = await attach(messageId, kind);
    expect(status).toBe(200);
    return id;
  };
  const statusOf = async (messageId: string) =>
    (await lisa.get(`/api/v1/messages/${messageId}`).expect(200)).body
      .status as string;
  const onDeath = { triggerType: 'ON_DEATH' };

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
        .send({ firstName: 'Sofia' })
        .expect(201)
    ).body.id;
  });

  afterAll(async () => {
    await prisma?.user.deleteMany({ where: { email: { in: emails } } });
    await app?.close();
  });

  it('creates drafts of every supported type (VIDEO since Phase 12)', async () => {
    for (const contentType of ['PHOTO', 'AUDIO', 'VIDEO', 'MIXED']) {
      const res = await lisa
        .post('/api/v1/messages')
        .send({ title: 'Draft', contentType, recipientIds: [sofiaId] })
        .expect(201);
      expect(res.body).toMatchObject({
        contentType,
        textContent: null,
        status: 'DRAFT',
      });
    }
    await lisa
      .post('/api/v1/messages')
      .send({ title: 'Video', contentType: 'video', recipientIds: [sofiaId] })
      .expect(400);
  });

  it('A — TEXT: schedules with text; blank text is refused', async () => {
    const blank = await createMessage({ contentType: 'TEXT' });
    await lisa.post(schedule(blank)).send(onDeath).expect(409);
    expect(await statusOf(blank)).toBe('DRAFT');

    const id = await createMessage({
      title: 'For Sofia',
      contentType: 'TEXT',
      textContent: 'Happy birthday Sofia',
    });
    await lisa.post(schedule(id)).send(onDeath).expect(201);
    expect(await statusOf(id)).toBe('SCHEDULED');
  });

  it('B — PHOTO: 409 until a READY photo exists', async () => {
    const id = await createMessage({
      title: 'A photo for Sofia',
      contentType: 'PHOTO',
    });
    const refused = await lisa.post(schedule(id)).send(onDeath).expect(409);
    expect(refused.body.message).toBe(
      'PHOTO messages require at least one ready photo.',
    );
    await attachReady(id, 'PHOTO');
    await lisa.post(schedule(id)).send(onDeath).expect(201);
  });

  it('C — AUDIO: 409 until a READY audio file exists', async () => {
    const id = await createMessage({ contentType: 'AUDIO' });
    await lisa.post(schedule(id)).send(onDeath).expect(409);
    await attachReady(id, 'AUDIO');
    await lisa.post(schedule(id)).send(onDeath).expect(201);
  });

  it('D — MIXED: text only is 409; text + photo schedules', async () => {
    const id = await createMessage({
      title: 'A memory for Sofia',
      contentType: 'MIXED',
      textContent: 'Remember this day.',
    });
    const refused = await lisa.post(schedule(id)).send(onDeath).expect(409);
    expect(refused.body.message).toBe(
      'MIXED messages require at least two content types.',
    );
    await attachReady(id, 'PHOTO');
    await lisa.post(schedule(id)).send(onDeath).expect(201);
  });

  it('E — pending (and failed) media block scheduling; soft-deleted media is ignored', async () => {
    const id = await createMessage({ contentType: 'PHOTO' });
    await attachReady(id, 'PHOTO');
    const { id: pending } = await requestUpload(id, 'PHOTO');
    const refused = await lisa.post(schedule(id)).send(onDeath).expect(409);
    expect(refused.body.message).toMatch(/not ready/);
    expect(await statusOf(id)).toBe('DRAFT');
    await lisa.get(schedule(id)).expect(404);
    await lisa.delete(`${media(id)}/${pending}`).expect(204);

    // An upload of the wrong size → FAILED, still blocks.
    const failed = await attach(id, 'PHOTO', SIZE + 1);
    expect(failed.status).toBe(400);
    await lisa.post(schedule(id)).send(onDeath).expect(409);

    // Deleting it (soft delete) removes it from validation.
    await lisa.delete(`${media(id)}/${failed.id}`).expect(204);
    await lisa.post(schedule(id)).send(onDeath).expect(201);
  });

  // Phase 12B: infected (FAILED) or unscanned (PENDING_UPLOAD after a scanner
  // outage) media never satisfies PHOTO/AUDIO/VIDEO/MIXED.
  const attachInfected = async (messageId: string, kind: Kind) => {
    const { id, upload } = await requestUpload(messageId, kind);
    const fileId = storage.upload(upload, {
      sizeBytes: SIZE,
      contentType: FILE[kind].mimeType,
      bytes: new Uint8Array([
        ...fileStart(FILE[kind].mimeType),
        ...Buffer.from(FAKE_MALWARE),
      ]),
    });
    await lisa
      .post(`${media(messageId)}/${id}/complete`)
      .send({ providerFileId: fileId })
      .expect(400);
    return id;
  };

  it.each(['PHOTO', 'AUDIO', 'VIDEO'] as const)(
    'M — an infected %s never makes its message schedulable',
    async (kind) => {
      const id = await createMessage({ contentType: kind });
      const infected = await attachInfected(id, kind);
      await lisa.post(schedule(id)).send(onDeath).expect(409);
      expect(await statusOf(id)).toBe('DRAFT');
      await lisa.delete(`${media(id)}/${infected}`).expect(204);
      await lisa.post(schedule(id)).send(onDeath).expect(409); // still none READY
    },
  );

  it('M — MIXED: an infected or unscanned file blocks; only READY counts', async () => {
    const id = await createMessage({
      contentType: 'MIXED',
      textContent: 'Fictional text.',
    });
    await attachReady(id, 'PHOTO');
    const infected = await attachInfected(id, 'AUDIO');
    await lisa.post(schedule(id)).send(onDeath).expect(409);
    await lisa.delete(`${media(id)}/${infected}`).expect(204);

    scanner.scan.mockRejectedValueOnce(new Error('scanner down'));
    const unscanned = await attach(id, 'VIDEO');
    expect(unscanned.status).toBe(503);
    await lisa.post(schedule(id)).send(onDeath).expect(409);
    await lisa.delete(`${media(id)}/${unscanned.id}`).expect(204);

    await lisa.post(schedule(id)).send(onDeath).expect(201);
  });

  it('V — VIDEO: incomplete draft allowed; only a READY video schedules', async () => {
    const id = await createMessage({ title: 'A video', contentType: 'VIDEO' });
    const none = await lisa.post(schedule(id)).send(onDeath).expect(409);
    expect(none.body.message).toBe(
      'VIDEO messages require at least one ready video.',
    );

    // Uploading (PENDING_UPLOAD, never completed) blocks.
    const { id: pending } = await requestUpload(id, 'VIDEO');
    const notReady = await lisa.post(schedule(id)).send(onDeath).expect(409);
    expect(notReady.body.message).toMatch(/not ready/);
    await lisa.delete(`${media(id)}/${pending}`).expect(204);

    // A video that failed verification blocks.
    const failed = await attach(id, 'VIDEO', SIZE + 1);
    expect(failed.status).toBe(400);
    await lisa.post(schedule(id)).send(onDeath).expect(409);
    await lisa.delete(`${media(id)}/${failed.id}`).expect(204);

    // A deleted READY video no longer counts.
    const removed = await attachReady(id, 'VIDEO');
    await lisa.delete(`${media(id)}/${removed}`).expect(204);
    await lisa.post(schedule(id)).send(onDeath).expect(409);

    // Text on a VIDEO message is refused: text + video is a MIXED message.
    await lisa
      .patch(`/api/v1/messages/${id}`)
      .send({ textContent: 'A caption' })
      .expect(200);
    await attachReady(id, 'VIDEO');
    const text = await lisa.post(schedule(id)).send(onDeath).expect(409);
    expect(text.body.message).toBe(
      'VIDEO messages cannot contain text. Use MIXED.',
    );
    await lisa
      .patch(`/api/v1/messages/${id}`)
      .send({ textContent: null })
      .expect(200);
    await lisa.post(schedule(id)).send(onDeath).expect(201);
    expect(await statusOf(id)).toBe('SCHEDULED');
    // Scheduled: locked, like every type.
    await lisa
      .post(`${media(id)}/upload-url`)
      .send({ kind: 'VIDEO', ...FILE.VIDEO, sizeBytes: SIZE })
      .expect(409);
  });

  it('V — video is refused in TEXT, PHOTO and AUDIO messages', async () => {
    for (const [contentType, extra, other] of [
      ['TEXT', 'Hi', null],
      ['PHOTO', null, 'PHOTO'],
      ['AUDIO', null, 'AUDIO'],
    ] as const) {
      const id = await createMessage({ contentType, textContent: extra });
      if (other) await attachReady(id, other);
      await attachReady(id, 'VIDEO');
      const res = await lisa.post(schedule(id)).send(onDeath).expect(409);
      expect(res.body.message).toBe(
        `${contentType} messages cannot contain video. Use VIDEO or MIXED.`,
      );
      expect(await statusOf(id)).toBe('DRAFT');
    }
  });

  it('V — MIXED + VIDEO: video counts as one MIXED part; video alone is not MIXED', async () => {
    const id = await createMessage({ contentType: 'MIXED' });
    await attachReady(id, 'VIDEO');
    const alone = await lisa.post(schedule(id)).send(onDeath).expect(409);
    expect(alone.body.message).toBe(
      'MIXED messages require at least two content types.',
    );
    await lisa
      .patch(`/api/v1/messages/${id}`)
      .send({ textContent: 'A few words with my video.' })
      .expect(200);
    await lisa.post(schedule(id)).send(onDeath).expect(201);
    expect(await statusOf(id)).toBe('SCHEDULED');

    // Photo + audio + video, no text.
    const all = await createMessage({ contentType: 'MIXED' });
    await attachReady(all, 'PHOTO');
    await attachReady(all, 'AUDIO');
    await attachReady(all, 'VIDEO');
    await lisa.post(schedule(all)).send(onDeath).expect(201);
  });

  it('content/media mismatches are 409 and change nothing', async () => {
    const text = await createMessage({
      contentType: 'TEXT',
      textContent: 'Hi',
    });
    await attachReady(text, 'PHOTO'); // allowed while drafting
    await lisa.post(schedule(text)).send(onDeath).expect(409);

    const photo = await createMessage({
      contentType: 'PHOTO',
      textContent: 'A caption makes this MIXED',
    });
    await attachReady(photo, 'PHOTO');
    await lisa.post(schedule(photo)).send(onDeath).expect(409);
    // Clearing the text (explicit null) makes it a valid PHOTO message.
    const cleared = await lisa
      .patch(`/api/v1/messages/${photo}`)
      .send({ textContent: null })
      .expect(200);
    expect(cleared.body.textContent).toBeNull();
    await lisa.post(schedule(photo)).send(onDeath).expect(201);
  });

  it('F — scheduled content is locked; unschedule, edit, reschedule re-validates', async () => {
    const id = await createMessage({
      contentType: 'TEXT',
      textContent: 'Keep this text.',
    });
    await lisa.post(schedule(id)).send(onDeath).expect(201);
    await lisa
      .patch(`/api/v1/messages/${id}`)
      .send({ contentType: 'MIXED' })
      .expect(409);
    await lisa
      .post(`${media(id)}/upload-url`)
      .send({
        kind: 'PHOTO',
        originalFileName: 'p.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: SIZE,
      })
      .expect(409);

    await lisa.delete(schedule(id)).expect(204);
    expect(await statusOf(id)).toBe('DRAFT');
    const mixed = await lisa
      .patch(`/api/v1/messages/${id}`)
      .send({ contentType: 'MIXED' })
      .expect(200);
    expect(mixed.body.textContent).toBe('Keep this text.'); // missing = unchanged
    // Rescheduling re-validates: MIXED with text only is refused...
    await lisa.post(schedule(id)).send(onDeath).expect(409);
    const photoId = await attachReady(id, 'PHOTO');
    await lisa.post(schedule(id)).send(onDeath).expect(201);

    // Media on a scheduled message cannot be deleted; switching type never deletes it.
    await lisa.delete(`${media(id)}/${photoId}`).expect(409);
    await lisa.delete(schedule(id)).expect(204);
    await lisa
      .patch(`/api/v1/messages/${id}`)
      .send({ contentType: 'TEXT' })
      .expect(200);
    const list = (await lisa.get(media(id)).expect(200)).body;
    expect(list.map((m: { id: string }) => m.id)).toEqual([photoId]);
    await lisa.post(schedule(id)).send(onDeath).expect(409); // TEXT + photo
  });

  it('G — cross-user: John gets 404 everywhere; admins get 401', async () => {
    const id = await createMessage({
      contentType: 'TEXT',
      textContent: 'Private text.',
    });
    const responses = [
      await john
        .patch(`/api/v1/messages/${id}`)
        .send({ contentType: 'MIXED' })
        .expect(404),
      await john.post(schedule(id)).send(onDeath).expect(404),
      await john.delete(schedule(id)).expect(404),
      await john.get(media(id)).expect(404),
    ];
    for (const res of responses) {
      expect(JSON.stringify(res.body)).not.toMatch(/owner|lisa|Private/i);
    }
    expect(await statusOf(id)).toBe('DRAFT');

    await prisma.user.update({
      where: { email: emails[2] },
      data: { role: 'ADMIN' },
    });
    // Step 16: an admin session needs password + TOTP. Its own cookie is never
    // read on Customer routes, so it gets 401 like any other non-Customer.
    const { agent: admin } = await adminSignIn(app, emails[2], password);
    await admin.post(schedule(id)).send(onDeath).expect(401);
    await admin.get(media(id)).expect(401);
  });
});
