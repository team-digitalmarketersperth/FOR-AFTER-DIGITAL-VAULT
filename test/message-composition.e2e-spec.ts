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

  // Signed Content-Type per key, and which asset ids were "PUT" to storage.
  const types = new Map<string, string>();
  const uploaded = new Set<string>();
  const storage = {
    createUploadUrl: vi.fn(async (key: string, contentType: string) => {
      types.set(key, contentType);
      return 'https://storage.test/signed-put';
    }),
    createAccessUrl: vi.fn(async () => 'https://storage.test/signed-get'),
    headObject: vi.fn(async (key: string) =>
      [...uploaded].some((id) => key.includes(id))
        ? { sizeBytes: SIZE, contentType: types.get(key) }
        : null,
    ),
    deleteObject: vi.fn(async () => undefined),
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
  const requestUpload = async (messageId: string, kind: 'PHOTO' | 'AUDIO') =>
    (
      await lisa
        .post(`${media(messageId)}/upload-url`)
        .send({
          kind,
          originalFileName: kind === 'PHOTO' ? 'photo.jpg' : 'voice.mp3',
          mimeType: kind === 'PHOTO' ? 'image/jpeg' : 'audio/mpeg',
          sizeBytes: SIZE,
        })
        .expect(201)
    ).body.mediaAssetId as string;
  // upload-url → (simulated direct PUT) → complete = READY
  const attachReady = async (messageId: string, kind: 'PHOTO' | 'AUDIO') => {
    const id = await requestUpload(messageId, kind);
    uploaded.add(id);
    const done = await lisa
      .post(`${media(messageId)}/${id}/complete`)
      .expect(200);
    expect(done.body.status).toBe('READY');
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

  it('creates drafts of every supported type; VIDEO is 400', async () => {
    for (const contentType of ['PHOTO', 'AUDIO', 'MIXED']) {
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
      .send({ title: 'Video', contentType: 'VIDEO', recipientIds: [sofiaId] })
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
    const pending = await requestUpload(id, 'PHOTO');
    const refused = await lisa.post(schedule(id)).send(onDeath).expect(409);
    expect(refused.body.message).toMatch(/not ready/);
    expect(await statusOf(id)).toBe('DRAFT');
    await lisa.get(schedule(id)).expect(404);

    // Complete it with the wrong size → FAILED, still blocks.
    uploaded.add(pending);
    storage.headObject.mockResolvedValueOnce({
      sizeBytes: SIZE + 1,
      contentType: 'image/jpeg',
    });
    await lisa.post(`${media(id)}/${pending}/complete`).expect(400);
    await lisa.post(schedule(id)).send(onDeath).expect(409);

    // Deleting it (soft delete) removes it from validation.
    await lisa.delete(`${media(id)}/${pending}`).expect(204);
    await lisa.post(schedule(id)).send(onDeath).expect(201);
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

  it('G — cross-user: John gets 404 everywhere; admins get 403', async () => {
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
    // Step 16: an admin session needs password + TOTP.
    const { agent: admin } = await adminSignIn(app, emails[2], password);
    await admin.post(schedule(id)).send(onDeath).expect(403);
    await admin.get(media(id)).expect(403);
  });
});
