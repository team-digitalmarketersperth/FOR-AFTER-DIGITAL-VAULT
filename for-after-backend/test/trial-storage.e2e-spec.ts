import { ConfigModule } from '@nestjs/config';
import argon2 from 'argon2';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import session from 'express-session';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AuthModule } from '../src/auth/auth.module.js';
import { TRIAL_DAYS } from '../src/billing/billing-access.js';
import { BillingModule } from '../src/billing/billing.module.js';
import { configureApp } from '../src/config/app.setup.js';
import { MediaModule } from '../src/media/media.module.js';
import { MalwareScanner } from '../src/media/scanner/malware-scanner.service.js';
import { MediaStorage } from '../src/media/storage/media-storage.service.js';
import { NOT_ENOUGH_STORAGE, STORAGE_FULL } from '../src/media/storage-quota.service.js';
import { MemoryVaultModule } from '../src/memory-vault/memory-vault.module.js';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { RecipientsModule } from '../src/recipients/recipients.module.js';
import { RedisModule } from '../src/redis/redis.module.js';
import { FakeMalwareScanner } from './fake-malware-scanner.js';
import { FakeMediaStorage } from './fake-media-storage.js';

// Trial restrictions Step 2: an enforced active trial holds exactly 100,000,000 bytes; every other state keeps the
// configured limit. Real PostgreSQL (row locks, sums); fake ImageKit and scanner; Stripe unconfigured (never called).
// Large sizes are synthetic READY rows: nothing is stored anywhere.
describe('Trial storage allowance (e2e, PostgreSQL)', () => {
  const TRIAL = 100_000_000;
  const CONFIGURED = 200_000_000;
  const DAY = 86_400_000;
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const run = Date.now();
  const names = ['tara', 'cora', 'paid', 'old', 'eve'] as const;
  type Name = (typeof names)[number];
  const emails = Object.fromEntries(names.map((n) => [n, `trialstorage.${n}.${run}@example.test`])) as Record<Name, string>;
  const password = 'StrongPassword123!';
  const storage = new FakeMediaStorage();
  type Agent = ReturnType<typeof request.agent>;
  const agents = {} as Record<Name, Agent>;
  const ids = {} as Record<Name, string>;
  const memories = {} as Record<Name, string>;
  const people = {} as Record<Name, string>;
  const api = (p: string) => `/api/v1${p}`;
  const ENV = {
    BILLING_ENABLED: 'true',
    BILLING_ENFORCE_FROM: new Date(run - 60_000).toISOString(),
    STRIPE_SECRET_KEY: '',
    STRIPE_WEBHOOK_SECRET: '',
    STORAGE_LIMIT_BYTES: String(CONFIGURED),
    THROTTLE_KEY_PREFIX: `for_after:test_trial_storage_throttle:${run}:`,
  };

  const usage = async (n: Name) => (await agents[n].get(api('/users/me/storage')).expect(200)).body;
  const photo = (sizeBytes: number) => ({ kind: 'PHOTO', mimeType: 'image/jpeg', sizeBytes, originalFileName: 'synthetic.jpg' });
  // Since Trial Step 4 a trial can't add content media; Recipient photos (trial policy undecided, unchanged) are the
  // uploads it can still make, so they carry the allowance checks. The allowance is the same for every upload kind.
  const upload = (n: Name, sizeBytes: number) => agents[n].post(api(`/recipients/${people[n]}/photo/upload-url`)).send(photo(sizeBytes));
  // A verified file already on the account (no provider object: the storage is fake).
  const seedReady = async (n: Name, sizeBytes: number) =>
    (
      await prisma.memoryVaultMediaAsset.create({
        data: {
          ownerUserId: ids[n],
          memoryVaultItemId: memories[n],
          kind: 'PHOTO',
          status: 'READY',
          storageKey: `test/trial-storage/${run}/${randomUUID()}.jpg`,
          providerFileId: `fake_${randomUUID()}`,
          originalFileName: 'synthetic.jpg',
          mimeType: 'image/jpeg',
          sizeBytes,
          uploadedAt: new Date(),
        },
        select: { id: true },
      })
    ).id;
  const trialRow = (n: Name, endsAt: Date) => prisma.customerTrial.create({ data: { userId: ids[n], startedAt: new Date(endsAt.getTime() - TRIAL_DAYS * DAY), endsAt } });

  beforeAll(async () => {
    Object.assign(process.env, ENV);
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule, RedisModule, AuthModule, BillingModule, MediaModule, MemoryVaultModule, RecipientsModule],
    })
      .overrideProvider(MediaStorage)
      .useValue(storage)
      .overrideProvider(MalwareScanner)
      .useValue(new FakeMalwareScanner())
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app, new session.MemoryStore());
    await app.init();
    prisma = app.get(PrismaService);
    // Synthetic verified Customers, seeded directly (the register route's per-IP limit is shared with other suites).
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    for (const n of names) {
      ids[n] = (
        await prisma.user.create({
          data: { email: emails[n], passwordHash, firstName: n, lastName: 'Test', role: 'CUSTOMER', emailVerifiedAt: new Date() },
          select: { id: true },
        })
      ).id;
      // Seeded directly: creating content needs access, which some of these accounts must not have.
      memories[n] = (await prisma.memoryVaultItem.create({ data: { ownerUserId: ids[n], title: 'Fictional', category: 'OTHER' }, select: { id: true } })).id;
      people[n] = (await prisma.recipient.create({ data: { ownerUserId: ids[n], firstName: 'Sofia' }, select: { id: true } })).id;
    }
    // An account from before billing enforcement (rollout rule).
    await prisma.user.update({ where: { id: ids.old }, data: { createdAt: new Date(run - DAY) } });
    for (const n of names) {
      const agent = request.agent(app.getHttpServer());
      await agent.post(api('/auth/login')).send({ email: emails[n], password }).expect(200);
      agents[n] = agent;
    }
  });

  afterAll(async () => {
    for (const k of Object.keys(ENV)) delete process.env[k];
    await prisma?.user.deleteMany({ where: { email: { in: Object.values(emails) } } });
    await app?.close();
  });

  it('starting a trial is unchanged: explicit, exactly 7 days, repeat returns the same trial; then 100,000,000 bytes', async () => {
    // trial_available: no write or upload access until the trial is started.
    expect((await agents.tara.get(api('/billing')).expect(200)).body.state).toBe('trial_available');
    await upload('tara', 1).expect(402);
    const first = (await agents.tara.post(api('/billing/trial')).send({}).expect(200)).body;
    expect(first.state).toBe('trial_active');
    expect(Date.parse(first.trial.endsAt) - Date.parse(first.trial.startedAt)).toBe(7 * DAY);
    const again = (await agents.tara.post(api('/billing/trial')).send({}).expect(200)).body;
    expect(again.trial).toEqual(first.trial);
    expect(await usage('tara')).toMatchObject({ limitBytes: TRIAL, remainingBytes: TRIAL, usedBytes: 0 });
  });

  it('active trial: one byte over is refused; exactly the remaining bytes fit; then storage is full', async () => {
    await seedReady('tara', TRIAL - 1_000_000);
    const signed = storage.createUpload.mock.calls.length;
    expect((await upload('tara', 1_000_001).expect(409)).body.message).toBe(NOT_ENOUGH_STORAGE);
    expect(storage.createUpload.mock.calls.length).toBe(signed);
    await upload('tara', 1_000_000).expect(201);
    expect(await usage('tara')).toMatchObject({ limitBytes: TRIAL, usedBytes: TRIAL - 1_000_000, reservedBytes: 1_000_000, remainingBytes: 0, percentage: 100, level: 'FULL' });
    expect((await upload('tara', 1).expect(409)).body.message).toBe(STORAGE_FULL);
  });

  it('active trial: concurrent reservations cannot exceed 100,000,000 bytes', async () => {
    await agents.cora.post(api('/billing/trial')).send({}).expect(200);
    await seedReady('cora', TRIAL - 5_000_000);
    const statuses = (await Promise.all(Array.from({ length: 5 }, () => upload('cora', 2_000_000)))).map((r) => r.status).sort((a, b) => a - b);
    expect(statuses).toEqual([201, 201, 409, 409, 409]);
    const u = await usage('cora');
    expect(u.reservedBytes).toBe(4_000_000);
    expect(u.usedBytes + u.reservedBytes).toBeLessThanOrEqual(TRIAL);
  });

  it('already over the trial allowance: files are kept, readable and deletable; nothing new fits', async () => {
    // Tara is full (99,000,000 READY + 1,000,000 reserved); 50,000,000 more from before puts her over.
    const big = await seedReady('tara', 50_000_000);
    expect(await usage('tara')).toMatchObject({ limitBytes: TRIAL, usedBytes: 149_000_000, remainingBytes: 0, percentage: 100, level: 'FULL' });
    expect((await upload('tara', 1).expect(409)).body.message).toBe(STORAGE_FULL);
    await agents.tara.get(api(`/memory-vault/${memories.tara}/media/${big}/access-url`)).expect(200);
    await agents.tara.delete(api(`/memory-vault/${memories.tara}/media/${big}`)).expect(204);
    expect(await usage('tara')).toMatchObject({ usedBytes: 99_000_000, reservedBytes: 1_000_000, remainingBytes: 0 });
  });

  it('paid access wins over active trial dates: the configured limit', async () => {
    await trialRow('paid', new Date(Date.now() + DAY));
    await prisma.billingAccount.create({
      data: { userId: ids.paid, stripeCustomerId: `cus_fictional_${run}`, livemode: false, plan: 'monthly', subscriptionStatus: 'active', cancelAtPeriodEnd: false, currentPeriodEnd: new Date(Date.now() + 30 * DAY) },
    });
    expect((await agents.paid.get(api('/billing')).expect(200)).body.state).toBe('paid_active');
    await seedReady('paid', 150_000_000);
    expect((await usage('paid')).limitBytes).toBe(CONFIGURED);
    await upload('paid', 1_000_000).expect(201);
  });

  it('accounts from before enforcement keep the configured limit and their access', async () => {
    expect((await agents.old.get(api('/billing')).expect(200)).body.state).toBe('no_billing_record');
    await seedReady('old', 150_000_000);
    expect((await usage('old')).limitBytes).toBe(CONFIGURED);
    await upload('old', 1_000_000).expect(201);
  });

  it('an expired trial gains no upload access, keeps the configured limit, and still reads and deletes', async () => {
    await trialRow('eve', new Date(Date.now() - 1000));
    expect((await agents.eve.get(api('/billing')).expect(200)).body.state).toBe('trial_expired');
    const file = await seedReady('eve', 150_000_000);
    await upload('eve', 1).expect(402);
    expect((await usage('eve')).limitBytes).toBe(CONFIGURED);
    await agents.eve.get(api(`/memory-vault/${memories.eve}/media/${file}/access-url`)).expect(200);
    await agents.eve.delete(api(`/memory-vault/${memories.eve}/media/${file}`)).expect(204);
    expect((await usage('eve')).usedBytes).toBe(0);
  });
});
