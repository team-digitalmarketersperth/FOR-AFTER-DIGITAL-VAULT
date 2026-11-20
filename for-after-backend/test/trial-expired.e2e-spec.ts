import { ConfigModule } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import argon2 from 'argon2';
import session from 'express-session';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AuthModule } from '../src/auth/auth.module.js';
import { TRIAL_DAYS } from '../src/billing/billing-access.js';
import { BILLING_REQUIRED } from '../src/billing/billing-access.interceptor.js';
import { BillingModule } from '../src/billing/billing.module.js';
import { CommunicationsModule } from '../src/communications/communications.module.js';
import { configureApp } from '../src/config/app.setup.js';
import { DraftRecoveryModule } from '../src/draft-recovery/draft-recovery.module.js';
import { EmailProvider } from '../src/email/email-provider.js';
import { MediaModule } from '../src/media/media.module.js';
import { MalwareScanner } from '../src/media/scanner/malware-scanner.service.js';
import { MediaStorage } from '../src/media/storage/media-storage.service.js';
import { MemoryVaultModule } from '../src/memory-vault/memory-vault.module.js';
import { MessageSchedulesModule } from '../src/message-schedules/message-schedules.module.js';
import { MessagesModule } from '../src/messages/messages.module.js';
import { MyStoryModule } from '../src/my-story/my-story.module.js';
import { MyWishesModule } from '../src/my-wishes/my-wishes.module.js';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { RecipientsModule } from '../src/recipients/recipients.module.js';
import { RedisModule } from '../src/redis/redis.module.js';
import { SmsSender } from '../src/sms/sms-sender.js';
import { SmsVerification } from '../src/sms/sms-verification.js';
import { SupportModule } from '../src/support/support.module.js';
import { TrustedContactsModule } from '../src/trusted-contacts/trusted-contacts.module.js';
import { UsersModule } from '../src/users/users.module.js';
import { FakeEmailProvider } from './fake-email.js';
import { FakeMalwareScanner } from './fake-malware-scanner.js';
import { FakeMediaStorage } from './fake-media-storage.js';

// Trial restrictions Step 6: after an enforced trial ends (no paid entitlement), creating and editing content is refused
// with 402 and a reason code; reading, existing downloads and deleting stay open. Controlled clock: only `Date` is faked,
// pinned around a fixed trial end (END), so the boundary never depends on the machine clock. Real PostgreSQL; fake
// ImageKit, scanner, email and SMS; Stripe unconfigured (never called).
describe('Expired trial: read-only access (e2e, PostgreSQL)', () => {
  const DAY = 86_400_000;
  const END = new Date('2030-01-01T00:00:00.000Z');
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const run = Date.now();
  // Five accounts: sign-in is limited to five per minute per IP.
  const names = ['exp', 'paid', 'old', 'nos', 'eve'] as const;
  type Name = (typeof names)[number];
  const emails = Object.fromEntries(names.map((n) => [n, `trialexpired.${n}.${run}@example.test`])) as Record<Name, string>;
  const password = 'StrongPassword123!';
  const storage = new FakeMediaStorage();
  type Agent = ReturnType<typeof request.agent>;
  const agents = {} as Record<Name, Agent>;
  const ids = {} as Record<Name, string>;
  const api = (p: string) => `/api/v1${p}`;
  const STORY = 'childhood.earliest-memory';
  const WISH = 'ceremony.style';
  const ENV = {
    BILLING_ENABLED: 'true',
    BILLING_ENFORCE_FROM: new Date(run - 60_000).toISOString(),
    STRIPE_SECRET_KEY: '',
    STRIPE_WEBHOOK_SECRET: '',
    THROTTLE_KEY_PREFIX: `for_after:test_trial_expired_throttle:${run}:`,
  };
  const at = (ms: number) => vi.setSystemTime(new Date(END.getTime() + ms));
  // Content created during the trial, per account.
  const made = {} as Record<Name, { recipient: string; contact: string; message: string; memory: string; song: string; media: string }>;
  const expectRefused = (res: request.Response, code = 'TRIAL_EXPIRED', label = '') => {
    expect([label, res.status]).toEqual([label, 402]);
    expect(res.body).toEqual({ statusCode: 402, error: 'Payment Required', code, message: BILLING_REQUIRED });
  };

  beforeAll(async () => {
    Object.assign(process.env, ENV);
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }), PrismaModule, RedisModule, AuthModule, BillingModule, UsersModule,
        CommunicationsModule, SupportModule, RecipientsModule, TrustedContactsModule, MessagesModule, MessageSchedulesModule,
        MediaModule, MemoryVaultModule, MyStoryModule, MyWishesModule, DraftRecoveryModule,
      ],
    })
      .overrideProvider(MediaStorage)
      .useValue(storage)
      .overrideProvider(MalwareScanner)
      .useValue(new FakeMalwareScanner())
      .overrideProvider(EmailProvider)
      .useValue(new FakeEmailProvider())
      .overrideProvider(SmsSender)
      .useValue({ name: 'fake', send: () => Promise.resolve() })
      .overrideProvider(SmsVerification)
      .useValue({ name: 'fake', send: vi.fn(), check: vi.fn() })
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app, new session.MemoryStore());
    await app.init();
    prisma = app.get(PrismaService);
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    for (const n of names) {
      ids[n] = (await prisma.user.create({ data: { email: emails[n], passwordHash, firstName: n, lastName: 'Test', role: 'CUSTOMER', emailVerifiedAt: new Date() }, select: { id: true } })).id;
    }
    await prisma.user.update({ where: { id: ids.old }, data: { createdAt: new Date(run - DAY) } });
    // Every account but "nos" (never started) has a trial ending exactly at END.
    for (const n of ['exp', 'paid', 'old', 'eve'] as const) {
      await prisma.customerTrial.create({ data: { userId: ids[n], startedAt: new Date(END.getTime() - TRIAL_DAYS * DAY), endsAt: END } });
    }
    await prisma.billingAccount.create({
      data: { userId: ids.paid, stripeCustomerId: `cus_fictional_expired_${run}`, livemode: false, plan: 'monthly', subscriptionStatus: 'active', cancelAtPeriodEnd: false, currentPeriodEnd: new Date(END.getTime() + 30 * DAY) },
    });
    // The controlled clock: an hour before the trial ends. Sessions are created on it.
    vi.useFakeTimers({ toFake: ['Date'] });
    at(-3_600_000);
    for (const n of names) {
      const agent = request.agent(app.getHttpServer());
      await agent.post(api('/auth/login')).send({ email: emails[n], password }).expect(200);
      agents[n] = agent;
    }
    // Content made during the trial (text only: Step 4), through the API.
    for (const n of ['exp', 'eve', 'paid', 'old'] as const) {
      const a = agents[n];
      const recipient = (await a.post(api('/recipients')).send({ firstName: 'Sofia' }).expect(201)).body.id;
      const contact = (await a.post(api('/trusted-contacts')).send({ firstName: 'Tom', email: `tc.${n}.${run}@example.test` }).expect(201)).body.id;
      const message = (await a.post(api('/messages')).send({ title: 'For Sofia', textContent: 'Written words.', recipientIds: [recipient] }).expect(201)).body.id;
      const memory = (await a.post(api('/memory-vault')).send({ title: 'Beach days', category: 'OTHER', textContent: 'A memory.' }).expect(201)).body.id;
      await a.put(api(`/my-story/prompts/${STORY}/response`)).send({ textContent: 'A house by the sea.', privateNote: 'Mine.' }).expect(200);
      await a.put(api(`/my-wishes/prompts/${WISH}/response`)).send({ textContent: 'Something small.' }).expect(200);
      const song = (await a.post(api('/my-wishes/songs')).send({ title: 'Fictional song' }).expect(201)).body.id;
      // A READY file from before (paid era), seeded directly: the storage is fake.
      const media = (
        await prisma.mediaAsset.create({
          data: { ownerUserId: ids[n], messageId: message, kind: 'PHOTO', status: 'READY', storageKey: `test/trial-expired/${run}/${randomUUID()}.jpg`, providerFileId: `fake_${randomUUID()}`, originalFileName: 'synthetic.jpg', mimeType: 'image/jpeg', sizeBytes: 1000, uploadedAt: new Date() },
          select: { id: true },
        })
      ).id;
      made[n] = { recipient, contact, message, memory, song, media };
    }
  });

  afterAll(async () => {
    vi.useRealTimers();
    for (const k of Object.keys(ENV)) delete process.env[k];
    await prisma?.user.deleteMany({ where: { email: { in: Object.values(emails) } } });
    await app?.close();
  });

  it('boundary: 1 ms before END a write succeeds; exactly at END and 1 ms after it is refused (same session, form opened before)', async () => {
    at(-1);
    await agents.exp.patch(api(`/messages/${made.exp.message}`)).send({ title: 'Edited in time' }).expect(200);
    expect((await agents.exp.get(api('/billing')).expect(200)).body.state).toBe('trial_active');
    at(0);
    expectRefused(await agents.exp.patch(api(`/messages/${made.exp.message}`)).send({ title: 'Too late' }));
    expect((await agents.exp.get(api('/billing')).expect(200)).body).toMatchObject({ state: 'trial_expired', hasAccess: false, trialEligible: false });
    at(1);
    expectRefused(await agents.exp.put(api(`/my-story/prompts/${STORY}/response`)).send({ textContent: 'Typed before, sent after.' }));
    const kept = (await agents.exp.get(api(`/my-story/prompts/${STORY}/response`)).expect(200)).body;
    expect(kept.textContent).toBe('A house by the sea.');
    expect((await agents.exp.get(api(`/messages/${made.exp.message}`)).expect(200)).body.title).toBe('Edited in time');
  });

  it('expired: creating and editing are refused in every content module, before validation, and nothing changes', async () => {
    at(60_000);
    const a = agents.exp;
    const m = made.exp;
    const before = await prisma.message.count({ where: { ownerUserId: ids.exp } });
    const writes: [string, string, object][] = [
      ['post', '/messages', { title: 'New', textContent: 'x', recipientIds: [m.recipient] }],
      ['patch', `/messages/${m.message}`, { title: 'Changed' }],
      ['post', `/messages/${m.message}/versions/${randomUUID()}/restore`, {}],
      ['post', `/messages/${m.message}/media/upload-url`, { kind: 'PHOTO', mimeType: 'image/jpeg', sizeBytes: 1000, originalFileName: 'x.jpg' }],
      ['post', `/messages/${m.message}/schedule`, { type: 'ON_DEATH' }],
      ['patch', `/messages/${m.message}/schedule`, { type: 'ON_DEATH' }],
      ['post', '/recipients', { firstName: 'New' }],
      ['patch', `/recipients/${m.recipient}`, { firstName: 'Changed' }],
      ['post', `/recipients/${m.recipient}/photo/upload-url`, { kind: 'PHOTO', mimeType: 'image/jpeg', sizeBytes: 1000, originalFileName: 'x.jpg' }],
      ['post', '/trusted-contacts', { firstName: 'New', email: `new.${run}@example.test` }],
      ['patch', `/trusted-contacts/${m.contact}`, { firstName: 'Changed' }],
      ['post', `/trusted-contacts/${m.contact}/invitation`, { channel: 'EMAIL' }],
      ['put', `/my-story/prompts/${STORY}/response`, { privateNote: 'Only the note.' }],
      ['put', `/my-story/prompts/childhood.home/response`, { textContent: 'A new answer.' }],
      ['post', `/my-story/prompts/${STORY}/response/messages`, { includeText: true }],
      ['put', `/my-wishes/prompts/${WISH}/response`, { textContent: 'Changed.' }],
      ['post', `/my-wishes/prompts/${WISH}/response/messages`, { includeText: true }],
      ['post', '/my-wishes/songs', { title: 'New song' }],
      ['patch', `/my-wishes/songs/${m.song}`, { title: 'Changed' }],
      ['put', '/my-wishes/songs/order', { songIds: [m.song] }],
      ['post', '/memory-vault', { title: 'New', category: 'OTHER' }],
      ['patch', `/memory-vault/${m.memory}`, { title: 'Changed' }],
      ['post', `/memory-vault/${m.memory}/messages`, { includeText: true }],
      ['post', `/memory-vault/${m.memory}/media/upload-url`, { kind: 'PHOTO', mimeType: 'image/jpeg', sizeBytes: 1000, originalFileName: 'x.jpg' }],
      ['post', '/users/me/drafts/NEW_MESSAGE', { payload: { title: 'x' } }],
      ['put', `/users/me/drafts/MY_STORY/${STORY}`, { payload: { textContent: 'x' }, baseRevision: 'x' }],
    ];
    for (const [method, path, body] of writes) expectRefused(await (a[method as 'post'] as (u: string) => request.Test)(api(path)).send(body), 'TRIAL_EXPIRED', `${method} ${path}`);
    // Nothing was created or changed.
    expect(await prisma.message.count({ where: { ownerUserId: ids.exp } })).toBe(before);
    expect(await prisma.recipient.count({ where: { ownerUserId: ids.exp, deletedAt: null } })).toBe(1);
    expect(await prisma.trustedContact.count({ where: { ownerUserId: ids.exp, deletedAt: null } })).toBe(1);
    expect(await prisma.memoryVaultItem.count({ where: { ownerUserId: ids.exp, deletedAt: null } })).toBe(1);
    expect(await prisma.myStoryResponse.count({ where: { ownerUserId: ids.exp, deletedAt: null } })).toBe(1);
    expect((await prisma.myWishSong.findUniqueOrThrow({ where: { id: m.song } })).title).toBe('Fictional song');
    expect(await prisma.messageSchedule.count({ where: { messageId: m.message } })).toBe(0);
    // No new trial: "Start free trial" is idempotent and returns the same ended trial, never a restart or extension.
    expect((await a.post(api('/billing/trial')).send({}).expect(200)).body).toMatchObject({ state: 'trial_expired', hasAccess: false });
    expect(await prisma.customerTrial.count({ where: { userId: ids.exp } })).toBe(1);
    expect((await prisma.customerTrial.findUniqueOrThrow({ where: { userId: ids.exp } })).endsAt.toISOString()).toBe(END.toISOString());
  });

  it('expired: lists, details, existing downloads (signed access URLs) and reads stay open', async () => {
    at(120_000);
    const a = agents.exp;
    const m = made.exp;
    for (const path of ['/messages', `/messages/${m.message}`, '/recipients', `/recipients/${m.recipient}`, '/trusted-contacts', '/memory-vault', `/memory-vault/${m.memory}`, '/my-story/prompts', '/my-story/book', `/my-story/prompts/${STORY}/response`, '/my-wishes/prompts', `/my-wishes/prompts/${WISH}/response`, '/my-wishes/songs', `/messages/${m.message}/media`, '/users/me/storage', '/billing']) {
      expect([path, (await a.get(api(path))).status]).toEqual([path, 200]);
    }
    const access = (await a.get(api(`/messages/${m.message}/media/${m.media}/access-url`)).expect(200)).body;
    expect(access.url).toEqual(expect.any(String));
  });

  it('expired: account, security, preferences, support and sign-out stay open', async () => {
    at(150_000);
    await agents.exp.patch(api('/users/me')).send({ firstName: 'Renamed' }).expect(200);
    await agents.exp.get(api('/users/me/communication-preferences')).expect(200);
    const support = await agents.exp.post(api('/support/requests')).send({ clientRequestId: randomUUID(), subject: 'Plan question', category: 'ACCOUNT_ACCESS', description: 'A fictional support request.' });
    expect(support.status).toBe(201);
  });

  it('expired: deleting stays open across modules; another Customer’s content is still 404', async () => {
    at(180_000);
    const a = agents.exp;
    const m = made.exp;
    // Ownership unchanged: eve's content is neither readable nor deletable by exp.
    await a.get(api(`/messages/${made.eve.message}`)).expect(404);
    await a.delete(api(`/messages/${made.eve.message}`)).expect(404);
    await a.delete(api(`/memory-vault/${made.eve.memory}`)).expect(404);
    await a.delete(api(`/messages/${m.message}/media/${m.media}`)).expect(204);
    await a.delete(api(`/my-wishes/songs/${m.song}`)).expect(204);
    await a.delete(api(`/my-wishes/prompts/${WISH}/response`)).expect(204);
    await a.delete(api(`/my-story/prompts/${STORY}/response`)).expect(204);
    await a.delete(api(`/memory-vault/${m.memory}`)).expect(204);
    await a.delete(api(`/messages/${m.message}`)).expect(204);
    await a.delete(api(`/trusted-contacts/${m.contact}`)).expect(204);
    await a.delete(api(`/recipients/${m.recipient}`)).expect(204);
    // eve's content is untouched.
    expect(await prisma.message.count({ where: { id: made.eve.message, deletedAt: null } })).toBe(1);
  });

  it('a billing return without a verified subscription unlocks nothing (checkout unavailable here, no Stripe)', async () => {
    at(200_000);
    expect((await agents.eve.post(api('/billing/checkout')).send({ tier: 'COMPLETE', interval: 'monthly' })).status).toBe(503);
    // The app's success return URL is only a page: the API still sees an expired trial.
    expect((await agents.eve.get(api('/billing')).expect(200)).body).toMatchObject({ state: 'trial_expired', hasAccess: false });
    expectRefused(await agents.eve.post(api('/memory-vault')).send({ title: 'After checkout', category: 'OTHER' }));
  });

  it('paid wins over ended trial dates; grandfathered accounts are unchanged', async () => {
    at(240_000);
    for (const n of ['paid', 'old'] as const) {
      await agents[n].patch(api(`/messages/${made[n].message}`)).send({ title: 'Still editable' }).expect(200);
      await agents[n].post(api('/memory-vault')).send({ title: 'New memory', category: 'OTHER' }).expect(201);
      await agents[n].put(api(`/my-wishes/prompts/${WISH}/response`)).send({ textContent: 'Changed.' }).expect(200);
    }
    expect((await agents.paid.get(api('/billing')).expect(200)).body).toMatchObject({ state: 'paid_active', hasAccess: true });
    expect((await agents.old.get(api('/billing')).expect(200)).body).toMatchObject({ enforced: false });
  });

  it('trial not started is a different reason (TRIAL_NOT_STARTED), not an expired trial', async () => {
    at(260_000);
    expectRefused(await agents.nos.post(api('/memory-vault')).send({ title: 'x', category: 'OTHER' }), 'TRIAL_NOT_STARTED');
    expect((await agents.nos.get(api('/billing')).expect(200)).body).toMatchObject({ state: 'trial_available', trialEligible: true });
    await agents.nos.get(api('/memory-vault')).expect(200);
    await agents.nos.post(api('/auth/logout')).send({}).expect((r) => expect([200, 204]).toContain(r.status));
  });
});
