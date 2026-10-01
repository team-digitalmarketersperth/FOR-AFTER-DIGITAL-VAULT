import { ConfigModule } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';
import session from 'express-session';
import request from 'supertest';
import { AuthModule } from '../src/auth/auth.module.js';
import { configureApp, SESSION_COOKIE } from '../src/config/app.setup.js';
import { MediaModule } from '../src/media/media.module.js';
import { MediaStorage } from '../src/media/storage/media-storage.service.js';
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
} from '../src/recipient-auth/recipient-auth.service.js';
import {
  RecipientOtpDelivery,
  type OtpDeliveryInput,
} from '../src/recipient-auth/recipient-otp-delivery.js';
import { RecipientPortalModule } from '../src/recipient-portal/recipient-portal.module.js';
import { RecipientsModule } from '../src/recipients/recipients.module.js';
import { RedisModule } from '../src/redis/redis.module.js';

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
  let stored = { sizeBytes: 1000, contentType: 'image/jpeg' };
  const storage = {
    createUploadUrl: vi.fn(async () => 'https://storage.test/signed-put'),
    createAccessUrl: vi.fn(async () => 'https://storage.test/signed-get'),
    headObject: vi.fn(async () => stored),
    deleteObject: vi.fn(async () => undefined),
  };

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
  const attachMedia = async (
    messageId: string,
    kind: 'PHOTO' | 'AUDIO',
    mimeType: string,
  ) => {
    stored = { sizeBytes: 1000, contentType: mimeType };
    const { mediaAssetId } = (
      await lisa
        .post(api(`/messages/${messageId}/media/upload-url`))
        .send({
          kind,
          originalFileName: `a.${kind}`,
          mimeType,
          sizeBytes: 1000,
        })
        .expect(201)
    ).body as { mediaAssetId: string };
    await lisa
      .post(api(`/messages/${messageId}/media/${mediaAssetId}/complete`))
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
      /ownerUserId|owner|schedule|scheduledFor|afterDeathDays|storageKey|deletedAt|recipientId|recipients|grant|privateNote|birthday|relationship|jobId|portal\.lisa|portal\.john|"status"/i,
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
      ],
    })
      .overrideProvider(MediaStorage)
      .useValue(storage)
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
      mobile: '+61 400 000 000',
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

    ids.text = await released(lisa, [ids.sofia, ids.max]);
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
        recipientMobileNormalized: '+61 400 000 000',
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
      });
      noLeaks(res.body);
    });

    it('detail returns released text; draft, scheduled, other recipient, guessed → 404', async () => {
      const res = await sofia
        .get(api(`/recipient/messages/${ids.text}`))
        .expect(200);
      expect(res.body).toMatchObject({
        id: ids.text,
        textContent: 'Fictional released text.',
      });
      noLeaks(res.body);
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
          url: 'https://storage.test/signed-get',
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
});
