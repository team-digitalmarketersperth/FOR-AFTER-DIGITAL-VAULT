import { Logger } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import { Queue } from 'bullmq';
import session from 'express-session';
import request from 'supertest';
import { adminSignIn } from './admin-sign-in.js';
import { FAKE_MALWARE, FakeMalwareScanner } from './fake-malware-scanner.js';
import { FakeMediaStorage, fileStart } from './fake-media-storage.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { configureApp } from '../src/config/app.setup.js';
import { DeathNoticeDelivery } from '../src/death-verification/death-verification-notice.js';
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

// Phase 19A end to end: real HTTP, guards, PostgreSQL, Redis and the safeguard
// worker; the media provider and clamd are in-memory fakes (no ImageKit, no
// network). Evidence is supporting material only: these tests prove it never
// verifies a case or releases anything. Fictional people and synthetic files
// only; every test user (and so every case and evidence row) is deleted after.
describe('Death verification evidence (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let releaseQueue: Queue;
  let deathQueue: Queue;
  const run = Date.now();
  const at = (name: string) => `${name}.${run}@example.test`;
  const releaseQueueName = `test-ev-release-${run}`;
  const deathQueueName = `test-ev-${run}`;
  const password = 'StrongPassword123!';
  const users = {
    ella: at('ev.ella'), // the main case: David reports, Ben is a second contact
    fay: at('ev.fay'), // another Customer: David and Zed are her contacts
    gus: at('ev.gus'), // race: confirms alive while an upload is in flight
    admin: at('ev.admin'),
  };
  const DAVID = at('ev.david');
  const BEN = at('ev.ben');
  const ZED = at('ev.zed');
  const SOFIA = at('ev.sofia');
  const MAX_BYTES = 1024 * 1024;
  const ZERO = '00000000-0000-4000-8000-000000000000';

  const otps: OtpDeliveryInput[] = [];
  const otpDelivery = { sendOtp: vi.fn(async (i: OtpDeliveryInput) => void otps.push(i)) };
  const noticeDelivery = { sendAccountHolderSafetyNotice: vi.fn(async () => undefined) };
  const storage = new FakeMediaStorage();
  const scanner = new FakeMalwareScanner();

  type Agent = ReturnType<typeof request.agent>;
  const agents: Record<string, Agent> = {};
  const tc: Record<string, string> = {}; // TrustedContact (relationship) ids
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
  const caseOf = (email: string) =>
    prisma.deathVerificationCase.findFirstOrThrow({
      where: { owner: { email } },
      orderBy: [{ openedAt: 'desc' }, { id: 'desc' }],
    });
  const evidencePath = (tcId: string, rest = '') =>
    api(`/trusted-contact/accounts/${tcId}/death-verification/evidence${rest}`);

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
  const addContact = async (customer: string, firstName: string, email: string) =>
    (await agents[customer].post(api('/trusted-contacts')).send({ firstName, email }).expect(201)).body
      .id as string;
  const report = (agent: Agent, tcId: string) =>
    agent
      .post(api(`/trusted-contact/accounts/${tcId}/death-reports`))
      .send({ confirmReport: true, reportedDateOfDeath: '2026-09-01' })
      .expect(201);

  type FileSpec = { mimeType: string; bytes?: Uint8Array; contentType?: string; sizeBytes?: number };
  const requestUpload = (agent: Agent, tcId: string, f: FileSpec) =>
    agent.post(evidencePath(tcId, '/upload-url')).send({
      originalFileName: `synthetic.${f.mimeType.split('/')[1]}`,
      mimeType: f.mimeType,
      sizeBytes: f.sizeBytes ?? 1000,
    });
  /** upload-url → the browser's provider POST → complete; returns the complete response. */
  const uploadEvidence = async (agent: Agent, tcId: string, f: FileSpec) => {
    const target = (await requestUpload(agent, tcId, f).expect(201)).body;
    const fileId = storage.upload(target.upload, {
      sizeBytes: f.sizeBytes ?? 1000,
      contentType: f.contentType ?? f.mimeType,
      bytes: f.bytes,
    });
    const res = await agent
      .post(evidencePath(tcId, `/${target.mediaAssetId}/complete`))
      .send({ providerFileId: fileId });
    return { id: target.mediaAssetId as string, fileId, res };
  };

  // Everything evidence must never touch, for one Customer.
  const sideEffects = async (email: string) => {
    const owner = await prisma.user.findUniqueOrThrow({ where: { email } });
    const messages = { message: { ownerUserId: owner.id } };
    return {
      userStatus: owner.status,
      passedAt: owner.passedAt,
      messages: (
        await prisma.message.findMany({ where: { ownerUserId: owner.id }, select: { id: true, status: true } })
      ).sort((a, b) => a.id.localeCompare(b.id)),
      schedules: await prisma.messageSchedule.count({ where: messages }),
      releases: await prisma.messageRelease.count({ where: messages }),
      activations: await prisma.deathTriggeredMessageActivation.count({ where: messages }),
      grants: await prisma.recipientMessageAccessGrant.count({ where: messages }),
      notifications: await prisma.releaseNotification.count({ where: { grant: messages } }),
      caseVerified: (await caseOf(email)).verifiedAt,
    };
  };

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
      DEATH_EVIDENCE_MAX_BYTES: String(MAX_BYTES),
      DEATH_EVIDENCE_MAX_FILES: '5',
      // Every Customer here is "full": evidence must still be accepted.
      STORAGE_LIMIT_BYTES: '1',
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
    releaseQueue = new Queue(releaseQueueName, { connection: { url: process.env.REDIS_URL! } });
    deathQueue = new Queue(deathQueueName, { connection: { url: process.env.REDIS_URL! } });

    for (const [key, email] of Object.entries(users)) {
      await http()
        .post(api('/auth/register'))
        .send({ email, password, firstName: key, lastName: 'Test' })
        .expect(201);
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
    tc.ellaDavid = await addContact('ella', 'David', DAVID);
    tc.ellaBen = await addContact('ella', 'Ben', BEN);
    tc.fayDavid = await addContact('fay', 'David', DAVID);
    tc.fayZed = await addContact('fay', 'Zed', ZED);
    tc.gusDavid = await addContact('gus', 'David', DAVID);
    // A death-triggered message, so "no release" is a real claim.
    const recipientId = (
      await agents.ella.post(api('/recipients')).send({ firstName: 'Sofia', email: SOFIA }).expect(201)
    ).body.id;
    const messageId = (
      await agents.ella
        .post(api('/messages'))
        .send({ title: 'On death', textContent: 'Fictional.', recipientIds: [recipientId] })
        .expect(201)
    ).body.id;
    await agents.ella
      .post(api(`/messages/${messageId}/schedule`))
      .send({ triggerType: 'ON_DEATH' })
      .expect(201);
    agents.david = await otpSignIn(DAVID);
    agents.ben = await otpSignIn(BEN);
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

  describe('eligibility', () => {
    it('no case yet → 409; the status says no upload', async () => {
      expect(
        (await requestUpload(agents.david, tc.ellaDavid, { mimeType: 'application/pdf' }).expect(409)).body
          .message,
      ).toBe('Evidence can only be added while the case is open.');
      const s = (await agents.david.get(api(`/trusted-contact/accounts/${tc.ellaDavid}/death-verification`)).expect(200)).body;
      expect(s.canUploadEvidence).toBe(false);
    });

    it('after the report: the reporter may upload; a second contact without a report may not', async () => {
      await report(agents.david, tc.ellaDavid);
      const s = (await agents.david.get(api(`/trusted-contact/accounts/${tc.ellaDavid}/death-verification`)).expect(200)).body;
      expect(s.canUploadEvidence).toBe(true);
      const ben = (await agents.ben.get(api(`/trusted-contact/accounts/${tc.ellaBen}/death-verification`)).expect(200)).body;
      expect(ben.canUploadEvidence).toBe(false);
      expect(
        (await requestUpload(agents.ben, tc.ellaBen, { mimeType: 'application/pdf' }).expect(409)).body.message,
      ).toBe('Submit a death report for this account before adding evidence.');
      // Uploading nothing created no rows for Ben.
      expect(await prisma.deathVerificationEvidence.count({ where: { deathReport: { reportedByTrustedContactId: tc.ellaBen } } })).toBe(0);
    });
  });

  describe('upload pipeline', () => {
    let before: Awaited<ReturnType<typeof sideEffects>>;
    beforeAll(async () => {
      before = await sideEffects(users.ella);
    });

    it.each(['application/pdf', 'image/jpeg', 'image/png'])('%s → READY, nothing internal returned', async (mimeType) => {
      const { id, res } = await uploadEvidence(agents.david, tc.ellaDavid, { mimeType });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ id, mimeType, sizeBytes: 1000, status: 'READY', uploadedAt: expect.any(String) });
      const row = await prisma.deathVerificationEvidence.findUniqueOrThrow({ where: { id } });
      expect(row.storageKey).toMatch(new RegExp(`^/for-after/users/[^/]+/death-verification/${row.deathVerificationCaseId}/evidence/${id}\\.(pdf|jpg|png)$`));
      expect(row.storageKey).not.toContain('synthetic');
    });

    it('upload-url returns only the signed target: no key, provider id or URL to the file', async () => {
      const body = (await requestUpload(agents.david, tc.ellaDavid, { mimeType: 'application/pdf' }).expect(201)).body;
      expect(Object.keys(body).sort()).toEqual(['expiresAt', 'mediaAssetId', 'upload']);
      expect(JSON.stringify(body)).not.toMatch(/providerFileId|storageKey|media\.test/);
      // Leave it pending: abandoned uploads are cleanup's job.
      await prisma.deathVerificationEvidence.update({ where: { id: body.mediaAssetId }, data: { deletedAt: new Date() } });
    });

    it('a second complete is idempotent (no second audit event)', async () => {
      const { id, fileId } = await uploadEvidence(agents.david, tc.ellaDavid, { mimeType: 'application/pdf' });
      const again = await agents.david.post(evidencePath(tc.ellaDavid, `/${id}/complete`)).send({ providerFileId: fileId }).expect(200);
      expect(again.body.status).toBe('READY');
      const events = await prisma.deathVerificationAuditEvent.count({
        where: { eventType: 'EVIDENCE_UPLOADED', deathVerificationCase: { owner: { email: users.ella } } },
      });
      expect(events).toBe(4); // pdf, jpeg, png + this one, once each
    });

    it.each([
      ['unsupported type', { mimeType: 'image/webp' }],
      ['SVG', { mimeType: 'image/svg+xml' }],
      ['HTML', { mimeType: 'text/html' }],
      ['ZIP', { mimeType: 'application/zip' }],
      ['DOCX', { mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }],
      ['oversized', { mimeType: 'application/pdf', sizeBytes: MAX_BYTES + 1 }],
    ])('%s → 400 before anything is signed', async (_, f) => {
      const calls = storage.createUpload.mock.calls.length;
      await requestUpload(agents.david, tc.ellaDavid, f).expect(400);
      expect(storage.createUpload.mock.calls.length).toBe(calls);
    });

    it('MIME spoof: JPEG bytes declared as PDF → 400, FAILED, file removed', async () => {
      const { id, res } = await uploadEvidence(agents.david, tc.ellaDavid, {
        mimeType: 'application/pdf',
        bytes: fileStart('image/jpeg'),
      });
      expect(res.status).toBe(400);
      const row = await prisma.deathVerificationEvidence.findUniqueOrThrow({ where: { id } });
      expect(row.status).toBe('FAILED');
      expect([...storage.files.values()].some((f) => f.key === row.storageKey)).toBe(false);
    });

    it('provider reports a different type than declared → 400', async () => {
      const { res } = await uploadEvidence(agents.david, tc.ellaDavid, {
        mimeType: 'application/pdf',
        contentType: 'text/html',
      });
      expect(res.status).toBe(400);
    });

    it('PDF header after leading bytes → 400 (magic bytes must open the file)', async () => {
      const { res } = await uploadEvidence(agents.david, tc.ellaDavid, {
        mimeType: 'application/pdf',
        bytes: new Uint8Array([0x3c, 0x68, ...fileStart('application/pdf')]),
      });
      expect(res.status).toBe(400);
    });

    it('missing provider object or someone else’s file id → 409, still pending', async () => {
      const target = (await requestUpload(agents.david, tc.ellaDavid, { mimeType: 'application/pdf' }).expect(201)).body;
      await agents.david.post(evidencePath(tc.ellaDavid, `/${target.mediaAssetId}/complete`)).send({ providerFileId: 'nope' }).expect(409);
      const elsewhere = storage.upload({ url: '', fields: { folder: '/other/', fileName: 'x.pdf' } }, { sizeBytes: 1000, contentType: 'application/pdf' });
      await agents.david.post(evidencePath(tc.ellaDavid, `/${target.mediaAssetId}/complete`)).send({ providerFileId: elsewhere }).expect(409);
      await agents.david.post(evidencePath(tc.ellaDavid, `/${target.mediaAssetId}/complete`)).send({ providerFileId: '../x' }).expect(400);
      expect((await prisma.deathVerificationEvidence.findUniqueOrThrow({ where: { id: target.mediaAssetId } })).status).toBe('PENDING_UPLOAD');
      await prisma.deathVerificationEvidence.update({ where: { id: target.mediaAssetId }, data: { deletedAt: new Date() } });
    });

    it('malware → 400, FAILED, file removed, never viewable', async () => {
      const { id, res } = await uploadEvidence(agents.david, tc.ellaDavid, {
        mimeType: 'application/pdf',
        bytes: new Uint8Array([...fileStart('application/pdf'), ...Buffer.from(FAKE_MALWARE)]),
      });
      expect(res.status).toBe(400);
      expect(res.body.message).not.toMatch(/virus|malware|clam/i);
      expect((await prisma.deathVerificationEvidence.findUniqueOrThrow({ where: { id } })).status).toBe('FAILED');
      await agents.david.get(evidencePath(tc.ellaDavid, `/${id}/access-url`)).expect(409);
      const caseId = (await caseOf(users.ella)).id;
      await agents.admin.get(api(`/admin/death-verifications/${caseId}/evidence/${id}/access-url`)).expect(409);
    });

    it('at most 5 pending/ready files per reporter; FAILED ones do not count', async () => {
      // 4 READY so far; one more fits, then the limit.
      await uploadEvidence(agents.david, tc.ellaDavid, { mimeType: 'image/png' });
      expect((await requestUpload(agents.david, tc.ellaDavid, { mimeType: 'image/png' }).expect(409)).body.message).toBe(
        'You can add up to 5 files of evidence.',
      );
    });

    it('evidence changed nothing but evidence: no verification, status change or release', async () => {
      expect(await sideEffects(users.ella)).toEqual(before);
      expect((await caseOf(users.ella)).status).not.toBe('VERIFIED');
    });
  });

  describe('storage quota isolation', () => {
    it('a full Customer still gets evidence; it is not counted or listed as theirs', async () => {
      // STORAGE_LIMIT_BYTES=1: the Customer's own uploads are refused…
      const recipient = await prisma.recipient.findFirstOrThrow({ where: { email: SOFIA } });
      const draft = (
        await agents.ella.post(api('/messages')).send({ title: 'Draft', textContent: 'x', recipientIds: [recipient.id] }).expect(201)
      ).body.id;
      await agents.ella
        .post(api(`/messages/${draft}/media/upload-url`))
        .send({ kind: 'PHOTO', originalFileName: 'a.jpg', mimeType: 'image/jpeg', sizeBytes: 1000 })
        .expect((r) => expect(r.status).toBeGreaterThanOrEqual(400));
      // …while 5 READY evidence files exist for her case.
      const usage = (await agents.ella.get(api('/users/me/storage')).expect(200)).body;
      expect(usage.usedBytes).toBe(0);
      expect(usage.reservedBytes).toBe(0);
      const items = (await agents.ella.get(api('/users/me/storage/items')).expect(200)).body;
      expect(items.items).toEqual([]);
    });
  });

  describe('who can see what', () => {
    let readyId: string;
    let caseId: string;
    beforeAll(async () => {
      caseId = (await caseOf(users.ella)).id;
      readyId = (await prisma.deathVerificationEvidence.findFirstOrThrow({ where: { deathVerificationCaseId: caseId, status: 'READY' } })).id;
    });

    it('the reporter lists their READY files: metadata only, no name or internals', async () => {
      const list = (await agents.david.get(evidencePath(tc.ellaDavid)).expect(200)).body;
      expect(list).toHaveLength(5);
      for (const e of list) {
        expect(Object.keys(e).sort()).toEqual(['id', 'mimeType', 'sizeBytes', 'status', 'uploadedAt']);
        expect(e.status).toBe('READY');
      }
    });

    it('the reporter can re-view their own READY file through a short-lived URL', async () => {
      const before = Date.now();
      const res = (await agents.david.get(evidencePath(tc.ellaDavid, `/${readyId}/access-url`)).expect(200)).body;
      expect(res.url).toMatch(/^https:\/\/media\.test\/signed\?expires=300$/);
      expect(new Date(res.expiresAt).getTime() - before).toBeLessThanOrEqual(301_000);
    });

    it('a second Trusted Contact sees nothing of the reporter’s evidence', async () => {
      expect((await agents.ben.get(evidencePath(tc.ellaBen)).expect(200)).body).toEqual([]);
      await agents.ben.get(evidencePath(tc.ellaBen, `/${readyId}/access-url`)).expect(404);
      await agents.ben.post(evidencePath(tc.ellaBen, `/${readyId}/complete`)).send({ providerFileId: 'x' }).expect(404);
      // The status view still reveals no reports, counts or evidence.
      const s = (await agents.ben.get(api(`/trusted-contact/accounts/${tc.ellaBen}/death-verification`)).expect(200)).body;
      expect(Object.keys(s).sort()).toEqual(['canReport', 'canUploadEvidence', 'openedAt', 'reportedByYou', 'status']);
    });

    it('another Customer’s contact, or the same contact via another account, gets 404', async () => {
      await agents.zed.get(evidencePath(tc.ellaDavid)).expect(404);
      await agents.zed.get(evidencePath(tc.ellaDavid, `/${readyId}/access-url`)).expect(404);
      await requestUpload(agents.zed, tc.ellaDavid, { mimeType: 'application/pdf' }).expect(404);
      // David through Fay's relationship: Fay has no case, and Ella's file is not reachable.
      expect((await agents.david.get(evidencePath(tc.fayDavid)).expect(200)).body).toEqual([]);
      await agents.david.get(evidencePath(tc.fayDavid, `/${readyId}/access-url`)).expect(404);
      await requestUpload(agents.david, tc.fayDavid, { mimeType: 'application/pdf' }).expect(409);
    });

    it('Customer, Recipient and anonymous sessions are refused', async () => {
      const sid = await app.get(RecipientAuthService).createSession({ emailNormalized: SOFIA });
      const recipient = `${RECIPIENT_SESSION_COOKIE}=${sid}`;
      for (const path of [evidencePath(tc.ellaDavid), evidencePath(tc.ellaDavid, `/${readyId}/access-url`)]) {
        await agents.ella.get(path).expect(401);
        await http().get(path).set('Cookie', recipient).expect(401);
        await http().get(path).expect(401);
      }
      const adminPath = api(`/admin/death-verifications/${caseId}/evidence/${readyId}/access-url`);
      // A Customer cookie is never read on admin routes (separate admin session).
      await agents.ella.get(adminPath).expect(401);
      await agents.david.get(adminPath).expect(401);
      await http().get(adminPath).set('Cookie', recipient).expect(401);
      await http().get(adminPath).expect(401);
    });

    it('admin detail lists evidence metadata with clean names, never internals', async () => {
      const c = (await agents.admin.get(api(`/admin/death-verifications/${caseId}`)).expect(200)).body;
      const ready = c.evidence.filter((e: { status: string }) => e.status === 'READY');
      expect(ready).toHaveLength(5);
      expect(c.evidence.some((e: { status: string }) => e.status === 'FAILED')).toBe(true);
      for (const e of c.evidence) {
        expect(Object.keys(e).sort()).toEqual(
          ['createdAt', 'deathReportId', 'id', 'mimeType', 'originalFileName', 'sizeBytes', 'status', 'uploadedAt'],
        );
      }
      expect(JSON.stringify(c)).not.toMatch(/storageKey|providerFileId|for-after\/users|media\.test/);
    });

    it('admin view: short-lived URL, recorded on the timeline; the URL is never logged or audited', async () => {
      const logs = [vi.spyOn(Logger.prototype, 'log'), vi.spyOn(Logger.prototype, 'warn'), vi.spyOn(Logger.prototype, 'error')];
      const res = (await agents.admin.get(api(`/admin/death-verifications/${caseId}/evidence/${readyId}/access-url`)).expect(200)).body;
      expect(res.url).toContain('expires=300');
      const logged = logs.flatMap((s) => s.mock.calls.flat()).map(String).join('\n');
      logs.forEach((s) => s.mockRestore());
      expect(logged).not.toContain(res.url);
      expect(logged).not.toMatch(/media\.test|for-after\/users/);
      expect(
        await prisma.deathVerificationAuditEvent.count({ where: { deathVerificationCaseId: caseId, eventType: 'EVIDENCE_VIEWED_BY_ADMIN' } }),
      ).toBe(1);
      const audits = await prisma.auditLog.findMany({ where: { subjectId: caseId } });
      expect(JSON.stringify(audits)).not.toMatch(/media\.test|for-after\/users|signed/);
      // The evidence must belong to the case in the route.
      await agents.admin.get(api(`/admin/death-verifications/${ZERO}/evidence/${readyId}/access-url`)).expect(404);
      expect((await caseOf(users.ella)).status).not.toBe('VERIFIED');
    });
  });

  describe('race: the case closes while an upload is in flight', () => {
    it('confirm-alive between upload-url and complete → 409, discarded, file removed', async () => {
      await report(agents.david, tc.gusDavid);
      const target = (await requestUpload(agents.david, tc.gusDavid, { mimeType: 'application/pdf' }).expect(201)).body;
      const fileId = storage.upload(target.upload, { sizeBytes: 1000, contentType: 'application/pdf' });
      await agents.gus.post(api('/death-verification/me/confirm-alive')).send({ confirmAlive: true }).expect(200);
      await agents.david
        .post(evidencePath(tc.gusDavid, `/${target.mediaAssetId}/complete`))
        .send({ providerFileId: fileId })
        .expect(409);
      const row = await prisma.deathVerificationEvidence.findUniqueOrThrow({ where: { id: target.mediaAssetId } });
      expect(row.status).toBe('PENDING_UPLOAD');
      expect(row.deletedAt).not.toBeNull();
      expect((await caseOf(users.gus)).status).toBe('CANCELLED');
      expect(await prisma.deathVerificationAuditEvent.count({ where: { deathVerificationCaseId: row.deathVerificationCaseId, eventType: 'EVIDENCE_UPLOADED' } })).toBe(0);
      // The closed case accepts no new evidence either.
      await requestUpload(agents.david, tc.gusDavid, { mimeType: 'application/pdf' }).expect(409);
    });
  });

  describe('the existing admin verification is unchanged and stays the only path', () => {
    it('evidence never moved the case; admin verify works exactly as before, then evidence is closed', async () => {
      await until(async () => (await caseOf(users.ella)).status === 'READY_FOR_REVIEW');
      expect((await prisma.user.findUniqueOrThrow({ where: { email: users.ella } })).status).toBe('ACTIVE');
      const caseId = (await caseOf(users.ella)).id;
      const verify = () =>
        agents.admin.post(api(`/admin/death-verifications/${caseId}/verify`)).send({
          verifiedDeathAt: new Date(Date.now() - 86_400_000).toISOString(),
          confirmVerification: true,
          decisionNote: 'Fictional Phase 19A test.',
        });
      // Phase 19B: Ella has two contacts; five evidence files are not a second
      // confirmation. Ben's own report is.
      await verify().expect(409);
      await report(agents.ben, tc.ellaBen);
      await verify().expect(200);
      expect((await prisma.user.findUniqueOrThrow({ where: { email: users.ella } })).status).toBe('PASSED');
      await requestUpload(agents.david, tc.ellaDavid, { mimeType: 'application/pdf' }).expect(409);
      // Evidence stays attached and viewable to the admin after the decision.
      const readyId = (await prisma.deathVerificationEvidence.findFirstOrThrow({ where: { deathVerificationCaseId: caseId, status: 'READY' } })).id;
      await agents.admin.get(api(`/admin/death-verifications/${caseId}/evidence/${readyId}/access-url`)).expect(200);
    });
  });
});
