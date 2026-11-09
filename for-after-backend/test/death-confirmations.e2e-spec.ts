import { ConfigModule } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import { Queue } from 'bullmq';
import session from 'express-session';
import request from 'supertest';
import { adminSignIn } from './admin-sign-in.js';
import { FakeMalwareScanner } from './fake-malware-scanner.js';
import { FakeMediaStorage } from './fake-media-storage.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { configureApp } from '../src/config/app.setup.js';
import { DeathNoticeDelivery } from '../src/death-verification/death-verification-notice.js';
import {
  CONFIRMATION_REQUIRED,
  NO_CONFIRMATION_REQUIREMENT,
} from '../src/death-verification/death-verification.service.js';
import { DeathVerificationModule } from '../src/death-verification/death-verification.module.js';
import { MediaModule } from '../src/media/media.module.js';
import { MalwareScanner } from '../src/media/scanner/malware-scanner.service.js';
import { MediaStorage } from '../src/media/storage/media-storage.service.js';
import { MessageSchedulesModule } from '../src/message-schedules/message-schedules.module.js';
import { MessagesModule } from '../src/messages/messages.module.js';
import type { OtpDeliveryInput } from '../src/otp-auth/otp-auth.service.js';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { RecipientAuthModule } from '../src/recipient-auth/recipient-auth.module.js';
import {
  RECIPIENT_SESSION_COOKIE,
  RecipientAuthService,
} from '../src/recipient-auth/recipient-auth.service.js';
import { RecipientOtpDelivery } from '../src/recipient-auth/recipient-otp-delivery.js';
import { RecipientsModule } from '../src/recipients/recipients.module.js';
import { RedisModule } from '../src/redis/redis.module.js';
import { TrustedContactAuthModule } from '../src/trusted-contact-auth/trusted-contact-auth.module.js';
import { TrustedContactOtpDelivery } from '../src/trusted-contact-auth/trusted-contact-auth.service.js';
import { TrustedContactPortalModule } from '../src/trusted-contact-portal/trusted-contact-portal.module.js';
import { TrustedContactsModule } from '../src/trusted-contacts/trusted-contacts.module.js';
import { QueueWorkersModule } from '../src/worker.module.js';

// Phase 19B end to end: real HTTP, guards, PostgreSQL, Redis, the safeguard
// worker (2 s) and the release queue; notices, OTPs, storage and the scanner
// are fakes. A second Trusted Contact's report is a confirmation that only
// unlocks admin verify; it never verifies or releases anything. Fictional
// people only; every test user (and so every case) is deleted afterwards.
describe('Death verification confirmations (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let releaseQueue: Queue;
  let deathQueue: Queue;
  const run = Date.now();
  const at = (name: string) => `${name}.${run}@example.test`;
  const releaseQueueName = `test-cf-release-${run}`;
  const deathQueueName = `test-cf-${run}`;
  const password = 'StrongPassword123!';
  const customers = ['abe', 'bea', 'cal', 'dee', 'fay', 'gil', 'hal', 'ivy'] as const;
  type Customer = (typeof customers)[number];
  const users = { ...Object.fromEntries(customers.map((c) => [c, at(`cf.${c}`)])), admin: at('cf.admin') } as Record<
    Customer | 'admin',
    string
  >;
  const DAVID = at('cf.david');
  const SARAH = at('cf.sarah');
  const TOM = at('cf.tom');
  const ZED = at('cf.zed');
  const SOFIA = at('cf.sofia');

  const otps: OtpDeliveryInput[] = [];
  const otpDelivery = { sendOtp: vi.fn(async (i: OtpDeliveryInput) => void otps.push(i)) };
  const noticeDelivery = { sendAccountHolderSafetyNotice: vi.fn(async () => undefined) };
  const storage = new FakeMediaStorage();

  type Agent = ReturnType<typeof request.agent>;
  const agents: Record<string, Agent> = {};
  const tc: Record<string, string> = {}; // `${customer}:${name}` → TrustedContact id
  const api = (path: string) => `/api/v1${path}`;
  const http = () => request(app.getHttpServer());
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const until = async (check: () => Promise<boolean>, ms = 15_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await check()) return;
      await sleep(200);
    }
    throw new Error('condition not met in time');
  };
  const casesOf = (email: string) =>
    prisma.deathVerificationCase.findMany({
      where: { owner: { email } },
      orderBy: [{ openedAt: 'asc' }, { id: 'asc' }],
    });
  const caseOf = async (email: string) => (await casesOf(email)).at(-1)!;
  const ready = (email: string) => until(async () => (await caseOf(email)).status === 'READY_FOR_REVIEW');

  const otpSignIn = async (email: string) => {
    const { challengeId } = (
      await http().post(api('/trusted-contact-auth/request-otp')).send({ email }).expect(202)
    ).body;
    const agent = request.agent(app.getHttpServer());
    await agent
      .post(api('/trusted-contact-auth/verify-otp'))
      .send({ challengeId, code: otps.findLast((o) => o.email === email)!.code })
      .expect(200);
    return agent;
  };
  const addContact = async (customer: Customer, name: string, email: string) => {
    tc[`${customer}:${name}`] = (
      await agents[customer].post(api('/trusted-contacts')).send({ firstName: name, email }).expect(201)
    ).body.id;
    return tc[`${customer}:${name}`];
  };
  const report = (agent: Agent, tcId: string, body: object = {}) =>
    agent.post(api(`/trusted-contact/accounts/${tcId}/death-reports`)).send({ confirmReport: true, ...body });
  const verify = (caseId: string, body: object = {}) =>
    agents.admin.post(api(`/admin/death-verifications/${caseId}/verify`)).send({
      verifiedDeathAt: new Date(Date.now() - 86_400_000).toISOString(),
      confirmVerification: true,
      decisionNote: 'Fictional Phase 19B test.',
      ...body,
    });
  const detail = async (caseId: string) =>
    (await agents.admin.get(api(`/admin/death-verifications/${caseId}`)).expect(200)).body;
  const onDeathMessage = async (customer: Customer) => {
    const recipientId = (
      await agents[customer].post(api('/recipients')).send({ firstName: 'Sofia', email: SOFIA }).expect(201)
    ).body.id;
    const id = (
      await agents[customer]
        .post(api('/messages'))
        .send({ title: 'On death', textContent: 'Fictional.', recipientIds: [recipientId] })
        .expect(201)
    ).body.id as string;
    await agents[customer].post(api(`/messages/${id}/schedule`)).send({ triggerType: 'ON_DEATH' }).expect(201);
    return id;
  };
  // Everything a confirmation must never touch.
  const sideEffects = async (email: string) => {
    const owner = await prisma.user.findUniqueOrThrow({ where: { email } });
    const own = { message: { ownerUserId: owner.id } };
    return {
      userStatus: owner.status,
      verified: (await casesOf(email)).filter((c) => c.status === 'VERIFIED').length,
      activations: await prisma.deathTriggeredMessageActivation.count({ where: own }),
      releases: await prisma.messageRelease.count({ where: own }),
      grants: await prisma.recipientMessageAccessGrant.count({ where: own }),
      notifications: await prisma.releaseNotification.count({ where: { grant: own } }),
    };
  };
  const NOTHING = { userStatus: 'ACTIVE', verified: 0, activations: 0, releases: 0, grants: 0, notifications: 0 };

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
    });
    const moduleRef = await Test.createTestingModule({
      imports: [
        QueueWorkersModule,
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        RedisModule,
        AuthModule,
        RecipientsModule,
        TrustedContactsModule,
        MessagesModule,
        MessageSchedulesModule,
        MediaModule,
        RecipientAuthModule,
        TrustedContactAuthModule,
        TrustedContactPortalModule,
        DeathVerificationModule,
      ],
    })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .overrideProvider(MediaStorage)
      .useValue(storage)
      .overrideProvider(MalwareScanner)
      .useValue(new FakeMalwareScanner())
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
    releaseQueue = new Queue(releaseQueueName, { connection: { url: process.env.REDIS_URL! } });
    deathQueue = new Queue(deathQueueName, { connection: { url: process.env.REDIS_URL! } });

    for (const [key, email] of Object.entries(users)) {
      await http().post(api('/auth/register')).send({ email, password, firstName: key, lastName: 'Test' }).expect(201);
    }
    await prisma.user.update({ where: { email: users.admin }, data: { role: 'ADMIN' } });
    for (const [key, email] of Object.entries(users)) {
      if (key === 'admin') {
        agents.admin = (await adminSignIn(app, email, password)).agent;
      } else {
        agents[key] = request.agent(app.getHttpServer());
        await agents[key].post(api('/auth/login')).send({ email, password }).expect(200);
      }
    }
    // One contact: abe. Two distinct contacts: bea, cal, dee, fay, gil, hal.
    await addContact('abe', 'David', DAVID);
    for (const c of ['bea', 'cal', 'dee', 'fay', 'gil', 'hal'] as const) {
      await addContact(c, 'David', DAVID);
      await addContact(c, 'Sarah', SARAH);
    }
    await addContact('ivy', 'Zed', ZED);
    agents.david = await otpSignIn(DAVID);
    agents.sarah = await otpSignIn(SARAH);
    agents.zed = await otpSignIn(ZED);
  });

  afterAll(async () => {
    await prisma?.user.deleteMany({ where: { email: { in: Object.values(users) } } });
    await app?.close();
    for (const q of [releaseQueue, deathQueue]) {
      await q?.obliterate({ force: true });
      await q?.close();
    }
  });

  it('A: one contact → 1 required; after the safeguard the admin verifies as before', async () => {
    const messageId = await onDeathMessage('abe');
    await report(agents.david, tc['abe:David']).expect(201);
    const kase = await caseOf(users.abe);
    expect(kase.requiredConfirmations).toBe(1);
    await ready(users.abe);
    expect(await detail(kase.id)).toMatchObject({
      requiredConfirmations: 1,
      receivedConfirmations: 1,
      confirmationRequirementMet: true,
    });
    await verify(kase.id).expect(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { email: users.abe } })).status).toBe('PASSED');
    await until(async () => (await prisma.deathTriggeredMessageActivation.count({ where: { messageId } })) === 1);
  });

  describe('B: two contacts → 2 required', () => {
    let caseId: string;
    let messageId: string;

    it('the first report opens a case needing 2; the contact and the Customer see no counts', async () => {
      messageId = await onDeathMessage('bea');
      await report(agents.david, tc['bea:David']).expect(201);
      const kase = await caseOf(users.bea);
      caseId = kase.id;
      expect(kase.requiredConfirmations).toBe(2);
      for (const agent of [agents.david, agents.sarah]) {
        const id = agent === agents.david ? tc['bea:David'] : tc['bea:Sarah'];
        const s = (await agent.get(api(`/trusted-contact/accounts/${id}/death-verification`)).expect(200)).body;
        expect(Object.keys(s).sort()).toEqual(['canReport', 'canUploadEvidence', 'openedAt', 'reportedByYou', 'status']);
        expect(JSON.stringify(s)).not.toMatch(/confirm|David|Sarah|cf\.(david|sarah)/i);
      }
      const me = (await agents.bea.get(api('/death-verification/me')).expect(200)).body;
      expect(Object.keys(me).sort()).toEqual(['canConfirmAlive', 'safeguardEndsAt', 'status']);
    });

    it('ready for review with 1 of 2: verify refused (409), status unchanged, nothing released', async () => {
      await ready(users.bea);
      expect(await detail(caseId)).toMatchObject({
        status: 'READY_FOR_REVIEW',
        requiredConfirmations: 2,
        receivedConfirmations: 1,
        confirmationRequirementMet: false,
      });
      expect((await verify(caseId).expect(409)).body.message).toBe(CONFIRMATION_REQUIRED);
      // No override: an injected field is refused outright.
      await verify(caseId, { force: true }).expect(400);
      await verify(caseId, { requiredConfirmations: 1 }).expect(400);
      expect((await caseOf(users.bea)).status).toBe('READY_FOR_REVIEW');
      expect(await sideEffects(users.bea)).toEqual(NOTHING);
    });

    it('evidence is not a confirmation: 1 report + evidence is still 1 of 2', async () => {
      const target = (
        await agents.david
          .post(api(`/trusted-contact/accounts/${tc['bea:David']}/death-verification/evidence/upload-url`))
          .send({ originalFileName: 'synthetic.pdf', mimeType: 'application/pdf', sizeBytes: 1000 })
          .expect(201)
      ).body;
      const fileId = storage.upload(target.upload, { sizeBytes: 1000, contentType: 'application/pdf' });
      await agents.david
        .post(api(`/trusted-contact/accounts/${tc['bea:David']}/death-verification/evidence/${target.mediaAssetId}/complete`))
        .send({ providerFileId: fileId })
        .expect(200);
      expect((await detail(caseId)).receivedConfirmations).toBe(1);
      await verify(caseId).expect(409);
    });

    it('the second report satisfies the requirement and changes nothing else', async () => {
      await report(agents.sarah, tc['bea:Sarah']).expect(201);
      // A replay by the same contact is refused and counts nothing.
      await report(agents.sarah, tc['bea:Sarah']).expect(409);
      expect(await detail(caseId)).toMatchObject({
        status: 'READY_FOR_REVIEW',
        receivedConfirmations: 2,
        confirmationRequirementMet: true,
      });
      expect(await sideEffects(users.bea)).toEqual(NOTHING);
      // The evidence is untouched by the confirmation.
      expect(await prisma.deathVerificationEvidence.count({ where: { deathVerificationCaseId: caseId, status: 'READY' } })).toBe(1);
    });

    it('only the explicit admin verify then verifies, PASSES and activates as before', async () => {
      await verify(caseId).expect(200);
      expect((await prisma.user.findUniqueOrThrow({ where: { email: users.bea } })).status).toBe('PASSED');
      await until(async () => (await prisma.deathTriggeredMessageActivation.count({ where: { messageId } })) === 1);
      // Replayed verify: 409, still one activation.
      await verify(caseId).expect(409);
      expect(await prisma.deathTriggeredMessageActivation.count({ where: { messageId } })).toBe(1);
    });
  });

  it('safeguard still active with 2 of 2: verify refused by the existing rule', async () => {
    noticeDelivery.sendAccountHolderSafetyNotice.mockImplementationOnce(async () => {
      throw new Error('fake provider down'); // keeps the case PENDING_VERIFICATION
    });
    await report(agents.david, tc['gil:David']).expect(201);
    await report(agents.sarah, tc['gil:Sarah']).expect(201);
    const kase = await caseOf(users.gil);
    expect((await detail(kase.id)).confirmationRequirementMet).toBe(true);
    expect(kase.status).not.toBe('READY_FOR_REVIEW');
    await verify(kase.id).expect(409);
    expect(await sideEffects(users.gil)).toEqual(NOTHING);
  });

  it('C: confirm-alive cancels a 1-of-2 case; a stale second report never reopens it', async () => {
    await report(agents.david, tc['cal:David']).expect(201);
    const first = await caseOf(users.cal);
    await agents.cal.post(api('/death-verification/me/confirm-alive')).send({ confirmAlive: true }).expect(200);
    // Phase 10 rule: a report after a closed case opens a NEW case (with its own
    // safety notice); the cancelled one is immutable history.
    await report(agents.sarah, tc['cal:Sarah']).expect(201);
    const after = await casesOf(users.cal);
    expect(after).toHaveLength(2);
    expect(after[0]).toMatchObject({ id: first.id, status: 'CANCELLED', requiredConfirmations: 2 });
    expect(await prisma.deathReport.count({ where: { deathVerificationCaseId: first.id } })).toBe(1);
    expect(after[1]).toMatchObject({ reopenedFromCaseId: first.id, requiredConfirmations: 2 });
    expect(['PENDING_VERIFICATION', 'SAFEGUARD_ACTIVE', 'READY_FOR_REVIEW']).toContain(after[1].status);
    expect(await sideEffects(users.cal)).toEqual(NOTHING);
  });

  it('D: one person cannot confirm twice through two contact rows (snapshot stays 2)', async () => {
    await report(agents.david, tc['dee:David']).expect(201);
    const kase = await caseOf(users.dee);
    expect(kase.requiredConfirmations).toBe(2);
    // The Customer changes the second row to David's address (different case).
    await agents.dee.patch(api(`/trusted-contacts/${tc['dee:Sarah']}`)).send({ email: DAVID.toUpperCase() }).expect(200);
    expect((await caseOf(users.dee)).requiredConfirmations).toBe(2);
    // David now reaches the account through both rows and files a second report.
    await report(agents.david, tc['dee:Sarah']).expect(201);
    await ready(users.dee);
    expect(await detail(kase.id)).toMatchObject({ receivedConfirmations: 1, confirmationRequirementMet: false });
    expect((await verify(kase.id).expect(409)).body.message).toBe(CONFIRMATION_REQUIRED);
  });

  it('snapshot: removing a contact keeps 2; a later-added distinct contact may confirm', async () => {
    await report(agents.david, tc['fay:David']).expect(201);
    const kase = await caseOf(users.fay);
    await agents.fay.delete(api(`/trusted-contacts/${tc['fay:Sarah']}`)).expect(204);
    expect((await caseOf(users.fay)).requiredConfirmations).toBe(2);
    await report(agents.sarah, tc['fay:Sarah']).expect(404); // removed: no longer reachable
    await addContact('fay', 'Tom', TOM);
    expect((await caseOf(users.fay)).requiredConfirmations).toBe(2);
    const tom = await otpSignIn(TOM);
    await report(tom, tc['fay:Tom']).expect(201);
    expect(await detail(kase.id)).toMatchObject({ receivedConfirmations: 2, confirmationRequirementMet: true });
    expect(await sideEffects(users.fay)).toEqual(NOTHING);
  });

  it('a contact added after a 1-contact case opened does not raise the requirement', async () => {
    // ivy: Zed only → 1; Sarah added afterwards.
    await report(agents.zed, tc['ivy:Zed']).expect(201);
    await addContact('ivy', 'Sarah', SARAH);
    expect((await caseOf(users.ivy)).requiredConfirmations).toBe(1);
  });

  it('reject still works with 1 of 2; the rejected case takes no further confirmation', async () => {
    await report(agents.david, tc['hal:David']).expect(201);
    const kase = await caseOf(users.hal);
    await ready(users.hal);
    await agents.admin
      .post(api(`/admin/death-verifications/${kase.id}/reject`))
      .send({ confirmRejection: true, decisionNote: 'Fictional.' })
      .expect(200);
    await report(agents.sarah, tc['hal:Sarah']).expect(201); // opens a NEW case (Phase 10)
    expect(await prisma.deathReport.count({ where: { deathVerificationCaseId: kase.id } })).toBe(1);
    expect((await prisma.deathVerificationCase.findUniqueOrThrow({ where: { id: kase.id } })).status).toBe('REJECTED');
  });

  describe('concurrency', () => {
    it('two contacts reporting at once: one case, two reports, sized 2; one contact twice: one report', async () => {
      // A fresh Customer with two contacts.
      const email = at('cf.jo');
      await http().post(api('/auth/register')).send({ email, password, firstName: 'jo', lastName: 'Test' }).expect(201);
      users['jo' as Customer] = email;
      const jo = request.agent(app.getHttpServer());
      await jo.post(api('/auth/login')).send({ email, password }).expect(200);
      agents.jo = jo;
      const d = (await jo.post(api('/trusted-contacts')).send({ firstName: 'David', email: DAVID }).expect(201)).body.id;
      const s = (await jo.post(api('/trusted-contacts')).send({ firstName: 'Sarah', email: SARAH }).expect(201)).body.id;
      const [a, b, c] = await Promise.all([report(agents.david, d), report(agents.sarah, s), report(agents.david, d)]);
      expect([a.status, b.status, c.status].sort((x, y) => x - y)).toEqual([201, 201, 409]);
      const cases = await casesOf(email);
      expect(cases).toHaveLength(1);
      expect(cases[0].requiredConfirmations).toBe(2);
      expect(await prisma.deathReport.count({ where: { deathVerificationCaseId: cases[0].id } })).toBe(2);
    });

    it('verify racing the second report never verifies on a stale count', async () => {
      const email = at('cf.kai');
      await http().post(api('/auth/register')).send({ email, password, firstName: 'kai', lastName: 'Test' }).expect(201);
      users['kai' as Customer] = email;
      const kai = request.agent(app.getHttpServer());
      await kai.post(api('/auth/login')).send({ email, password }).expect(200);
      const d = (await kai.post(api('/trusted-contacts')).send({ firstName: 'David', email: DAVID }).expect(201)).body.id;
      const s = (await kai.post(api('/trusted-contacts')).send({ firstName: 'Sarah', email: SARAH }).expect(201)).body.id;
      await report(agents.david, d).expect(201);
      await ready(email);
      const kase = await caseOf(email);
      const [v, r] = await Promise.all([verify(kase.id), report(agents.sarah, s)]);
      expect(r.status).toBe(201);
      const final = await prisma.deathVerificationCase.findUniqueOrThrow({ where: { id: kase.id } });
      // Both lock the case row: verify sees either the committed second report
      // (and may verify) or none (409). Never a verify on one confirmation.
      const reporters = await prisma.deathReport.findMany({ where: { deathVerificationCaseId: kase.id } });
      expect(new Set(reporters.map((x) => x.reporterEmailNormalized)).size).toBe(2);
      if (v.status === 200) {
        expect(final.status).toBe('VERIFIED');
      } else {
        expect(v.status).toBe(409);
        expect(final.status).toBe('READY_FOR_REVIEW');
      }
    });
  });

  describe('legacy cases (opened before Phase 19B)', () => {
    it('an open case without a recorded requirement is never verified (no default to 1)', async () => {
      const owner = await prisma.user.findUniqueOrThrow({ where: { email: users.ivy } });
      const past = new Date(Date.now() - 86_400_000);
      // ivy's live case is closed first (only one open case per Customer).
      await agents.ivy.post(api('/death-verification/me/confirm-alive')).send({ confirmAlive: true }).expect(200);
      const legacy = await prisma.deathVerificationCase.create({
        data: { ownerUserId: owner.id, status: 'READY_FOR_REVIEW', safetyNoticeSentAt: past, safeguardStartedAt: past, safeguardEndsAt: past },
      });
      expect(await detail(legacy.id)).toMatchObject({ requiredConfirmations: null, confirmationRequirementMet: false });
      expect((await verify(legacy.id).expect(409)).body.message).toBe(NO_CONFIRMATION_REQUIREMENT);
      expect((await prisma.user.findUniqueOrThrow({ where: { email: users.ivy } })).status).toBe('ACTIVE');
      // A closed legacy case stays readable.
      const closed = (await casesOf(users.ivy)).find((c) => c.status === 'CANCELLED')!;
      await prisma.deathVerificationCase.update({ where: { id: closed.id }, data: { requiredConfirmations: null } });
      expect((await detail(closed.id)).requiredConfirmations).toBeNull();
    });

    it('the database refuses 0 or 3', async () => {
      const kase = await caseOf(users.ivy);
      for (const value of [0, 3, -1]) {
        await expect(
          prisma.deathVerificationCase.update({ where: { id: kase.id }, data: { requiredConfirmations: value } }),
        ).rejects.toThrow();
      }
    });
  });

  describe('authorization', () => {
    it('a report cannot carry requiredConfirmations or other injected fields', async () => {
      const email = at('cf.lu');
      await http().post(api('/auth/register')).send({ email, password, firstName: 'lu', lastName: 'Test' }).expect(201);
      users['lu' as Customer] = email;
      const lu = request.agent(app.getHttpServer());
      await lu.post(api('/auth/login')).send({ email, password }).expect(200);
      const d = (await lu.post(api('/trusted-contacts')).send({ firstName: 'David', email: DAVID }).expect(201)).body.id;
      for (const extra of [{ requiredConfirmations: 1 }, { receivedConfirmations: 2 }, { caseId: '00000000-0000-4000-8000-000000000000' }]) {
        await report(agents.david, d, extra).expect(400);
      }
      expect(await casesOf(email)).toHaveLength(0);
      // Only a Trusted Contact session reports, and only for its own relationship.
      await report(agents.zed, d).expect(404);
      await report(lu, d).expect(401);
      await report(agents.admin, d).expect(401);
      const sid = await app.get(RecipientAuthService).createSession({ emailNormalized: SOFIA });
      await http()
        .post(api(`/trusted-contact/accounts/${d}/death-reports`))
        .set('Cookie', `${RECIPIENT_SESSION_COOKIE}=${sid}`)
        .send({ confirmReport: true })
        .expect(401);
      await http().post(api(`/trusted-contact/accounts/${d}/death-reports`)).send({ confirmReport: true }).expect(401);
      expect(await casesOf(email)).toHaveLength(0);
    });
  });
});
