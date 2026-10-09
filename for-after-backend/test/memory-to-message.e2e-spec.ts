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
import { FakeMalwareScanner } from './fake-malware-scanner.js';
import { FakeMediaStorage, fileStart } from './fake-media-storage.js';

// Phase 13B: a memory becomes an independent DRAFT Message, which then goes
// through the normal Recipient assignment, schedule, release, grant and
// Recipient Portal. Real HTTP, PostgreSQL and Redis; fake ImageKit, scanner
// and OTP delivery. Fictional data only; test users are removed.
describe('Memory → Message (e2e, Phase 13B)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let queue: Queue;
  const run = Date.now();
  const queueName = `test-memory-to-message-${run}`;
  const at = (name: string) => `${name}.${run}@example.test`;
  const customers = ['lisa', 'john'].map((n) => at(`m2m.${n}`));
  const password = 'StrongPassword123!';
  const SOFIA = at('m2m.sofia');

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
  const signIn = async (email: string) => {
    const agent = request.agent(app.getHttpServer());
    await agent.post(api('/auth/login')).send({ email, password }).expect(200);
    return agent;
  };
  // Upload auth → (fake) direct ImageKit upload → verified complete = READY.
  const attach = async (
    agent: Agent,
    memoryId: string,
    kind: 'PHOTO' | 'AUDIO',
    mimeType: string,
    bytes = fileStart(mimeType),
  ) => {
    const base = api(`/memory-vault/${memoryId}/media`);
    const { mediaAssetId, upload } = (
      await agent
        .post(`${base}/upload-url`)
        .send({
          kind,
          originalFileName: `${kind.toLowerCase()}.bin`,
          mimeType,
          sizeBytes: bytes.length,
        })
        .expect(201)
    ).body;
    const providerFileId = storage.upload(upload, {
      sizeBytes: bytes.length,
      contentType: mimeType,
      bytes,
    });
    await agent
      .post(`${base}/${mediaAssetId}/complete`)
      .send({ providerFileId })
      .expect(200);
    return mediaAssetId as string;
  };
  const toMessage = (agent: Agent, memoryId: string, body: object) =>
    agent.post(api(`/memory-vault/${memoryId}/messages`)).send({
      title: 'For Sofia',
      contentType: 'MIXED',
      includeText: true,
      mediaAssetIds: [ids.photo, ids.audio],
      recipientIds: [ids.sofia],
      ...body,
    });
  const mediaOf = async (messageId: string) =>
    (await lisa.get(api(`/messages/${messageId}/media`)).expect(200)).body as {
      id: string;
      kind: string;
      status: string;
    }[];
  const schedule = (agent: Agent, id: string) =>
    agent.post(api(`/messages/${id}/schedule`)).send({
      triggerType: 'FIXED_DATE',
      scheduledFor: new Date(Date.now() + 3_600_000).toISOString(),
    });
  const release = async (id: string) =>
    expect(
      await app
        .get(MessageReleaseService)
        .release(id, new Date(Date.now() + 3_700_000)),
    ).toMatchObject({ result: 'released' });
  const recipientSignIn = async (email: string) => {
    const res = await request(app.getHttpServer())
      .post(api('/recipient-auth/request-otp'))
      .send({ email })
      .expect(202);
    const code = sent.findLast((s) => s.email === email)!.code;
    const agent = request.agent(app.getHttpServer());
    await agent
      .post(api('/recipient-auth/verify-otp'))
      .send({ challengeId: res.body.challengeId, code })
      .expect(200);
    return agent;
  };

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
    ids.johnRecipient = (
      await john.post(api('/recipients')).send({ firstName: 'Sam' }).expect(201)
    ).body.id;
    ids.memory = (
      await lisa
        .post(api('/memory-vault'))
        .send({
          title: 'Christmas at Nana’s',
          category: 'FAMILY',
          textContent: 'Original content',
          tags: ['Family secret tag'],
        })
        .expect(201)
    ).body.id;
    ids.photo = await attach(lisa, ids.memory, 'PHOTO', 'image/jpeg');
    ids.audio = await attach(lisa, ids.memory, 'AUDIO', 'audio/mpeg');
    ids.otherMemory = (
      await lisa
        .post(api('/memory-vault'))
        .send({ title: 'Another memory', category: 'OTHER' })
        .expect(201)
    ).body.id;
    ids.otherPhoto = await attach(lisa, ids.otherMemory, 'PHOTO', 'image/png');
    ids.johnMemory = (
      await john
        .post(api('/memory-vault'))
        .send({ title: 'John’s memory', category: 'OTHER' })
        .expect(201)
    ).body.id;
    ids.johnPhoto = await attach(john, ids.johnMemory, 'PHOTO', 'image/jpeg');
  });

  afterAll(async () => {
    await prisma?.user.deleteMany({ where: { email: { in: customers } } });
    await queue?.obliterate({ force: true }).catch(() => undefined);
    await queue?.close();
    await app?.close();
  });

  it('creates an independent DRAFT with copied text and its own READY copies of the files', async () => {
    const res = await toMessage(lisa, ids.memory, {}).expect(201);
    expect(res.body).toMatchObject({
      title: 'For Sofia',
      contentType: 'MIXED',
      textContent: 'Original content',
      status: 'DRAFT',
      recipients: [{ id: ids.sofia, firstName: 'Sofia' }],
    });
    // The Message DTO only: nothing internal, nothing from the memory.
    expect(JSON.stringify(res.body)).not.toMatch(
      /ownerUserId|deletedAt|storageKey|providerFileId|memory|FAMILY|secret tag/i,
    );
    ids.message = res.body.id;

    const media = await mediaOf(ids.message);
    expect(media.map((m) => [m.kind, m.status])).toEqual([
      ['PHOTO', 'READY'],
      ['AUDIO', 'READY'],
    ]);
    // New rows and new provider files at message paths, not the memory's.
    const rows = await prisma.mediaAsset.findMany({
      where: { messageId: ids.message },
    });
    const sources = await prisma.memoryVaultMediaAsset.findMany({
      where: { memoryVaultItemId: ids.memory },
    });
    for (const row of rows) {
      expect(row.storageKey).toContain(`/messages/${ids.message}/`);
      expect(sources.map((s) => s.id)).not.toContain(row.id);
      expect(sources.map((s) => s.providerFileId)).not.toContain(
        row.providerFileId,
      );
    }
    await lisa
      .get(api(`/messages/${ids.message}/media/${media[0].id}/access-url`))
      .expect(200);
  });

  it('leaves the memory exactly as it was', async () => {
    const memory = await lisa
      .get(api(`/memory-vault/${ids.memory}`))
      .expect(200);
    expect(memory.body).toMatchObject({
      title: 'Christmas at Nana’s',
      category: 'FAMILY',
      textContent: 'Original content',
      tags: [{ name: 'Family secret tag' }],
    });
    const media = await lisa
      .get(api(`/memory-vault/${ids.memory}/media`))
      .expect(200);
    expect(media.body.map((m: { status: string }) => m.status)).toEqual([
      'READY',
      'READY',
    ]);
  });

  it('only the owner’s memory, files and recipients: same 404/400 as missing', async () => {
    await toMessage(john, ids.memory, {
      recipientIds: [ids.johnRecipient],
    }).expect(404);
    for (const mediaAssetIds of [[ids.johnPhoto], [ids.otherPhoto]]) {
      await toMessage(lisa, ids.memory, { mediaAssetIds }).expect(400);
    }
    await toMessage(lisa, ids.memory, {
      recipientIds: [ids.johnRecipient],
    }).expect(400);
    // Explicit contentType: missing or unknown is refused, never inferred.
    for (const contentType of [undefined, 'MEMORY'])
      await toMessage(lisa, ids.memory, { contentType }).expect(400);
    await lisa
      .post(api(`/memory-vault/${ids.memory}/messages`))
      .send({ title: 'x', recipientIds: [ids.sofia] })
      .expect(400);
    // None of the refused requests created anything.
    expect(
      await prisma.message.count({
        where: { owner: { email: customers[0] }, deletedAt: null },
      }),
    ).toBe(1);
  });

  it('the same memory can make several messages; composition is still checked at scheduling', async () => {
    // TEXT with a copied photo, PHOTO with text, AUDIO with text: drafts are
    // allowed, scheduling is not.
    for (const body of [
      { contentType: 'TEXT', mediaAssetIds: [ids.photo] },
      { contentType: 'PHOTO', mediaAssetIds: [ids.photo] },
      { contentType: 'AUDIO', mediaAssetIds: [ids.audio] },
      { contentType: 'MIXED', includeText: false, mediaAssetIds: [ids.photo] },
    ]) {
      const draft = await toMessage(lisa, ids.memory, body).expect(201);
      await schedule(lisa, draft.body.id).expect(409);
      expect(
        (await lisa.get(api(`/messages/${draft.body.id}`)).expect(200)).body
          .status,
      ).toBe('DRAFT');
    }
    // A valid single-modality one schedules.
    const photoOnly = await toMessage(lisa, ids.memory, {
      contentType: 'PHOTO',
      includeText: false,
      mediaAssetIds: [ids.photo],
    }).expect(201);
    await schedule(lisa, photoOnly.body.id).expect(201);
    await lisa
      .delete(api(`/messages/${photoOnly.body.id}/schedule`))
      .expect(204);
  });

  it('an infected copy is FAILED: the draft stays a draft and cannot be scheduled until it is removed', async () => {
    const memory = (
      await lisa
        .post(api('/memory-vault'))
        .send({ title: 'Scanned', category: 'OTHER', textContent: 'Text' })
        .expect(201)
    ).body.id;
    // Clean when uploaded to the memory; the copy is scanned again. The fake
    // scanner is told to flag the next scan (the copy's).
    const photo = await attach(lisa, memory, 'PHOTO', 'image/jpeg');
    scanner.scan.mockResolvedValueOnce('INFECTED');
    const draft = await toMessage(lisa, memory, {
      mediaAssetIds: [photo],
    }).expect(201);
    const [copy] = await mediaOf(draft.body.id);
    expect(copy.status).toBe('FAILED');
    const row = await prisma.mediaAsset.findUniqueOrThrow({
      where: { id: copy.id },
    });
    expect(row.storageDeletedAt).toBeInstanceOf(Date);
    await schedule(lisa, draft.body.id).expect(409);
    // Remove it and continue with text only.
    await lisa
      .delete(api(`/messages/${draft.body.id}/media/${copy.id}`))
      .expect(204);
    await lisa
      .patch(api(`/messages/${draft.body.id}`))
      .send({ contentType: 'TEXT' })
      .expect(200);
    await schedule(lisa, draft.body.id).expect(201);
    await lisa.delete(api(`/messages/${draft.body.id}/schedule`)).expect(204);
    // The memory's own photo is untouched.
    expect(
      (await lisa.get(api(`/memory-vault/${memory}/media`)).expect(200)).body[0]
        .status,
    ).toBe('READY');
  });

  it('editing or deleting the memory and its media never changes the message', async () => {
    await lisa
      .patch(api(`/memory-vault/${ids.memory}`))
      .send({ textContent: 'Changed content', tags: [] })
      .expect(200);
    await lisa
      .delete(api(`/memory-vault/${ids.memory}/media/${ids.photo}`))
      .expect(204);
    const msg = await lisa.get(api(`/messages/${ids.message}`)).expect(200);
    expect(msg.body.textContent).toBe('Original content');
    const media = await mediaOf(ids.message);
    expect(media.map((m) => m.status)).toEqual(['READY', 'READY']);
    await lisa
      .get(api(`/messages/${ids.message}/media/${media[0].id}/access-url`))
      .expect(200);

    await lisa.delete(api(`/memory-vault/${ids.memory}`)).expect(204);
    await lisa.get(api(`/messages/${ids.message}`)).expect(200);
    // The deleted memory can no longer make messages.
    await toMessage(lisa, ids.memory, { mediaAssetIds: [] }).expect(404);
  });

  it('the message is scheduled, released and read by the Recipient: message and copies, never the memory', async () => {
    await schedule(lisa, ids.message).expect(201);
    await release(ids.message);
    expect(
      await prisma.recipientMessageAccessGrant.count({
        where: { messageId: ids.message, recipientId: ids.sofia },
      }),
    ).toBe(1);

    const sofia = await recipientSignIn(SOFIA);
    const list = await sofia.get(api('/recipient/messages')).expect(200);
    expect(JSON.stringify(list.body)).toContain(ids.message);
    const detail = await sofia
      .get(api(`/recipient/messages/${ids.message}`))
      .expect(200);
    expect(detail.body).toMatchObject({
      title: 'For Sofia',
      textContent: 'Original content',
    });
    expect(JSON.stringify(detail.body)).not.toMatch(
      /Christmas at Nana|FAMILY|secret tag|memory/i,
    );
    const media = await sofia
      .get(api(`/recipient/messages/${ids.message}/media`))
      .expect(200);
    expect(media.body).toHaveLength(2);
    await sofia
      .get(
        api(
          `/recipient/messages/${ids.message}/media/${media.body[0].id}/access-url`,
        ),
      )
      .expect(200);
    // Memory Vault routes are Customer-only: no Recipient access of any kind.
    await sofia.get(api(`/memory-vault/${ids.memory}`)).expect(401);
    await sofia.get(api('/memory-vault')).expect(401);
    await sofia.get(api(`/memory-vault/${ids.otherMemory}/media`)).expect(401);
  });

  it('deleting a message (and its copies) never touches the memory it came from', async () => {
    const draft = await toMessage(lisa, ids.otherMemory, {
      contentType: 'PHOTO',
      includeText: false,
      mediaAssetIds: [ids.otherPhoto],
    }).expect(201);
    const [copy] = await mediaOf(draft.body.id);
    await lisa
      .delete(api(`/messages/${draft.body.id}/media/${copy.id}`))
      .expect(204);
    await lisa.delete(api(`/messages/${draft.body.id}`)).expect(204);
    const media = await lisa
      .get(api(`/memory-vault/${ids.otherMemory}/media`))
      .expect(200);
    expect(media.body).toMatchObject([{ id: ids.otherPhoto, status: 'READY' }]);
    await lisa
      .get(
        api(
          `/memory-vault/${ids.otherMemory}/media/${ids.otherPhoto}/access-url`,
        ),
      )
      .expect(200);
  });
});
