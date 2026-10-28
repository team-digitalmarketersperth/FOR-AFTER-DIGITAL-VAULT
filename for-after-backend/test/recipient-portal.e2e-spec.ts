import { ConfigModule } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';
import session from 'express-session';
import request from 'supertest';
import { AuthModule } from '../src/auth/auth.module.js';
import { configureApp, SESSION_COOKIE } from '../src/config/app.setup.js';
import { MediaModule } from '../src/media/media.module.js';
import { MalwareScanner } from '../src/media/scanner/malware-scanner.service.js';
import { MediaStorage } from '../src/media/storage/media-storage.service.js';
import { FakeMalwareScanner } from './fake-malware-scanner.js';
import { FakeMediaStorage } from './fake-media-storage.js';
import { MessageReleaseService } from '../src/message-release/message-release.service.js';
import { MessageSchedulesModule } from '../src/message-schedules/message-schedules.module.js';
import { MessagesModule } from '../src/messages/messages.module.js';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { RecipientAuthModule } from '../src/recipient-auth/recipient-auth.module.js';
import {
  INVALID_CODE,
  OTP_REQUESTED,
  RECIPIENT_SESSION_COOKIE,
  SMS_OTP_REQUESTED,
} from '../src/recipient-auth/recipient-auth.service.js';
import { SmsVerification } from '../src/sms/sms-verification.js';
import {
  RecipientOtpDelivery,
  type OtpDeliveryInput,
} from '../src/recipient-auth/recipient-otp-delivery.js';
import { RecipientPortalModule } from '../src/recipient-portal/recipient-portal.module.js';
import { RecipientsModule } from '../src/recipients/recipients.module.js';
import { RedisModule } from '../src/redis/redis.module.js';
import { UsersModule } from '../src/users/users.module.js';

// Real HTTP, validation, guards, PostgreSQL and Redis (OTP challenges and
// Recipient sessions). Customer sessions use MemoryStore; object storage is
// mocked; OTP delivery is a fake that captures codes in memory (never via
// the API). Releases are executed deterministically through
// MessageReleaseService. Fictional data only; test users are removed.
describe('Recipient Portal (e2e, PostgreSQL + Redis)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let queue: Queue;
  const run = Date.now();
  const queueName = `test-recipient-portal-${run}`;
  const at = (name: string) => `${name}.${run}@example.test`;
  const customers = ['lisa', 'john'].map((n) => at(`portal.${n}`));
  const password = 'StrongPassword123!';
  const SOFIA = at('sofia');
  const JENNY = at('jenny');
  const SHARED = at('shared');
  const NORA = at('nora');

  const sent: OtpDeliveryInput[] = [];
  const delivery = {
    sendOtp: vi.fn(async (input: OtpDeliveryInput) => {
      sent.push(input);
    }),
  };
  const storage = new FakeMediaStorage();
  const scanner = new FakeMalwareScanner();
  // Twilio Verify stand-in: never sends. Like Verify, one pending
  // verification per number (a resend reuses it), approved once.
  const SMS_CODE = '246810';
  // Per run, like the emails: rate-limit windows outlive a local rerun.
  const mobile = (n: number) => `+614${n}${String(run).slice(-7)}`;
  const MAX_MOBILE = mobile(0);
  const MAX_MASKED = `+61******${MAX_MOBILE.slice(-3)}`;
  const pending = new Set<string>();
  const sms = {
    name: 'fake',
    send: vi.fn(async (to: string) => void pending.add(to)),
    check: vi.fn(
      async (to: string, code: string) =>
        code === SMS_CODE && pending.delete(to),
    ),
  } satisfies SmsVerification;

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
  const addRecipient = async (agent: Agent, body: object) =>
    (await agent.post(api('/recipients')).send(body).expect(201)).body
      .id as string;
  const addMessage = async (agent: Agent, recipientIds: string[], extra = {}) =>
    (
      await agent
        .post(api('/messages'))
        .send({
          title: 'For you',
          contentType: 'TEXT',
          textContent: 'Fictional released text.',
          recipientIds,
          ...extra,
        })
        .expect(201)
    ).body.id as string;
  const schedule = (agent: Agent, id: string) =>
    agent
      .post(api(`/messages/${id}/schedule`))
      .send({
        triggerType: 'FIXED_DATE',
        scheduledFor: new Date(Date.now() + 3_600_000).toISOString(),
      })
      .expect(201);
  // Deterministic release: run the Step 12 service "an hour and a bit later".
  const release = async (id: string) =>
    expect(
      await app
        .get(MessageReleaseService)
        .release(id, new Date(Date.now() + 3_700_000)),
    ).toMatchObject({ result: 'released' });
  const released = async (agent: Agent, recipientIds: string[], extra = {}) => {
    const id = await addMessage(agent, recipientIds, extra);
    await schedule(agent, id);
    await release(id);
    return id;
  };
  // upload auth → (fake) direct ImageKit upload → verified complete = READY
  const attachMedia = async (
    messageId: string,
    kind: 'PHOTO' | 'AUDIO' | 'VIDEO',
    mimeType: string,
  ) => {
    const { mediaAssetId, upload } = (
      await lisa
        .post(api(`/messages/${messageId}/media/upload-url`))
        .send({
          kind,
          originalFileName: `a.${kind}`,
          mimeType,
          sizeBytes: 1000,
        })
        .expect(201)
    ).body as {
      mediaAssetId: string;
      upload: Parameters<FakeMediaStorage['upload']>[0];
    };
    const providerFileId = storage.upload(upload, {
      sizeBytes: 1000,
      contentType: mimeType,
    });
    await lisa
      .post(api(`/messages/${messageId}/media/${mediaAssetId}/complete`))
      .send({ providerFileId })
      .expect(200);
    return mediaAssetId;
  };

  const requestOtp = (email: string) =>
    request(app.getHttpServer())
      .post(api('/recipient-auth/request-otp'))
      .send({ email });
  // Full OTP sign-in; the code comes from the fake delivery only.
  const recipientSignIn = async (email: string) => {
    const res = await requestOtp(email).expect(202);
    const code = sent.findLast((s) => s.email === email)!.code;
    const agent = request.agent(app.getHttpServer());
    await agent
      .post(api('/recipient-auth/verify-otp'))
      .send({ challengeId: res.body.challengeId, code })
      .expect(200);
    return agent;
  };
  const noLeaks = (body: unknown) =>
    expect(JSON.stringify(body)).not.toMatch(
      /ownerUserId|owner|schedule|scheduledFor|afterDeathDays|storageKey|deletedAt|recipientId|recipients|grant|privateNote|Sarah graduates|version|draft|recovery|death|trusted|firstName|lastName|email|mobile|providerFileId|birthday|relationship|jobId|portal\.lisa|portal\.john|"status"/i,
    );

  beforeAll(async () => {
    process.env.RELEASE_QUEUE_NAME = queueName;
    process.env.RELEASE_RECONCILE_INTERVAL_SECONDS = '3600';
    // Local runs repeat within the 15 min window from one IP.
    process.env.RECIPIENT_OTP_IP_REQUEST_LIMIT = '10000';
    process.env.RECIPIENT_OTP_VERIFY_IP_LIMIT = '10000';
    // Sofia signs in several times below; the burst test uses this limit.
    process.env.RECIPIENT_OTP_REQUEST_LIMIT = '10';
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
        RecipientAuthModule,
        RecipientPortalModule,
        // Phase 18: renaming the sender through the real profile route.
        UsersModule,
      ],
    })
      .overrideProvider(MediaStorage)
      .useValue(storage)
      .overrideProvider(MalwareScanner)
      .useValue(scanner)
      .overrideProvider(RecipientOtpDelivery)
      .useValue(delivery)
      .overrideProvider(SmsVerification)
      .useValue(sms)
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app, new session.MemoryStore());
    await app.init();
    prisma = app.get(PrismaService);
    queue = new Queue(queueName, {
      connection: { url: process.env.REDIS_URL! },
    });

    for (const [i, email] of customers.entries()) {
      await request(app.getHttpServer())
        .post(api('/auth/register'))
        .send({
          email,
          password,
          firstName: ['Lisa', 'John'][i],
          lastName: 'Test',
        })
        .expect(201);
    }
    lisa = await signIn(customers[0]);
    john = await signIn(customers[1]);

    // Mixed case on purpose: stored and snapshotted lowercased.
    ids.sofia = await addRecipient(lisa, {
      firstName: 'Sofia',
      email: SOFIA.toUpperCase(),
      birthday: '2001-02-03',
      relationship: 'Daughter',
      privateNote: 'Private note, never shared.',
    });
    ids.jenny = await addRecipient(lisa, { firstName: 'Jenny', email: JENNY });
    ids.max = await addRecipient(lisa, {
      firstName: 'Max',
      mobile: `+61 ${MAX_MOBILE.slice(3, 6)} ${MAX_MOBILE.slice(6)}`,
    });
    ids.nora = await addRecipient(lisa, { firstName: 'Nora', email: NORA });
    ids.lisaShared = await addRecipient(lisa, {
      firstName: 'Sam',
      email: SHARED,
    });
    ids.johnShared = await addRecipient(john, {
      firstName: 'Sam',
      email: SHARED,
    });

    // Private notes to self: the owner's, never the Recipient's.
    ids.text = await released(lisa, [ids.sofia, ids.max], {
      textContent: 'Many happy returns.',
      privateNote: 'Rewrite this after Sarah graduates.',
    });
    ids.jennyMsg = await released(lisa, [ids.jenny]);
    ids.draft = await addMessage(lisa, [ids.sofia], { title: 'Draft' });
    ids.scheduled = await addMessage(lisa, [ids.sofia], { title: 'Later' });
    await schedule(lisa, ids.scheduled);
  });

  afterAll(async () => {
    await prisma?.user.deleteMany({ where: { email: { in: customers } } });
    await app?.close();
    await queue?.obliterate({ force: true });
    await queue?.close();
  });

  describe('release → access grants', () => {
    it('one grant per assigned recipient, with normalized contact snapshots only', async () => {
      const [rel] = await prisma.messageRelease.findMany({
        where: { messageId: ids.text },
      });
      const grants = await prisma.recipientMessageAccessGrant.findMany({
        where: { messageId: ids.text },
        orderBy: { recipientEmailNormalized: 'asc' },
      });
      expect(grants).toHaveLength(2);
      expect(grants.map((g) => g.messageReleaseId)).toEqual([rel.id, rel.id]);
      const byRecipient = Object.fromEntries(
        grants.map((g) => [g.recipientId, g]),
      );
      expect(byRecipient[ids.sofia]).toMatchObject({
        recipientEmailNormalized: SOFIA,
        recipientMobileNormalized: null,
      });
      // Mobile-only: granted, just not reachable by email OTP yet.
      expect(byRecipient[ids.max]).toMatchObject({
        recipientEmailNormalized: null,
        recipientMobileNormalized: MAX_MOBILE,
      });
      expect(JSON.stringify(grants)).not.toMatch(/Private note|2001|Daughter/);
    });

    it('re-running the release does not duplicate grants', async () => {
      expect(await app.get(MessageReleaseService).release(ids.text)).toEqual({
        result: 'already_released',
      });
      expect(
        await prisma.recipientMessageAccessGrant.count({
          where: { messageId: ids.text },
        }),
      ).toBe(2);
    });

    it('editing or deleting the Recipient after release does not move or revoke access', async () => {
      const id = await released(lisa, [ids.nora]);
      await lisa
        .patch(api(`/recipients/${ids.nora}`))
        .send({ email: at('someone-else') })
        .expect(200);
      await lisa.delete(api(`/recipients/${ids.nora}`)).expect(204);
      const grant = await prisma.recipientMessageAccessGrant.findFirstOrThrow({
        where: { messageId: id },
      });
      expect(grant.recipientEmailNormalized).toBe(NORA);
      const nora = await recipientSignIn(NORA);
      await nora.get(api(`/recipient/messages/${id}`)).expect(200);
      // The new address got nothing.
      await requestOtp(at('someone-else')).expect(202);
      expect(sent.some((s) => s.email === at('someone-else'))).toBe(false);
    });
  });

  describe('OTP sign-in', () => {
    it('invalid email → 400; extra fields → 400', async () => {
      await requestOtp('not-an-email').expect(400);
      await request(app.getHttpServer())
        .post(api('/recipient-auth/request-otp'))
        .send({ email: SOFIA, recipientId: ids.sofia })
        .expect(400);
    });

    it('known and unknown emails get the same 202 response shape', async () => {
      const known = await requestOtp(`  ${SOFIA.toUpperCase()} `).expect(202);
      const unknown = await requestOtp(at('nobody')).expect(202);
      for (const res of [known, unknown]) {
        expect(Object.keys(res.body).sort()).toEqual([
          'challengeId',
          'message',
        ]);
        expect(res.body.message).toBe(OTP_REQUESTED);
        expect(res.body.challengeId).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(res.body).not.toHaveProperty('code');
      }
      expect(sent.at(-1)?.email).toBe(SOFIA);
      expect(sent.some((s) => s.email === at('nobody'))).toBe(false);
    });

    it('wrong code → 401 generic; right code → 200 + HttpOnly cookie; reuse → 401', async () => {
      const { challengeId } = (await requestOtp(SOFIA).expect(202)).body;
      const code = sent.at(-1)!.code;
      const wrong = String((Number(code) + 1) % 1e6).padStart(6, '0');
      const verify = (c: string) =>
        request(app.getHttpServer())
          .post(api('/recipient-auth/verify-otp'))
          .send({ challengeId, code: c });
      const bad = await verify(wrong).expect(401);
      expect(bad.body.message).toBe(INVALID_CODE);

      const ok = await verify(code).expect(200);
      expect(ok.body).toEqual({ authenticated: true, email: SOFIA });
      const cookie = String(ok.headers['set-cookie']);
      expect(cookie).toMatch(new RegExp(`^${RECIPIENT_SESSION_COOKIE}=`));
      expect(cookie).toMatch(/HttpOnly/);
      expect(cookie).toMatch(/SameSite=Lax/);
      expect(cookie).not.toContain(`${SESSION_COOKIE}=`);

      expect((await verify(code).expect(401)).body.message).toBe(INVALID_CODE);
    });

    it('too many wrong codes make the challenge unusable', async () => {
      const { challengeId } = (await requestOtp(SOFIA).expect(202)).body;
      const code = sent.at(-1)!.code;
      const wrong = String((Number(code) + 1) % 1e6).padStart(6, '0');
      for (let i = 0; i < 5; i++) {
        await request(app.getHttpServer())
          .post(api('/recipient-auth/verify-otp'))
          .send({ challengeId, code: wrong })
          .expect(401);
      }
      await request(app.getHttpServer())
        .post(api('/recipient-auth/verify-otp'))
        .send({ challengeId, code })
        .expect(401);
    });

    it('a valid code for an email without released content → 401', async () => {
      const { challengeId } = (await requestOtp(at('nobody2')).expect(202))
        .body;
      // No code was sent; any guess fails the same way.
      await request(app.getHttpServer())
        .post(api('/recipient-auth/verify-otp'))
        .send({ challengeId, code: '123456' })
        .expect(401);
    });

    it('too many requests for one email → 429', async () => {
      const email = at('burst');
      for (let i = 0; i < 10; i++) await requestOtp(email).expect(202);
      await requestOtp(email).expect(429);
    });
  });

  describe('SMS sign-in (Twilio Verify, faked)', () => {
    const requestSms = (mobile: unknown, extra = {}) =>
      request(app.getHttpServer())
        .post(api('/recipient-auth/request-sms-otp'))
        .send({ mobile, ...extra });
    const verifySms = (
      mobile: string,
      code: string,
      agent: Agent | null = null,
    ) =>
      (agent ?? request(app.getHttpServer()))
        .post(api('/recipient-auth/verify-sms-otp'))
        .send({ mobile, code });

    it('not E.164, missing or extra fields -> 400', async () => {
      for (const mobile of ['0400 000 000', '61400000000', 'abc', 123, '']) {
        await requestSms(mobile).expect(400);
      }
      await requestSms(MAX_MOBILE, { recipientId: ids.max }).expect(400);
      await request(app.getHttpServer())
        .post(api('/recipient-auth/verify-sms-otp'))
        .send({ mobile: MAX_MOBILE, code: '12345' })
        .expect(400);
    });

    it('known and unknown mobiles get the same 202; only the eligible one is texted', async () => {
      sms.send.mockClear();
      const known = await requestSms(
        `+61 ${MAX_MOBILE.slice(3, 6)} ${MAX_MOBILE.slice(6)}`,
      ).expect(202);
      const unknown = await requestSms(mobile(9)).expect(202);
      expect(known.body).toEqual({ message: SMS_OTP_REQUESTED });
      expect(unknown.body).toEqual(known.body);
      await new Promise((r) => setImmediate(r));
      expect(sms.send).toHaveBeenCalledExactlyOnceWith(MAX_MOBILE);
    });

    it('wrong code -> 401 and no cookie; approved -> the Recipient cookie; reuse -> 401', async () => {
      await requestSms(MAX_MOBILE).expect(202);
      const bad = await verifySms(MAX_MOBILE, '000000').expect(401);
      expect(bad.body.message).toBe(INVALID_CODE);
      expect(bad.headers['set-cookie']).toBeUndefined();

      const ok = await verifySms(MAX_MOBILE, SMS_CODE).expect(200);
      expect(ok.body).toEqual({ authenticated: true, mobile: MAX_MASKED });
      const cookie = String(ok.headers['set-cookie']);
      expect(cookie).toMatch(new RegExp(`^${RECIPIENT_SESSION_COOKIE}=`));
      expect(cookie).toMatch(/HttpOnly/);
      expect(cookie).toMatch(/SameSite=Lax/);
      expect(cookie).not.toContain(`${SESSION_COOKIE}=`);
      expect(
        (await verifySms(MAX_MOBILE, SMS_CODE).expect(401)).body.message,
      ).toBe(INVALID_CODE);
    });

    it('an SMS session sees exactly the grants on that mobile; logout ends it', async () => {
      await requestSms(MAX_MOBILE).expect(202);
      const max = request.agent(app.getHttpServer());
      await verifySms(MAX_MOBILE, SMS_CODE, max).expect(200);
      expect((await max.get(api('/recipient-auth/me')).expect(200)).body).toEqual(
        { authenticated: true, mobile: MAX_MASKED },
      );
      const res = await max.get(api('/recipient/messages')).expect(200);
      expect((res.body as { id: string }[]).map((m) => m.id)).toEqual([
        ids.text,
      ]);
      noLeaks(res.body);
      await max.get(api(`/recipient/messages/${ids.text}`)).expect(200);
      for (const hidden of [ids.jennyMsg, ids.draft, ids.scheduled]) {
        await max.get(api(`/recipient/messages/${hidden}`)).expect(404);
      }
      await max.post(api('/recipient-auth/logout')).expect(204);
      await max.get(api('/recipient/messages')).expect(401);
    });

    it('an ineligible mobile never reaches the provider, even with a "valid" code', async () => {
      sms.check.mockClear();
      await verifySms(mobile(9), SMS_CODE).expect(401);
      expect(sms.check).not.toHaveBeenCalled();
    });

    it('a Customer session is no Recipient session and does not help sign in', async () => {
      await lisa.get(api('/recipient/messages')).expect(401);
      await requestSms(MAX_MOBILE).expect(202);
      const res = await verifySms(MAX_MOBILE, '000000', lisa).expect(401);
      expect(res.headers['set-cookie']).toBeUndefined();
      await lisa.get(api('/recipient/messages')).expect(401);
      // Burn the outstanding fake code.
      await verifySms(MAX_MOBILE, SMS_CODE).expect(200);
    });

    it('a removed Recipient (no grant on the mobile) cannot sign in', async () => {
      const rae = mobile(7);
      const id = await addRecipient(lisa, { firstName: 'Rae', mobile: rae });
      const msg = await released(lisa, [id]);
      await requestSms(rae).expect(202);
      await prisma.recipientMessageAccessGrant.deleteMany({
        where: { messageId: msg },
      });
      await verifySms(rae, SMS_CODE).expect(401);
    });

    it('too many requests for one mobile -> 429', async () => {
      const burst = mobile(8);
      for (let i = 0; i < 10; i++) await requestSms(burst).expect(202);
      await requestSms(burst).expect(429);
    });
  });

  describe('released message access', () => {
    let sofia: Agent;
    beforeAll(async () => {
      sofia = await recipientSignIn(SOFIA);
    });

    it('/recipient-auth/me', async () => {
      const res = await sofia.get(api('/recipient-auth/me')).expect(200);
      expect(res.body).toEqual({ authenticated: true, email: SOFIA });
    });

    it('lists only released, granted messages with safe fields', async () => {
      const res = await sofia.get(api('/recipient/messages')).expect(200);
      const listed = (res.body as { id: string }[]).map((m) => m.id);
      expect(listed).toContain(ids.text);
      for (const hidden of [ids.draft, ids.scheduled, ids.jennyMsg]) {
        expect(listed).not.toContain(hidden);
      }
      expect(res.body.find((m: { id: string }) => m.id === ids.text)).toEqual({
        id: ids.text,
        title: 'For you',
        contentType: 'TEXT',
        releasedAt: expect.any(String),
        hasMedia: false,
        // Phase 18: the sender's display name snapshot, nothing else of theirs.
        senderDisplayName: 'Lisa Test',
      });
      noLeaks(res.body);
    });

    it('detail returns released text; draft, scheduled, other recipient, guessed → 404', async () => {
      const res = await sofia
        .get(api(`/recipient/messages/${ids.text}`))
        .expect(200);
      expect(res.body).toMatchObject({
        id: ids.text,
        textContent: 'Many happy returns.',
      });
      noLeaks(res.body);
      // Owner still sees their note; no release row or grant carries it.
      const own = await lisa.get(api(`/messages/${ids.text}`)).expect(200);
      expect(own.body.privateNote).toBe('Rewrite this after Sarah graduates.');
      const rows = await prisma.messageRelease.findMany({
        where: { messageId: ids.text },
        include: { message: false },
      });
      const grants = await prisma.recipientMessageAccessGrant.findMany({
        where: { messageId: ids.text },
      });
      expect(JSON.stringify([rows, grants])).not.toMatch(/Sarah graduates/);
      for (const id of [
        ids.draft,
        ids.scheduled,
        ids.jennyMsg,
        crypto.randomUUID(),
      ]) {
        await sofia.get(api(`/recipient/messages/${id}`)).expect(404);
        await sofia.get(api(`/recipient/messages/${id}/media`)).expect(404);
      }
      await sofia.get(api('/recipient/messages/not-a-uuid')).expect(400);
    });

    it('a deleted message is no longer accessible', async () => {
      const id = await released(lisa, [ids.sofia]);
      await sofia.get(api(`/recipient/messages/${id}`)).expect(200);
      await prisma.message.update({
        where: { id },
        data: { deletedAt: new Date() },
      });
      await sofia.get(api(`/recipient/messages/${id}`)).expect(404);
    });

    it('same email across Customers sees both released messages, nothing else of theirs', async () => {
      const fromLisa = await released(lisa, [ids.lisaShared]);
      const fromJohn = await released(john, [ids.johnShared]);
      const shared = await recipientSignIn(SHARED);
      const res = await shared.get(api('/recipient/messages')).expect(200);
      expect((res.body as { id: string }[]).map((m) => m.id).sort()).toEqual(
        [fromLisa, fromJohn].sort(),
      );
      noLeaks(res.body);
    });

    it('recipient routes are read-only', async () => {
      const path = api(`/recipient/messages/${ids.text}`);
      await sofia.patch(path).send({ title: 'x' }).expect(404);
      await sofia.delete(path).expect(404);
      await sofia.post(`${path}/media/upload-url`).send({}).expect(404);
    });
  });

  describe('media', () => {
    let messageId: string;
    let photoId: string;
    let audioId: string;
    let hidden: string[];

    beforeAll(async () => {
      messageId = await addMessage(lisa, [ids.sofia], {
        contentType: 'MIXED',
        title: 'Photo and voice',
      });
      photoId = await attachMedia(messageId, 'PHOTO', 'image/jpeg');
      audioId = await attachMedia(messageId, 'AUDIO', 'audio/mpeg');
      await schedule(lisa, messageId);
      await release(messageId);
      // Not visible: pending, failed and deleted assets (inserted directly,
      // as the API refuses media changes after scheduling).
      const owner = await prisma.message.findUniqueOrThrow({
        where: { id: messageId },
        select: { ownerUserId: true },
      });
      hidden = [];
      for (const extra of [
        { status: 'PENDING_UPLOAD' as const },
        { status: 'FAILED' as const },
        { status: 'READY' as const, deletedAt: new Date() },
      ]) {
        const id = crypto.randomUUID();
        await prisma.mediaAsset.create({
          data: {
            id,
            ownerUserId: owner.ownerUserId,
            messageId,
            kind: 'PHOTO',
            storageKey: `test/${id}.jpg`,
            originalFileName: 'x.jpg',
            mimeType: 'image/jpeg',
            sizeBytes: 1000,
            ...extra,
          },
        });
        hidden.push(id);
      }
    });

    it('intended recipient: READY PHOTO and AUDIO listed and signed', async () => {
      const sofia = await recipientSignIn(SOFIA);
      const list = await sofia
        .get(api(`/recipient/messages/${messageId}/media`))
        .expect(200);
      expect((list.body as { id: string }[]).map((m) => m.id).sort()).toEqual(
        [photoId, audioId].sort(),
      );
      expect(Object.keys(list.body[0]).sort()).toEqual([
        'id',
        'kind',
        'mimeType',
        'originalFileName',
        'sizeBytes',
        'uploadedAt',
      ]);
      noLeaks(list.body);
      storage.createAccessUrl.mockClear();
      for (const id of [photoId, audioId]) {
        const res = await sofia
          .get(api(`/recipient/messages/${messageId}/media/${id}/access-url`))
          .expect(200);
        expect(res.body).toEqual({
          url: expect.stringMatching(/^https:\/\/media\.test\/signed/),
          expiresAt: expect.any(String),
        });
      }
      for (const id of hidden) {
        await sofia
          .get(api(`/recipient/messages/${messageId}/media/${id}/access-url`))
          .expect(404);
      }
      expect(storage.createAccessUrl).toHaveBeenCalledTimes(2);
      const detail = await sofia
        .get(api(`/recipient/messages/${messageId}`))
        .expect(200);
      expect(detail.body.hasMedia).toBe(true);
    });

    it('another recipient → 404 and nothing signed', async () => {
      const jenny = await recipientSignIn(JENNY);
      storage.createAccessUrl.mockClear();
      await jenny
        .get(api(`/recipient/messages/${messageId}/media`))
        .expect(404);
      await jenny
        .get(
          api(`/recipient/messages/${messageId}/media/${photoId}/access-url`),
        )
        .expect(404);
      expect(storage.createAccessUrl).not.toHaveBeenCalled();
    });
  });

  describe('VIDEO (Phase 12)', () => {
    let messageId: string;
    let videoId: string;
    const access = (agent: Agent) =>
      agent.get(
        api(`/recipient/messages/${messageId}/media/${videoId}/access-url`),
      );

    beforeAll(async () => {
      messageId = await addMessage(lisa, [ids.sofia], {
        contentType: 'VIDEO',
        textContent: null,
        title: 'A video for Sofia',
      });
      videoId = await attachMedia(messageId, 'VIDEO', 'video/mp4');
      await schedule(lisa, messageId);
    });

    it('unreleased (SCHEDULED): the intended recipient gets 404 and nothing is signed', async () => {
      const sofia = await recipientSignIn(SOFIA);
      storage.createAccessUrl.mockClear();
      await sofia.get(api(`/recipient/messages/${messageId}`)).expect(404);
      await sofia
        .get(api(`/recipient/messages/${messageId}/media`))
        .expect(404);
      await access(sofia).expect(404);
      expect(storage.createAccessUrl).not.toHaveBeenCalled();
    });

    it('released: the intended recipient lists the video and gets a short-lived signed URL', async () => {
      await release(messageId);
      const sofia = await recipientSignIn(SOFIA);
      const list = await sofia
        .get(api(`/recipient/messages/${messageId}/media`))
        .expect(200);
      expect(list.body).toEqual([
        expect.objectContaining({
          id: videoId,
          kind: 'VIDEO',
          mimeType: 'video/mp4',
        }),
      ]);
      noLeaks(list.body);
      const res = await access(sofia).expect(200);
      expect(res.body).toEqual({
        url: expect.stringMatching(/^https:\/\/media\.test\/signed/),
        expiresAt: expect.any(String),
      });
    });

    it('released, but another recipient → 404 and nothing signed', async () => {
      const jenny = await recipientSignIn(JENNY);
      storage.createAccessUrl.mockClear();
      await jenny
        .get(api(`/recipient/messages/${messageId}/media`))
        .expect(404);
      await access(jenny).expect(404);
      expect(storage.createAccessUrl).not.toHaveBeenCalled();
    });
  });

  describe('session separation and logout', () => {
    it('Customer session does not open Recipient routes, and vice versa', async () => {
      await lisa.get(api('/recipient/messages')).expect(401);
      await lisa.get(api('/recipient-auth/me')).expect(401);
      const sofia = await recipientSignIn(SOFIA);
      await sofia.get(api('/messages')).expect(401);
      await sofia.get(api('/auth/me')).expect(401);
      await sofia.get(api('/recipients')).expect(401);
      await request(app.getHttpServer())
        .get(api('/recipient/messages'))
        .expect(401);
    });

    it('logout → 204, cookie cleared, session gone', async () => {
      const sofia = await recipientSignIn(SOFIA);
      await sofia.get(api('/recipient/messages')).expect(200);
      const res = await sofia.post(api('/recipient-auth/logout')).expect(204);
      expect(String(res.headers['set-cookie'])).toMatch(
        new RegExp(`${RECIPIENT_SESSION_COOKIE}=;.*Expires=Thu, 01 Jan 1970`),
      );
      await sofia.get(api('/recipient/messages')).expect(401);
      // Without any session it is still a clean 204.
      await request(app.getHttpServer())
        .post(api('/recipient-auth/logout'))
        .expect(204);
    });
  });

  describe('sender display name (Phase 18: snapshotted at release)', () => {
    let sofia: Agent;
    const grantOf = (messageId: string) =>
      prisma.recipientMessageAccessGrant.findFirstOrThrow({
        where: { messageId, recipientId: ids.sofia },
      });
    beforeAll(async () => {
      sofia = await recipientSignIn(SOFIA);
    });

    it('list and detail say who it is from: the display name only', async () => {
      const list = await sofia.get(api('/recipient/messages')).expect(200);
      expect(list.body.find((m: { id: string }) => m.id === ids.text)).toMatchObject({
        senderDisplayName: 'Lisa Test',
      });
      const detail = await sofia.get(api(`/recipient/messages/${ids.text}`)).expect(200);
      expect(Object.keys(detail.body).sort()).toEqual([
        'contentType',
        'hasMedia',
        'id',
        'releasedAt',
        'senderDisplayName',
        'textContent',
        'title',
      ]);
      expect(detail.body.senderDisplayName).toBe('Lisa Test');
      const json = JSON.stringify([list.body, detail.body]);
      expect(json).not.toContain(customers[0]); // Lisa's email
      expect(json).not.toMatch(/ownerUserId|"owner"|"email"|"mobile"|"role"|"status"/);
    });

    it('no grant, no sender: other Recipients, drafts and scheduled messages stay 404', async () => {
      const jenny = await recipientSignIn(JENNY);
      for (const [agent, id] of [
        [jenny, ids.text],
        [sofia, ids.draft],
        [sofia, ids.scheduled],
      ] as const) {
        const res = await agent.get(api(`/recipient/messages/${id}`)).expect(404);
        expect(JSON.stringify(res.body)).not.toMatch(/Lisa|senderDisplayName/);
      }
    });

    it('a rename never rewrites a delivered message; later releases use the new name; retries change nothing', async () => {
      const before = await grantOf(ids.text);
      await lisa
        .patch(api('/users/me'))
        .send({ firstName: 'Elisabeth', lastName: 'Bridgett' })
        .expect(200);
      try {
        // Old delivery: still the name it was released with.
        expect(
          (await sofia.get(api(`/recipient/messages/${ids.text}`)).expect(200)).body.senderDisplayName,
        ).toBe('Lisa Test');
        // A retried release job is a no-op and leaves the snapshot alone.
        expect(
          await app.get(MessageReleaseService).release(ids.text, new Date(Date.now() + 3_700_000)),
        ).toEqual({ result: 'already_released' });
        expect(await grantOf(ids.text)).toEqual(before);
        // A new release: the name at that release.
        const fresh = await released(lisa, [ids.sofia], { title: 'After the rename' });
        expect(
          (await sofia.get(api(`/recipient/messages/${fresh}`)).expect(200)).body.senderDisplayName,
        ).toBe('Elisabeth Bridgett');
      } finally {
        await lisa.patch(api('/users/me')).send({ firstName: 'Lisa', lastName: 'Test' }).expect(200);
      }
    });

    it('a legacy grant without a snapshot shows no sender (never a guessed name)', async () => {
      const legacy = await released(lisa, [ids.sofia], { title: 'Legacy' });
      await prisma.recipientMessageAccessGrant.updateMany({
        where: { messageId: legacy },
        data: { senderDisplayNameSnapshot: null },
      });
      const res = await sofia.get(api(`/recipient/messages/${legacy}`)).expect(200);
      expect(res.body.senderDisplayName).toBeNull();
    });

    it('opening a message records nothing (no read receipts in the MVP)', async () => {
      const before = await grantOf(ids.text);
      await sofia.get(api(`/recipient/messages/${ids.text}`)).expect(200);
      await sofia.get(api('/recipient/messages')).expect(200);
      expect(await grantOf(ids.text)).toEqual(before);
      expect(Object.keys(before).join()).not.toMatch(/read|opened|viewed|seen/i);
    });
  });
});
