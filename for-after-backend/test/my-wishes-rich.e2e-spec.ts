import { ConfigModule } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import { Queue } from 'bullmq';
import session from 'express-session';
import request from 'supertest';
import { adminSignIn } from './admin-sign-in.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { configureApp } from '../src/config/app.setup.js';
import {
  DeathNoticeDelivery,
  type SafetyNoticeInput,
} from '../src/death-verification/death-verification-notice.js';
import { DeathVerificationModule } from '../src/death-verification/death-verification.module.js';
import { MediaModule } from '../src/media/media.module.js';
import { MalwareScanner } from '../src/media/scanner/malware-scanner.service.js';
import { MediaStorage } from '../src/media/storage/media-storage.service.js';
import { MessageSchedulesModule } from '../src/message-schedules/message-schedules.module.js';
import { MessagesModule } from '../src/messages/messages.module.js';
import { MyWishesModule } from '../src/my-wishes/my-wishes.module.js';
import type { OtpDeliveryInput } from '../src/otp-auth/otp-auth.service.js';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { RecipientAuthModule } from '../src/recipient-auth/recipient-auth.module.js';
import { RecipientOtpDelivery } from '../src/recipient-auth/recipient-otp-delivery.js';
import { RecipientPortalModule } from '../src/recipient-portal/recipient-portal.module.js';
import { RecipientsModule } from '../src/recipients/recipients.module.js';
import { RedisModule } from '../src/redis/redis.module.js';
import { TrustedContactAuthModule } from '../src/trusted-contact-auth/trusted-contact-auth.module.js';
import { TrustedContactOtpDelivery } from '../src/trusted-contact-auth/trusted-contact-auth.service.js';
import { TrustedContactPortalModule } from '../src/trusted-contact-portal/trusted-contact-portal.module.js';
import { TrustedContactsModule } from '../src/trusted-contacts/trusted-contacts.module.js';
import { FAKE_MALWARE, FakeMalwareScanner } from './fake-malware-scanner.js';
import { FakeMediaStorage, fileStart } from './fake-media-storage.js';

// Phase 15B (approved policy): rich My Wishes (photo/audio/video) and
// Wish → Message: an independent DRAFT that goes through the normal
// recipients, ON_DEATH / AFTER_DEATH schedule, the real verified-death
// workflow (report → safeguard → review → admin verify), BullMQ release,
// grants and the Recipient Portal. The wish stays private: no Recipient,
// Trusted Contact or admin access. Real HTTP, PostgreSQL, Redis and both
// queues; fake ImageKit, scanner, notices and OTPs. Fictional data only;
// every test user (and so every case) is deleted afterwards.
describe('My Wishes rich answers + Wish → Message + verified-death release (e2e, Phase 15B)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let releaseQueue: Queue;
  let deathQueue: Queue;
  const run = Date.now();
  const at = (name: string) => `${name}.${run}@example.test`;
  const releaseQueueName = `test-wish-release-${run}`;
  const deathQueueName = `test-wish-dv-${run}`;
  const password = 'StrongPassword123!';
  const users = {
    lisa: at('wish.lisa'),
    john: at('wish.john'),
    admin: at('wish.admin'),
  };
  const DAVID = at('wish.david');
  const SOFIA = at('wish.sofia');
  const WISH_TEXT = 'Play something gentle by the sea.';

  const notices: SafetyNoticeInput[] = [];
  const noticeDelivery = {
    sendAccountHolderSafetyNotice: vi.fn(async (input: SafetyNoticeInput) => {
      notices.push(input);
    }),
  };
  const otps: OtpDeliveryInput[] = [];
  const otpDelivery = {
    sendOtp: vi.fn(async (input: OtpDeliveryInput) => {
      otps.push(input);
    }),
  };
  const storage = new FakeMediaStorage();
  const scanner = new FakeMalwareScanner();

  type Agent = ReturnType<typeof request.agent>;
  const agents: Record<string, Agent> = {};
  const ids: Record<string, string> = {};
  const api = (path: string) => `/api/v1${path}`;
  const http = () => request(app.getHttpServer());
  const KEY = 'music-and-readings.music';
  const wish = (key = KEY) => api(`/my-wishes/prompts/${key}`);
  const answer = (key = KEY) => `${wish(key)}/response`;
  const media = (key = KEY) => `${answer(key)}/media`;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const until = async (check: () => Promise<boolean>, ms = 15_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await check()) return;
      await sleep(200);
    }
    throw new Error('condition not met in time');
  };
  const statusOf = async (id: string) =>
    (await prisma.message.findUniqueOrThrow({ where: { id } })).status;
  const caseOf = () =>
    prisma.deathVerificationCase.findFirstOrThrow({
      where: { owner: { email: users.lisa } },
      orderBy: [{ openedAt: 'desc' }, { id: 'desc' }],
    });
  const wishReleases = () =>
    prisma.messageRelease.count({
      where: { message: { owner: { email: users.lisa } } },
    });

  const signIn = async (email: string) => {
    const agent = request.agent(app.getHttpServer());
    await agent.post(api('/auth/login')).send({ email, password }).expect(200);
    return agent;
  };
  const otpSignIn = async (
    base: 'trusted-contact-auth' | 'recipient-auth',
    email: string,
  ) => {
    const { challengeId } = (
      await http()
        .post(api(`/${base}/request-otp`))
        .send({ email })
        .expect(202)
    ).body;
    const agent = request.agent(app.getHttpServer());
    await agent
      .post(api(`/${base}/verify-otp`))
      .send({
        challengeId,
        code: otps.findLast((o) => o.email === email)!.code,
      })
      .expect(200);
    return agent;
  };
  const acknowledge = (agent: Agent) =>
    agent
      .post(api('/my-wishes/disclaimer/acknowledgement'))
      .send({ version: 1 })
      .expect(200);
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
  const toMessage = (agent: Agent, body: object, key = KEY) =>
    agent.post(`${answer(key)}/messages`).send({
      title: 'For Sofia',
      contentType: 'MIXED',
      includeText: true,
      mediaAssetIds: [],
      recipientIds: [ids.sofia],
      ...body,
    });
  const schedule = (id: string, body: object) =>
    agents.lisa.post(api(`/messages/${id}/schedule`)).send(body);

  beforeAll(async () => {
    Object.assign(process.env, {
      RELEASE_QUEUE_NAME: releaseQueueName,
      RELEASE_RECONCILE_INTERVAL_SECONDS: '3600',
      DEATH_VERIFICATION_QUEUE_NAME: deathQueueName,
      DEATH_VERIFICATION_SAFEGUARD_SECONDS: '2',
      DEATH_VERIFICATION_RECONCILE_INTERVAL_SECONDS: '3600',
      TRUSTED_CONTACT_OTP_IP_REQUEST_LIMIT: '10000',
      TRUSTED_CONTACT_OTP_VERIFY_IP_LIMIT: '10000',
      TRUSTED_CONTACT_OTP_REQUEST_LIMIT: '100',
      RECIPIENT_OTP_IP_REQUEST_LIMIT: '10000',
      RECIPIENT_OTP_VERIFY_IP_LIMIT: '10000',
    });
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        RedisModule,
        AuthModule,
        RecipientsModule,
        TrustedContactsModule,
        MessagesModule,
        MessageSchedulesModule,
        MediaModule,
        MyWishesModule,
        RecipientAuthModule,
        RecipientPortalModule,
        TrustedContactAuthModule,
        TrustedContactPortalModule,
        DeathVerificationModule,
      ],
    })
      // Login throttling is covered by the auth e2e tests, not here.
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .overrideProvider(MediaStorage)
      .useValue(storage)
      .overrideProvider(MalwareScanner)
      .useValue(scanner)
      .overrideProvider(DeathNoticeDelivery)
      .useValue(noticeDelivery)
      .overrideProvider(TrustedContactOtpDelivery)
      .useValue(otpDelivery)
      .overrideProvider(RecipientOtpDelivery)
      .useValue(otpDelivery)
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app, new session.MemoryStore());
    await app.init();
    prisma = app.get(PrismaService);
    releaseQueue = new Queue(releaseQueueName, {
      connection: { url: process.env.REDIS_URL! },
    });
    deathQueue = new Queue(deathQueueName, {
      connection: { url: process.env.REDIS_URL! },
    });

    for (const [key, email] of Object.entries(users)) {
      await http()
        .post(api('/auth/register'))
        .send({ email, password, firstName: key, lastName: 'Test' })
        .expect(201);
    }
    await prisma.user.update({
      where: { email: users.admin },
      data: { role: 'ADMIN' },
    });
    for (const [key, email] of Object.entries(users)) {
      agents[key] =
        key === 'admin'
          ? (await adminSignIn(app, email, password)).agent
          : await signIn(email);
    }
    ids.sofia = (
      await agents.lisa
        .post(api('/recipients'))
        .send({ firstName: 'Sofia', email: SOFIA })
        .expect(201)
    ).body.id;
    ids.tc = (
      await agents.lisa
        .post(api('/trusted-contacts'))
        .send({ firstName: 'David', email: DAVID })
        .expect(201)
    ).body.id;
  });

  afterAll(async () => {
    await prisma?.user.deleteMany({
      where: { email: { in: Object.values(users) } },
    });
    await app?.close();
    for (const q of [releaseQueue, deathQueue]) {
      await q?.obliterate({ force: true }).catch(() => undefined);
      await q?.close();
    }
  });

  describe('rich media on a wish', () => {
    it('adding a file is writing a wish: 409 until the current notice is acknowledged; nothing is created', async () => {
      await agents.lisa
        .post(`${media()}/upload-url`)
        .send({
          kind: 'PHOTO',
          mimeType: 'image/jpeg',
          originalFileName: 'a.jpg',
          sizeBytes: 6,
        })
        .expect(409);
      expect(
        await prisma.myWishResponse.count({
          where: { owner: { email: users.lisa } },
        }),
      ).toBe(0);
      await acknowledge(agents.lisa);
    });

    it('a file can start a wish: an upload shell is never “answered” until something is READY', async () => {
      const res = await agents.lisa
        .post(`${media()}/upload-url`)
        .send({
          kind: 'PHOTO',
          mimeType: 'image/jpeg',
          originalFileName: 'a.jpg',
          sizeBytes: 6,
        })
        .expect(201);
      expect((await agents.lisa.get(wish()).expect(200)).body).toMatchObject({
        answered: false,
        response: null,
      });
      await agents.lisa.get(answer()).expect(404);
      // Counts toward the Customer's storage like any upload (Phase 12C).
      expect(
        (await agents.lisa.get(api('/users/me/storage')).expect(200)).body
          .reservedBytes,
      ).toBe(6);
      const fileId = storage.upload(res.body.upload, {
        sizeBytes: 6,
        contentType: 'image/jpeg',
      });
      await agents.lisa
        .post(`${media()}/${res.body.mediaAssetId}/complete`)
        .send({ providerFileId: fileId })
        .expect(200);
      expect((await agents.lisa.get(answer()).expect(200)).body).toMatchObject({
        textContent: null,
        mediaCount: 1,
      });
      expect(
        (await agents.lisa.get(api('/users/me/storage')).expect(200)).body
          .usedBytes,
      ).toBe(6);
      ids.photo = res.body.mediaAssetId;
    });

    it('text + audio + video join the same wish; an infected or fake file never becomes READY', async () => {
      await agents.lisa
        .put(answer())
        .send({ textContent: WISH_TEXT })
        .expect(200);
      ids.audio = await attach(agents.lisa, 'AUDIO', 'audio/mpeg');
      ids.video = await attach(agents.lisa, 'VIDEO', 'video/mp4');
      const infected = await attach(agents.lisa, 'PHOTO', 'image/jpeg', {
        bytes: new Uint8Array([
          ...fileStart('image/jpeg'),
          ...Buffer.from(FAKE_MALWARE),
        ]),
        expect: 400,
      });
      const fake = await attach(agents.lisa, 'PHOTO', 'image/png', {
        bytes: new TextEncoder().encode('<html>'),
        expect: 400,
      });
      for (const id of [infected, fake])
        await agents.lisa.get(`${media()}/${id}/access-url`).expect(409);
      const list = (await agents.lisa.get(media()).expect(200)).body as {
        kind: string;
        status: string;
      }[];
      expect(list.map((m) => [m.kind, m.status])).toEqual([
        ['PHOTO', 'READY'],
        ['AUDIO', 'READY'],
        ['VIDEO', 'READY'],
        ['PHOTO', 'FAILED'],
        ['PHOTO', 'FAILED'],
      ]);
      expect(JSON.stringify(list)).not.toMatch(
        /storageKey|providerFileId|ownerUserId|my-wishes\//,
      );
      const access = await agents.lisa
        .get(`${media()}/${ids.video}/access-url`)
        .expect(200);
      expect(access.body.url).toMatch(/^https:\/\/media\.test\/signed/);
      // Unsupported formats are refused before anything is created.
      for (const bad of [
        { kind: 'PHOTO', mimeType: 'image/svg+xml' },
        { kind: 'VIDEO', mimeType: 'application/pdf' },
      ])
        await agents.lisa
          .post(`${media()}/upload-url`)
          .send({ ...bad, originalFileName: 'x', sizeBytes: 10 })
          .expect(400);
    });

    it('a files-only wish is a wish; an empty one is refused', async () => {
      const key = 'ceremony.setting';
      await agents.lisa.put(answer(key)).send({}).expect(400);
      await attach(agents.lisa, 'PHOTO', 'image/webp', { key });
      const res = await agents.lisa.put(answer(key)).send({}).expect(200);
      expect(res.body).toMatchObject({ textContent: null, mediaCount: 1 });
      await agents.lisa.delete(answer(key)).expect(204);
      expect((await agents.lisa.get(media(key)).expect(200)).body).toEqual([]);
    });

    it('another Customer can neither see, sign, complete, delete nor share these files', async () => {
      expect((await agents.john.get(media()).expect(200)).body).toEqual([]);
      await agents.john.get(`${media()}/${ids.video}/access-url`).expect(404);
      await agents.john.delete(`${media()}/${ids.video}`).expect(404);
      await agents.john
        .post(`${media()}/${ids.video}/complete`)
        .send({ providerFileId: 'x' })
        .expect(404);
      await agents.john.get(answer()).expect(404);
      const sam = (
        await agents.john
          .post(api('/recipients'))
          .send({ firstName: 'Sam' })
          .expect(201)
      ).body.id;
      await toMessage(agents.john, {
        mediaAssetIds: [ids.photo],
        recipientIds: [sam],
      }).expect(404);
    });
  });

  describe('Wish → Message', () => {
    it('an independent MIXED DRAFT with the copied text and READY copies at message paths', async () => {
      const res = await toMessage(agents.lisa, {
        mediaAssetIds: [ids.photo, ids.audio, ids.video],
      }).expect(201);
      ids.onDeath = res.body.id;
      expect(res.body).toMatchObject({
        status: 'DRAFT',
        contentType: 'MIXED',
        textContent: WISH_TEXT,
        recipients: [{ id: ids.sofia }],
      });
      expect(JSON.stringify(res.body)).not.toMatch(
        /promptKey|music-and-readings|my-wishes/i,
      );
      const copies = await prisma.mediaAsset.findMany({
        where: { messageId: ids.onDeath },
        orderBy: { createdAt: 'asc' },
      });
      const sources = await prisma.myWishMediaAsset.findMany({
        where: { id: { in: [ids.photo, ids.audio, ids.video] } },
      });
      expect(copies.map((c) => [c.kind, c.status])).toEqual([
        ['PHOTO', 'READY'],
        ['AUDIO', 'READY'],
        ['VIDEO', 'READY'],
      ]);
      for (const c of copies) {
        expect(c.storageKey).toContain(`/messages/${ids.onDeath}/`);
        expect(sources.map((s) => s.providerFileId)).not.toContain(
          c.providerFileId,
        );
        expect(sources.map((s) => s.id)).not.toContain(c.id);
      }
      // A wish file id is never a Message file id.
      await agents.lisa
        .get(api(`/messages/${ids.onDeath}/media/${ids.photo}/access-url`))
        .expect(404);
    });

    it('explicit type only; own READY files of this wish only; composition still gates scheduling', async () => {
      for (const contentType of [undefined, 'WISH', 'MY_WISH'])
        await toMessage(agents.lisa, { contentType }).expect(400);
      // Another wish's file looks invalid.
      const other = await attach(agents.lisa, 'PHOTO', 'image/png', {
        key: 'atmosphere.feeling',
      });
      await toMessage(agents.lisa, {
        contentType: 'PHOTO',
        includeText: false,
        mediaAssetIds: [other],
      }).expect(400);
      // Drafts may be incomplete; scheduling refuses a wrong composition.
      for (const over of [
        { contentType: 'PHOTO', includeText: true, mediaAssetIds: [ids.photo] },
        { contentType: 'TEXT', includeText: true, mediaAssetIds: [ids.audio] },
        {
          contentType: 'MIXED',
          includeText: false,
          mediaAssetIds: [ids.video],
        },
      ]) {
        const draft = await toMessage(agents.lisa, over).expect(201);
        await schedule(draft.body.id, { triggerType: 'ON_DEATH' }).expect(409);
        await agents.lisa.delete(api(`/messages/${draft.body.id}`)).expect(204);
      }
    });

    it('one wish makes several messages: ON_DEATH, AFTER_DEATH (overdue) and AFTER_DEATH (future)', async () => {
      await schedule(ids.onDeath, { triggerType: 'ON_DEATH' }).expect(201);
      ids.afterDue = (
        await toMessage(agents.lisa, {
          title: 'A week after',
          contentType: 'AUDIO',
          includeText: false,
          mediaAssetIds: [ids.audio],
        }).expect(201)
      ).body.id;
      await schedule(ids.afterDue, {
        triggerType: 'AFTER_DEATH',
        afterDeathDays: 7,
      }).expect(201);
      ids.afterFuture = (
        await toMessage(agents.lisa, {
          title: 'A year after',
          contentType: 'TEXT',
          mediaAssetIds: [],
        }).expect(201)
      ).body.id;
      await schedule(ids.afterFuture, {
        triggerType: 'AFTER_DEATH',
        afterDeathDays: 365,
      }).expect(201);
    });

    it('editing or deleting the wish and its files never changes the messages (and the reverse)', async () => {
      // A message deleted with its copy: the wish and its files stay.
      const extra = (
        await toMessage(agents.lisa, {
          contentType: 'VIDEO',
          includeText: false,
          mediaAssetIds: [ids.video],
        }).expect(201)
      ).body.id;
      // Editing a message never edits the wish.
      await agents.lisa
        .patch(api(`/messages/${extra}`))
        .send({ title: 'Edited in the message only' })
        .expect(200);
      const [copy] = (
        await agents.lisa.get(api(`/messages/${extra}/media`)).expect(200)
      ).body;
      await agents.lisa
        .delete(api(`/messages/${extra}/media/${copy.id}`))
        .expect(204);
      await agents.lisa.delete(api(`/messages/${extra}`)).expect(204);
      await agents.lisa.get(`${media()}/${ids.video}/access-url`).expect(200);
      expect((await agents.lisa.get(answer()).expect(200)).body).toMatchObject({
        textContent: WISH_TEXT,
        mediaCount: 3,
      });

      // Editing, then deleting the wish (and its files) after scheduling.
      await agents.lisa
        .put(answer())
        .send({ textContent: 'Changed my mind.' })
        .expect(200);
      await agents.lisa.delete(`${media()}/${ids.photo}`).expect(204);
      await agents.lisa.delete(answer()).expect(204);
      await agents.lisa.get(answer()).expect(404);
      expect((await agents.lisa.get(media()).expect(200)).body).toEqual([]);
      const msg = await agents.lisa
        .get(api(`/messages/${ids.onDeath}`))
        .expect(200);
      expect(msg.body).toMatchObject({
        status: 'SCHEDULED',
        textContent: WISH_TEXT,
      });
      const files = (
        await agents.lisa.get(api(`/messages/${ids.onDeath}/media`)).expect(200)
      ).body;
      expect(files.map((f: { status: string }) => f.status)).toEqual([
        'READY',
        'READY',
        'READY',
      ]);
      for (const f of files)
        await agents.lisa
          .get(api(`/messages/${ids.onDeath}/media/${f.id}/access-url`))
          .expect(200);
    });
  });

  describe('after-death release: verified death only, through the existing workflow', () => {
    it('a Trusted Contact report releases nothing; they never reach wishes or messages', async () => {
      const david = await otpSignIn('trusted-contact-auth', DAVID);
      agents.david = david;
      for (const path of [
        '/my-wishes/prompts',
        `/my-wishes/prompts/${KEY}/response`,
        `/my-wishes/prompts/${KEY}/response/media`,
        `/my-wishes/prompts/${KEY}/response/media/${ids.audio}/access-url`,
        `/messages/${ids.onDeath}`,
        '/recipient/messages',
      ])
        await david.get(api(path)).expect(401);
      await david
        .post(`${answer()}/messages`)
        .send({
          title: 'x',
          contentType: 'TEXT',
          includeText: true,
          mediaAssetIds: [],
          recipientIds: [ids.sofia],
        })
        .expect(401);
      const accounts = await david
        .get(api('/trusted-contact/accounts'))
        .expect(200);
      expect(JSON.stringify(accounts.body)).not.toMatch(
        /sea|Changed my mind|music|For Sofia|A week after/i,
      );

      const res = await david
        .post(api(`/trusted-contact/accounts/${ids.tc}/death-reports`))
        .send({ confirmReport: true, reportedDateOfDeath: '2026-09-01' })
        .expect(201);
      ids.case = res.body.caseId;
      expect((await caseOf()).status).toBe('SAFEGUARD_ACTIVE');
      expect(await statusOf(ids.onDeath)).toBe('SCHEDULED');
      expect(await wishReleases()).toBe(0);
    });

    it('safeguard and READY_FOR_REVIEW release nothing; the admin cannot verify early', async () => {
      await agents.admin
        .post(api(`/admin/death-verifications/${ids.case}/verify`))
        .send({
          verifiedDeathAt: new Date(Date.now() - 60 * 86_400_000).toISOString(),
          confirmVerification: true,
          decisionNote: 'Fictional Phase 15B test.',
        })
        .expect(409);
      await until(async () => (await caseOf()).status === 'READY_FOR_REVIEW');
      for (const id of [ids.onDeath, ids.afterDue, ids.afterFuture])
        expect(await statusOf(id)).toBe('SCHEDULED');
      expect(await wishReleases()).toBe(0);
      expect(
        await prisma.deathTriggeredMessageActivation.count({
          where: { deathVerificationCaseId: ids.case },
        }),
      ).toBe(0);
    });

    it('admins operate the case but never see wish or message content, and have no My Wishes access', async () => {
      const detail = await agents.admin
        .get(api(`/admin/death-verifications/${ids.case}`))
        .expect(200);
      expect(JSON.stringify(detail.body)).not.toMatch(
        /sea|Changed my mind|music-and-readings|For Sofia|A week after|my-wishes/i,
      );
      const res = await agents.admin.get(api('/my-wishes/prompts'));
      expect([401, 403]).toContain(res.status);
    });

    it('admin verifies: ON_DEATH and overdue AFTER_DEATH are released by the queue; the future one waits', async () => {
      const deathAt = new Date(Date.now() - 60 * 86_400_000);
      await agents.admin
        .post(api(`/admin/death-verifications/${ids.case}/verify`))
        .send({
          verifiedDeathAt: deathAt.toISOString(),
          confirmVerification: true,
          decisionNote: 'Fictional Phase 15B test.',
        })
        .expect(200);
      const kase = await caseOf();
      const acts = await prisma.deathTriggeredMessageActivation.findMany({
        where: { deathVerificationCaseId: ids.case },
      });
      const due = Object.fromEntries(acts.map((a) => [a.messageId, a.dueAt]));
      expect(due[ids.onDeath]).toEqual(kase.verifiedAt);
      expect(due[ids.afterDue]).toEqual(
        new Date(deathAt.getTime() + 7 * 86_400_000),
      );
      expect(due[ids.afterFuture]).toEqual(
        new Date(deathAt.getTime() + 365 * 86_400_000),
      );
      await until(
        async () =>
          (await statusOf(ids.onDeath)) === 'RELEASED' &&
          (await statusOf(ids.afterDue)) === 'RELEASED',
      );
      expect(await statusOf(ids.afterFuture)).toBe('SCHEDULED');
      expect(
        await prisma.recipientMessageAccessGrant.count({
          where: {
            recipientId: ids.sofia,
            messageId: { in: [ids.onDeath, ids.afterDue] },
          },
        }),
      ).toBe(2);
    });

    it('the Recipient sees the released messages and copies only, never My Wishes', async () => {
      const sofia = await otpSignIn('recipient-auth', SOFIA);
      const list = (await sofia.get(api('/recipient/messages')).expect(200))
        .body as { id: string }[];
      expect(list.map((m) => m.id).sort()).toEqual(
        [ids.onDeath, ids.afterDue].sort(),
      );
      const detail = await sofia
        .get(api(`/recipient/messages/${ids.onDeath}`))
        .expect(200);
      // The snapshot from before the wish was edited and deleted.
      expect(detail.body.textContent).toBe(WISH_TEXT);
      expect(JSON.stringify(detail.body)).not.toMatch(
        /promptKey|music-and-readings|my-wishes|Changed my mind/i,
      );
      const files = (
        await sofia
          .get(api(`/recipient/messages/${ids.onDeath}/media`))
          .expect(200)
      ).body as { id: string }[];
      expect(files).toHaveLength(3);
      for (const f of files)
        await sofia
          .get(
            api(`/recipient/messages/${ids.onDeath}/media/${f.id}/access-url`),
          )
          .expect(200);
      await sofia
        .get(api(`/recipient/messages/${ids.afterFuture}`))
        .expect(404);
      for (const path of [
        '/my-wishes/prompts',
        '/my-wishes/disclaimer',
        `/my-wishes/prompts/${KEY}/response`,
        `/my-wishes/prompts/${KEY}/response/media`,
        `/my-wishes/prompts/${KEY}/response/media/${ids.audio}/access-url`,
      ])
        await sofia.get(api(path)).expect(401);
    });

    // The delete purged them through MediaCleanup at once. Never call
    // reconcile() here: it scans every media table in the shared database.
    it('the deleted wish files were removed through the existing cleanup; message copies stay', async () => {
      const sources = await prisma.myWishMediaAsset.findMany({
        where: { id: { in: [ids.photo, ids.audio, ids.video] } },
      });
      for (const s of sources) expect(s.storageDeletedAt).not.toBeNull();
      const copies = await prisma.mediaAsset.findMany({
        where: { messageId: ids.onDeath },
      });
      for (const c of copies) {
        expect(c.storageDeletedAt).toBeNull();
        expect(c.status).toBe('READY');
      }
    });
  });
});
