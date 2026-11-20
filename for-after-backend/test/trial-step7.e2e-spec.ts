import { ConfigModule } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import argon2 from 'argon2';
import session from 'express-session';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AuthModule } from '../src/auth/auth.module.js';
import { PAID_FEATURE, TRIAL_LIMIT, TRIAL_MEMORY_LIMIT } from '../src/billing/billing-access.js';
import { BILLING_REQUIRED } from '../src/billing/billing-access.interceptor.js';
import { BillingModule } from '../src/billing/billing.module.js';
import { configureApp } from '../src/config/app.setup.js';
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
import { TrustedContactsModule } from '../src/trusted-contacts/trusted-contacts.module.js';
import { UsersModule } from '../src/users/users.module.js';
import { FakeEmailProvider } from './fake-email.js';
import { FakeMalwareScanner } from './fake-malware-scanner.js';
import { FakeMediaStorage } from './fake-media-storage.js';

// Trial restrictions Step 7 (approved policy refinements): one live Memory Vault memory in an enforced active trial,
// separate from the four questions; unlink-only, unscheduling and (still refused) invitation resends after expiry.
// Real PostgreSQL; fake ImageKit, scanner, email and SMS; Stripe unconfigured. Trials end by moving the trial row into
// the past (server time decides every write).
describe('Trial Step 7: Memory Vault allowance and expired-trial refinements (e2e, PostgreSQL)', () => {
  const DAY = 86_400_000;
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const run = Date.now();
  // Five accounts: sign-in is limited to five per minute per IP.
  const names = ['t1', 'race', 'xs', 'paid', 'old'] as const;
  type Name = (typeof names)[number];
  const emails = Object.fromEntries(names.map((n) => [n, `trialstep7.${n}.${run}@example.test`])) as Record<Name, string>;
  const password = 'StrongPassword123!';
  const email = new FakeEmailProvider();
  type Agent = ReturnType<typeof request.agent>;
  const agents = {} as Record<Name, Agent>;
  const ids = {} as Record<Name, string>;
  const api = (p: string) => `/api/v1${p}`;
  const STORY = 'childhood.earliest-memory';
  const ENV = {
    BILLING_ENABLED: 'true',
    BILLING_ENFORCE_FROM: new Date(run - 60_000).toISOString(),
    STRIPE_SECRET_KEY: '',
    STRIPE_WEBHOOK_SECRET: '',
    THROTTLE_KEY_PREFIX: `for_after:test_trial_step7_throttle:${run}:`,
  };
  const memory = (title = 'Beach days') => ({ title, category: 'OTHER', textContent: 'A written memory.' });
  const live = (n: Name) => prisma.memoryVaultItem.count({ where: { ownerUserId: ids[n], deletedAt: null } });
  const billing = async (n: Name) => (await agents[n].get(api('/billing')).expect(200)).body;
  const expectTrialLimit = (res: request.Response) => {
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ statusCode: 409, error: 'Conflict', code: TRIAL_LIMIT, message: TRIAL_MEMORY_LIMIT });
  };
  const expectExpired = (res: request.Response, label = '') => {
    expect([label, res.status]).toEqual([label, 402]);
    expect(res.body).toEqual({ statusCode: 402, error: 'Payment Required', code: 'TRIAL_EXPIRED', message: BILLING_REQUIRED });
  };
  // Direct seeding stands for content kept from a paid era (the trial itself can't make it).
  const seedMemory = (n: Name, title: string) =>
    prisma.memoryVaultItem.create({ data: { ownerUserId: ids[n], title, category: 'OTHER', textContent: 'Kept from before.' }, select: { id: true } }).then((r) => r.id);

  beforeAll(async () => {
    Object.assign(process.env, ENV);
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }), PrismaModule, RedisModule, AuthModule, BillingModule, UsersModule,
        RecipientsModule, TrustedContactsModule, MessagesModule, MessageSchedulesModule, MediaModule, MemoryVaultModule,
        MyStoryModule, MyWishesModule,
      ],
    })
      .overrideProvider(MediaStorage)
      .useValue(new FakeMediaStorage())
      .overrideProvider(MalwareScanner)
      .useValue(new FakeMalwareScanner())
      .overrideProvider(EmailProvider)
      .useValue(email)
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
      // Every account has an active trial; "paid" also has a subscription (wins), "old" predates enforcement.
      await prisma.customerTrial.create({ data: { userId: ids[n], startedAt: new Date(run - DAY), endsAt: new Date(run + 6 * DAY) } });
      const agent = request.agent(app.getHttpServer());
      await agent.post(api('/auth/login')).send({ email: emails[n], password }).expect(200);
      agents[n] = agent;
    }
    await prisma.user.update({ where: { id: ids.old }, data: { createdAt: new Date(run - DAY) } });
    await prisma.billingAccount.create({
      data: { userId: ids.paid, stripeCustomerId: `cus_fictional_step7_${run}`, livemode: false, plan: 'monthly', subscriptionStatus: 'active', cancelAtPeriodEnd: false, currentPeriodEnd: new Date(run + 30 * DAY) },
    });
  });

  afterAll(async () => {
    for (const k of Object.keys(ENV)) delete process.env[k];
    await prisma?.user.deleteMany({ where: { email: { in: Object.values(emails) } } });
    await app?.close();
  });

  it('active trial: the first text memory is saved, a second is refused with nothing created; editing stays open', async () => {
    const a = agents.t1;
    expect(await billing('t1')).toMatchObject({ state: 'trial_active', trialCaps: { memories: 1 }, memoriesSaved: 0 });
    const first = (await a.post(api('/memory-vault')).send(memory()).expect(201)).body.id;
    expect((await billing('t1')).memoriesSaved).toBe(1);
    expectTrialLimit(await a.post(api('/memory-vault')).send(memory('Second')));
    expect(await live('t1')).toBe(1);
    await a.patch(api(`/memory-vault/${first}`)).send({ title: 'Beach days, edited', textContent: 'Edited in the trial.' }).expect(200);
    expect((await a.get(api(`/memory-vault/${first}`)).expect(200)).body.title).toBe('Beach days, edited');
  });

  it('the memory is separate from the four questions: four answers leave memoriesSaved alone, and the cap stays 1', async () => {
    const a = agents.t1;
    for (const key of [STORY, 'childhood.home']) await a.put(api(`/my-story/prompts/${key}/response`)).send({ textContent: 'Written.' }).expect(200);
    for (const key of ['ceremony.style', 'ceremony.setting']) await a.put(api(`/my-wishes/prompts/${key}/response`)).send({ textContent: 'Written.' }).expect(200);
    expect(await billing('t1')).toMatchObject({ questionsAnswered: 4, memoriesSaved: 1 });
    expectTrialLimit(await a.post(api('/memory-vault')).send(memory('Third')));
  });

  it('direct API bypasses: media fields on create are rejected, media upload stays paid-only, nothing reserved', async () => {
    const a = agents.t1;
    const [{ id }] = await prisma.memoryVaultItem.findMany({ where: { ownerUserId: ids.t1, deletedAt: null }, select: { id: true } });
    // Extra fields never reach the database (whitelist), even when a slot would be free.
    expect((await a.post(api('/memory-vault')).send({ ...memory(), mediaAssetIds: [randomUUID()], ownerUserId: ids.paid })).status).toBe(400);
    const up = await a.post(api(`/memory-vault/${id}/media/upload-url`)).send({ kind: 'PHOTO', mimeType: 'image/jpeg', sizeBytes: 1000, originalFileName: 'x.jpg' });
    expect(up.status).toBe(409);
    expect(up.body.code).toBe(PAID_FEATURE);
    expect(await prisma.memoryVaultMediaAsset.count({ where: { ownerUserId: ids.t1 } })).toBe(0);
  });

  it('deleting the memory frees the slot; a new one can then be created', async () => {
    const a = agents.t1;
    const [{ id }] = await prisma.memoryVaultItem.findMany({ where: { ownerUserId: ids.t1, deletedAt: null }, select: { id: true } });
    await a.delete(api(`/memory-vault/${id}`)).expect(204);
    expect((await billing('t1')).memoriesSaved).toBe(0);
    await a.post(api('/memory-vault')).send(memory('After the delete')).expect(201);
    expectTrialLimit(await a.post(api('/memory-vault')).send(memory('One too many')));
    expect(await live('t1')).toBe(1);
  });

  it('concurrent creates: exactly one of eight is saved (User row lock)', async () => {
    const res = await Promise.all(Array.from({ length: 8 }, (_, i) => agents.race.post(api('/memory-vault')).send(memory(`Race ${i}`))));
    expect(res.filter((r) => r.status === 201)).toHaveLength(1);
    for (const r of res.filter((r) => r.status !== 201)) expectTrialLimit(r);
    expect(await live('race')).toBe(1);
  });

  it('existing excess memories stay readable, editable and deletable; creation is blocked until under the cap', async () => {
    const a = agents.xs;
    const kept = [await seedMemory('xs', 'Old one'), await seedMemory('xs', 'Old two'), await seedMemory('xs', 'Old three')];
    expect((await billing('xs')).memoriesSaved).toBe(3);
    expect((await a.get(api('/memory-vault')).expect(200)).body.items).toHaveLength(3);
    await a.patch(api(`/memory-vault/${kept[0]}`)).send({ title: 'Old one, edited' }).expect(200);
    expectTrialLimit(await a.post(api('/memory-vault')).send(memory()));
    await a.delete(api(`/memory-vault/${kept[1]}`)).expect(204);
    expectTrialLimit(await a.post(api('/memory-vault')).send(memory()));
    expect(await live('xs')).toBe(2);
    // Nothing was stripped or deleted to enforce the cap.
    expect(await prisma.memoryVaultItem.count({ where: { id: { in: [kept[0], kept[2]] }, deletedAt: null } })).toBe(2);
  });

  it('paid (over active trial dates) and grandfathered accounts are unchanged: no memory cap', async () => {
    for (const n of ['paid', 'old'] as const) {
      for (let i = 0; i < 3; i++) await agents[n].post(api('/memory-vault')).send(memory(`M${i}`)).expect(201);
      expect(await billing(n)).toMatchObject({ trialCaps: { memories: null }, memoriesSaved: 3 });
    }
  });

  describe('after the trial ends (xs: kept memories, a linked answer, a schedule and an invitation from the trial)', () => {
    const made = {} as { message: string; contact: string; linked: string[]; file: string };

    beforeAll(async () => {
      const a = agents.xs;
      const recipient = (await a.post(api('/recipients')).send({ firstName: 'Sofia' }).expect(201)).body.id;
      made.message = (await a.post(api('/messages')).send({ title: 'For Sofia', textContent: 'Written words.', recipientIds: [recipient] }).expect(201)).body.id;
      await a.post(api(`/messages/${made.message}/schedule`)).send({ triggerType: 'ON_DEATH' }).expect(201);
      made.contact = (await a.post(api('/trusted-contacts')).send({ firstName: 'Tom', email: `tc.step7.${run}@example.test` }).expect(201)).body.id;
      await a.post(api(`/trusted-contacts/${made.contact}/invitation`)).send({ channel: 'EMAIL' }).expect((r) => expect(r.status).toBeLessThan(300));
      await a.put(api(`/my-story/prompts/${STORY}/response`)).send({ textContent: 'A house by the sea.' }).expect(200);
      // Links and a memory file from a paid era (links are paid-only in the trial, Step 5).
      const response = await prisma.myStoryResponse.findFirstOrThrow({ where: { ownerUserId: ids.xs, promptKey: STORY }, select: { id: true } });
      made.linked = (await prisma.memoryVaultItem.findMany({ where: { ownerUserId: ids.xs, deletedAt: null }, select: { id: true }, orderBy: { createdAt: 'asc' } })).map((m) => m.id);
      await prisma.myStoryMemoryLink.createMany({ data: made.linked.map((memoryVaultItemId) => ({ myStoryResponseId: response.id, memoryVaultItemId })) });
      made.file = (
        await prisma.memoryVaultMediaAsset.create({
          data: { ownerUserId: ids.xs, memoryVaultItemId: made.linked[0], kind: 'PHOTO', status: 'READY', storageKey: `test/trial-step7/${run}/${randomUUID()}.jpg`, providerFileId: `fake_${randomUUID()}`, originalFileName: 'synthetic.jpg', mimeType: 'image/jpeg', sizeBytes: 1000, uploadedAt: new Date() },
          select: { id: true },
        })
      ).id;
      await prisma.customerTrial.update({ where: { userId: ids.xs }, data: { startedAt: new Date(run - 8 * DAY), endsAt: new Date(run - DAY) } });
      expect((await billing('xs')).state).toBe('trial_expired');
    });

    const links = async () =>
      (await agents.xs.get(api(`/my-story/prompts/${STORY}/response`)).expect(200)).body.memories.map((m: { id: string }) => m.id).sort();
    const unlink = (body: object, n: Name = 'xs') => agents[n].delete(api(`/my-story/prompts/${STORY}/response/memories`)).send(body);

    it('mixed or widening unlink requests fail atomically: nothing removed, text unchanged', async () => {
      const before = await links();
      expect(before).toEqual([...made.linked].sort());
      // An edit smuggled into the unlink request: rejected by validation.
      expect((await unlink({ memoryVaultItemIds: [made.linked[0]], textContent: 'Changed' })).status).toBe(400);
      expect((await unlink({ memoryVaultItemIds: [made.linked[0]], privateNote: 'x' })).status).toBe(400);
      // Not a subset of the current links (an addition attempt): nothing is removed.
      const other = await seedMemory('xs', 'Never linked');
      const res = await unlink({ memoryVaultItemIds: [made.linked[0], other] });
      expect(res.status).toBe(400);
      expect(res.body.message).toBe('One or more memories are not linked to this answer.');
      expect((await unlink({ memoryVaultItemIds: [] })).status).toBe(400);
      // The answer-update endpoint itself is still gated, even for a set that only removes links.
      expectExpired(await agents.xs.put(api(`/my-story/prompts/${STORY}/response`)).send({ memoryVaultItemIds: [made.linked[1]] }), 'PUT links');
      expectExpired(await agents.xs.put(api(`/my-story/prompts/${STORY}/response`)).send({ memoryVaultItemIds: [made.linked[1]], textContent: 'Changed' }), 'PUT mixed');
      expect(await links()).toEqual(before);
      expect((await agents.xs.get(api(`/my-story/prompts/${STORY}/response`))).body.textContent).toBe('A house by the sea.');
    });

    it('unlink-only succeeds (any letter case); memories, files and text are kept; another Customer gets 404', async () => {
      const res = await unlink({ memoryVaultItemIds: [made.linked[0].toUpperCase()] });
      expect(res.status).toBe(200);
      expect(res.body.textContent).toBe('A house by the sea.');
      expect(await links()).toEqual([made.linked[1]].sort());
      expect(await prisma.memoryVaultItem.count({ where: { id: { in: made.linked }, deletedAt: null } })).toBe(2);
      expect(await prisma.memoryVaultMediaAsset.count({ where: { id: made.file, deletedAt: null } })).toBe(1);
      // Re-adding the removed link is a write and stays refused.
      expectExpired(await agents.xs.put(api(`/my-story/prompts/${STORY}/response`)).send({ memoryVaultItemIds: made.linked }), 're-add');
      // Ownership: the route only ever sees the session's own answer.
      expect((await unlink({ memoryVaultItemIds: [made.linked[1]] }, 'race')).status).toBe(404);
      expect(await links()).toEqual([made.linked[1]]);
      await unlink({ memoryVaultItemIds: [made.linked[1]] }).expect(200);
      expect(await links()).toEqual([]);
    });

    it('memory creation and editing are refused as expired (402, not the trial cap); deleting stays open', async () => {
      const a = agents.xs;
      expectExpired(await a.post(api('/memory-vault')).send(memory()), 'create');
      expectExpired(await a.patch(api(`/memory-vault/${made.linked[1]}`)).send({ title: 'x' }), 'edit');
      await a.delete(api(`/memory-vault/${made.linked[1]}`)).expect(204);
    });

    it('unscheduling stays allowed; scheduling and rescheduling stay refused', async () => {
      const a = agents.xs;
      const url = api(`/messages/${made.message}/schedule`);
      expectExpired(await a.patch(url).send({ triggerType: 'FIXED_DATE', scheduledFor: new Date(run + 10 * DAY).toISOString() }), 'reschedule');
      await a.delete(url).expect(204);
      expect(await prisma.messageSchedule.count({ where: { messageId: made.message } })).toBe(0);
      expect((await a.get(api(`/messages/${made.message}`)).expect(200)).body.status).toBe('DRAFT');
      expectExpired(await a.post(url).send({ triggerType: 'ON_DEATH' }), 'schedule again');
    });

    it('invitation resends stay refused; the existing invitation is unchanged', async () => {
      const before = await prisma.trustedContactInvitation.findMany({ where: { trustedContactId: made.contact }, select: { id: true, status: true } });
      expect(before.length).toBeGreaterThan(0);
      expectExpired(await agents.xs.post(api(`/trusted-contacts/${made.contact}/invitation`)).send({ channel: 'EMAIL' }), 'resend');
      expect(await prisma.trustedContactInvitation.findMany({ where: { trustedContactId: made.contact }, select: { id: true, status: true } })).toEqual(before);
    });
  });
});
