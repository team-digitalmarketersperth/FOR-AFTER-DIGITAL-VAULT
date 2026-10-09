import { ConfigModule } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import session from 'express-session';
import request from 'supertest';
import { AuthModule } from '../src/auth/auth.module.js';
import { configureApp } from '../src/config/app.setup.js';
import { MediaModule } from '../src/media/media.module.js';
import { MalwareScanner } from '../src/media/scanner/malware-scanner.service.js';
import { MediaStorage } from '../src/media/storage/media-storage.service.js';
import {
  NOT_ENOUGH_STORAGE,
  STORAGE_FULL,
} from '../src/media/storage-quota.service.js';
import { MemoryVaultModule } from '../src/memory-vault/memory-vault.module.js';
import { MessagesModule } from '../src/messages/messages.module.js';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { RecipientsModule } from '../src/recipients/recipients.module.js';
import { FakeMalwareScanner } from './fake-malware-scanner.js';
import { FakeMediaStorage } from './fake-media-storage.js';

// Phase 12C: storage quota against real PostgreSQL (row locks, sums), with a
// tiny limit so nothing large is ever stored. Fake ImageKit and scanner.
describe('Storage quota (e2e, PostgreSQL)', () => {
  const LIMIT = 10_000;
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const run = Date.now();
  const emails = ['lisa', 'john'].map((n) => `quota.${n}.${run}@example.test`);
  const password = 'StrongPassword123!';
  const storage = new FakeMediaStorage();
  const scanner = new FakeMalwareScanner();
  type Agent = ReturnType<typeof request.agent>;
  let lisa: Agent;
  let john: Agent;
  const api = (p: string) => `/api/v1${p}`;
  const ids: Record<string, string> = {};

  const signIn = async (email: string) => {
    const agent = request.agent(app.getHttpServer());
    await agent.post(api('/auth/login')).send({ email, password }).expect(200);
    return agent;
  };
  const usage = async (agent: Agent) =>
    (await agent.get(api('/users/me/storage')).expect(200)).body;
  const file = (kind: string, mimeType: string, sizeBytes: number) => ({
    kind,
    mimeType,
    sizeBytes,
    originalFileName: 'synthetic.bin',
  });
  const photo = (n: number) => file('PHOTO', 'image/jpeg', n);
  const audio = (n: number) => file('AUDIO', 'audio/mpeg', n);
  // The three upload kinds that consume storage.
  const messageUpload = (agent: Agent, messageId: string, body: object) =>
    agent.post(api(`/messages/${messageId}/media/upload-url`)).send(body);
  const memoryUpload = (agent: Agent, memoryId: string, body: object) =>
    agent.post(api(`/memory-vault/${memoryId}/media/upload-url`)).send(body);
  const recipientPhoto = (agent: Agent, recipientId: string, body: object) =>
    agent.post(api(`/recipients/${recipientId}/photo/upload-url`)).send(body);
  const setUp = async (agent: Agent, key: string) => {
    ids[`${key}Recipient`] = (
      await agent
        .post(api('/recipients'))
        .send({ firstName: 'Sofia' })
        .expect(201)
    ).body.id;
    ids[`${key}Message`] = (
      await agent
        .post(api('/messages'))
        .send({
          title: 'Fictional',
          contentType: 'MIXED',
          recipientIds: [ids[`${key}Recipient`]],
        })
        .expect(201)
    ).body.id;
    ids[`${key}Memory`] = (
      await agent
        .post(api('/memory-vault'))
        .send({ title: 'Fictional', category: 'OTHER' })
        .expect(201)
    ).body.id;
  };

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
        .post(api('/auth/register'))
        .send({ email, password, firstName: 'Test', lastName: 'User' })
        .expect(201);
    }
    lisa = await signIn(emails[0]);
    john = await signIn(emails[1]);
    await setUp(lisa, 'lisa');
    await setUp(john, 'john');
  });

  afterAll(async () => {
    delete process.env.STORAGE_LIMIT_BYTES;
    await prisma?.user.deleteMany({ where: { email: { in: emails } } });
    await app?.close();
  });

  it('starts empty, own usage only, Customer session required', async () => {
    expect(await usage(lisa)).toEqual({
      usedBytes: 0,
      reservedBytes: 0,
      limitBytes: LIMIT,
      remainingBytes: LIMIT,
      percentage: 0,
      level: 'NORMAL',
    });
    await request(app.getHttpServer())
      .get(api('/users/me/storage'))
      .expect(401);
  });

  it('every kind of upload counts; 80 / 90 / 100 % levels; an over-size file and a full quota are refused before signing', async () => {
    // Message photo, 7000: reserved while uploading, used once READY.
    const res = await messageUpload(lisa, ids.lisaMessage, photo(7000)).expect(
      201,
    );
    ids.lisaPhoto = res.body.mediaAssetId;
    expect(await usage(lisa)).toMatchObject({
      usedBytes: 0,
      reservedBytes: 7000,
      level: 'NORMAL',
    });
    await lisa
      .post(api(`/messages/${ids.lisaMessage}/media/${ids.lisaPhoto}/complete`))
      .send({
        providerFileId: storage.upload(res.body.upload, {
          sizeBytes: 7000,
          contentType: 'image/jpeg',
        }),
      })
      .expect(200);
    expect(await usage(lisa)).toMatchObject({
      usedBytes: 7000,
      reservedBytes: 0,
      percentage: 70,
    });

    // Memory Vault audio → exactly 80 %.
    ids.lisaAudio = (
      await memoryUpload(lisa, ids.lisaMemory, audio(1000)).expect(201)
    ).body.mediaAssetId;
    expect(await usage(lisa)).toMatchObject({
      percentage: 80,
      level: 'WARNING',
    });
    // Recipient photo → exactly 90 %.
    await recipientPhoto(lisa, ids.lisaRecipient, photo(1000)).expect(201);
    expect(await usage(lisa)).toMatchObject({ percentage: 90, level: 'HIGH' });

    // 1000 left: 1001 is refused (nothing created, nothing signed).
    const signed = storage.createUpload.mock.calls.length;
    const tooBig = await messageUpload(
      lisa,
      ids.lisaMessage,
      photo(1001),
    ).expect(409);
    expect(tooBig.body.message).toBe(NOT_ENOUGH_STORAGE);
    expect(storage.createUpload.mock.calls.length).toBe(signed);
    // Exactly what is left fits → 100 %.
    await messageUpload(lisa, ids.lisaMessage, photo(1000)).expect(201);
    expect(await usage(lisa)).toEqual({
      usedBytes: 7000,
      reservedBytes: 3000,
      limitBytes: LIMIT,
      remainingBytes: 0,
      percentage: 100,
      level: 'FULL',
    });
    // Full: even 1 byte, on every path.
    for (const req of [
      () => messageUpload(lisa, ids.lisaMessage, photo(1)),
      () => memoryUpload(lisa, ids.lisaMemory, audio(1)),
      () => recipientPhoto(lisa, ids.lisaRecipient, photo(1)),
    ]) {
      const full = await req().expect(409);
      expect(full.body.message).toBe(STORAGE_FULL);
      expect(JSON.stringify(full.body)).not.toMatch(/7000|10000|limit|plan/i);
    }
  });

  it('at the limit, existing files stay viewable', async () => {
    await lisa
      .get(
        api(`/messages/${ids.lisaMessage}/media/${ids.lisaPhoto}/access-url`),
      )
      .expect(200);
  });

  it('a full quota is per Customer: John is unaffected', async () => {
    expect((await usage(john)).usedBytes).toBe(0);
    await memoryUpload(john, ids.johnMemory, audio(500)).expect(201);
    expect(await usage(john)).toMatchObject({ reservedBytes: 500 });
    expect((await usage(lisa)).level).toBe('FULL');
  });

  it('deleted, FAILED and retired uploads stop counting', async () => {
    // Deleting a pending upload frees its reservation.
    await lisa
      .delete(api(`/memory-vault/${ids.lisaMemory}/media/${ids.lisaAudio}`))
      .expect(204);
    expect(await usage(lisa)).toMatchObject({
      reservedBytes: 2000,
      remainingBytes: 1000,
    });
    // A failed verification (wrong size) → FAILED → freed.
    const res = await messageUpload(lisa, ids.lisaMessage, photo(1000)).expect(
      201,
    );
    await lisa
      .post(
        api(
          `/messages/${ids.lisaMessage}/media/${res.body.mediaAssetId}/complete`,
        ),
      )
      .send({
        providerFileId: storage.upload(res.body.upload, {
          sizeBytes: 999,
          contentType: 'image/jpeg',
        }),
      })
      .expect(400);
    expect((await usage(lisa)).remainingBytes).toBe(1000);
    // A stale upload retired the way MediaCleanup does it (soft delete).
    const pending = await prisma.mediaAsset.findFirstOrThrow({
      where: { owner: { email: emails[0] }, status: 'PENDING_UPLOAD' },
    });
    await prisma.mediaAsset.update({
      where: { id: pending.id },
      data: { deletedAt: new Date() },
    });
    expect((await usage(lisa)).remainingBytes).toBe(2000);
    // Deleting a READY file frees it at once (provider delete may still retry).
    await lisa
      .delete(api(`/messages/${ids.lisaMessage}/media/${ids.lisaPhoto}`))
      .expect(204);
    expect(await usage(lisa)).toMatchObject({
      usedBytes: 0,
      level: 'NORMAL',
    });
  });

  it('concurrent uploads on different paths cannot oversubscribe one Customer', async () => {
    // John has 9500 left; five parallel 3000-byte requests across three
    // kinds of upload: exactly three fit.
    const results = await Promise.all([
      messageUpload(john, ids.johnMessage, photo(3000)),
      messageUpload(john, ids.johnMessage, photo(3000)),
      memoryUpload(john, ids.johnMemory, audio(3000)),
      memoryUpload(john, ids.johnMemory, audio(3000)),
      recipientPhoto(john, ids.johnRecipient, photo(3000)),
    ]);
    const statuses = results.map((r) => r.status).sort((a, b) => a - b);
    expect(statuses).toEqual([201, 201, 201, 409, 409]);
    const u = await usage(john);
    expect(u.reservedBytes).toBe(9500);
    expect(u.reservedBytes).toBeLessThanOrEqual(LIMIT);
  });

  it('a message made from a memory reserves its copies too', async () => {
    // John has 500 left; a 3000-byte READY memory photo cannot be copied.
    const memory = (
      await lisa
        .post(api('/memory-vault'))
        .send({ title: 'Copy me', category: 'OTHER' })
        .expect(201)
    ).body.id;
    const up = await memoryUpload(lisa, memory, photo(3000)).expect(201);
    await lisa
      .post(
        api(`/memory-vault/${memory}/media/${up.body.mediaAssetId}/complete`),
      )
      .send({
        providerFileId: storage.upload(up.body.upload, {
          sizeBytes: 3000,
          contentType: 'image/jpeg',
        }),
      })
      .expect(200);
    // Lisa: 3000 used, 7000 left → one copy fits (6000 counted)...
    const toMessage = (mediaAssetIds: string[]) =>
      lisa.post(api(`/memory-vault/${memory}/messages`)).send({
        title: 'Copy',
        contentType: 'PHOTO',
        includeText: false,
        mediaAssetIds,
        recipientIds: [ids.lisaRecipient],
      });
    await toMessage([up.body.mediaAssetId]).expect(201);
    expect((await usage(lisa)).usedBytes).toBe(6000);
    // ...two more would be 12000: the second is refused, with no draft.
    await toMessage([up.body.mediaAssetId]).expect(201);
    const before = await prisma.message.count({
      where: { owner: { email: emails[0] } },
    });
    const full = await toMessage([up.body.mediaAssetId]).expect(409);
    expect(full.body.message).toBe(STORAGE_FULL);
    expect(
      await prisma.message.count({ where: { owner: { email: emails[0] } } }),
    ).toBe(before);
  });
});
