import { ConfigModule } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import argon2 from 'argon2';
import session from 'express-session';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AuthModule } from '../src/auth/auth.module.js';
import { PLAN_LIMIT, planRecipientLimitMessage } from '../src/billing/billing-access.js';
import { BillingModule } from '../src/billing/billing.module.js';
import { configureApp } from '../src/config/app.setup.js';
import { EmailProvider } from '../src/email/email-provider.js';
import type { PaidTier } from '../src/generated/prisma/client.js';
import { MediaModule } from '../src/media/media.module.js';
import { MalwareScanner } from '../src/media/scanner/malware-scanner.service.js';
import { NOT_ENOUGH_STORAGE, STORAGE_FULL } from '../src/media/storage-quota.service.js';
import { MediaStorage } from '../src/media/storage/media-storage.service.js';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { RecipientsModule } from '../src/recipients/recipients.module.js';
import { RedisModule } from '../src/redis/redis.module.js';
import { SmsSender } from '../src/sms/sms-sender.js';
import { SmsVerification } from '../src/sms/sms-verification.js';
import { UsersModule } from '../src/users/users.module.js';
import { FakeEmailProvider } from './fake-email.js';
import { FakeMalwareScanner } from './fake-malware-scanner.js';
import { FakeMediaStorage } from './fake-media-storage.js';

// Updated Plans Step 3: storage and live-recipient limits for an entitled, explicitly mapped PREMIUM or COMPLETE tier.
// Real PostgreSQL; fake storage, scanner, email and SMS; Stripe unconfigured. Tiers are set directly on the synthetic
// accounts' BillingAccount rows (nothing maps them from Stripe yet).
describe('Paid plan storage and recipient limits (e2e, PostgreSQL)', () => {
  const DAY = 86_400_000;
  const CONFIGURED = 7_000_000_000; // distinctive STORAGE_LIMIT_BYTES: "unchanged" can't pass by coincidence
  const PREMIUM = 2_000_000_000;
  const COMPLETE = 5_000_000_000;
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const storage = new FakeMediaStorage();
  const run = Date.now();
  // Five accounts: sign-in is limited to five per minute per IP.
  const names = ['prem', 'comp', 'unm', 'old', 'lapsed'] as const;
  type Name = (typeof names)[number];
  const emails = Object.fromEntries(names.map((n) => [n, `planlimits.${n}.${run}@example.test`])) as Record<Name, string>;
  const agents = {} as Record<Name, ReturnType<typeof request.agent>>;
  const ids = {} as Record<Name, string>;
  const memories = {} as Record<Name, string>;
  const api = (p: string) => `/api/v1${p}`;
  const ENV = {
    BILLING_ENABLED: 'true',
    BILLING_ENFORCE_FROM: new Date(run - 60_000).toISOString(),
    STORAGE_LIMIT_BYTES: String(CONFIGURED),
    STRIPE_SECRET_KEY: '',
    STRIPE_WEBHOOK_SECRET: '',
    THROTTLE_KEY_PREFIX: `for_after:test_plan_limits_throttle:${run}:`,
  };
  const live = (n: Name) => prisma.recipient.count({ where: { ownerUserId: ids[n], deletedAt: null } });
  const seedRecipients = async (n: Name, count: number) => {
    await prisma.recipient.createMany({ data: Array.from({ length: count }, (_, i) => ({ ownerUserId: ids[n], firstName: `Seeded ${i}` })) });
  };
  const create = (n: Name, firstName = 'New person') => agents[n].post(api('/recipients')).send({ firstName });
  const expectPlanLimit = (res: request.Response, max: number) => {
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ statusCode: 409, error: 'Conflict', code: PLAN_LIMIT, message: planRecipientLimitMessage(max) });
  };
  const usage = async (n: Name) => (await agents[n].get(api('/users/me/storage')).expect(200)).body;
  // A verified file already on the account (no provider object: the storage is fake). sizeBytes is an INT column.
  const seedReady = (n: Name, sizeBytes: number) =>
    prisma.memoryVaultMediaAsset.create({
      data: { ownerUserId: ids[n], memoryVaultItemId: memories[n], kind: 'PHOTO', status: 'READY', storageKey: `test/plan-limits/${run}/${randomUUID()}.jpg`, providerFileId: `fake_${randomUUID()}`, originalFileName: 'synthetic.jpg', mimeType: 'image/jpeg', sizeBytes, uploadedAt: new Date() },
    });
  const anyRecipient = async (n: Name) => (await prisma.recipient.findFirstOrThrow({ where: { ownerUserId: ids[n], deletedAt: null }, select: { id: true } })).id;
  const recipientIds = async (n: Name, take: number) => (await prisma.recipient.findMany({ where: { ownerUserId: ids[n], deletedAt: null }, select: { id: true }, take })).map((r) => r.id);
  const photoUpload = (n: Name, recipientId: string, sizeBytes: number) =>
    agents[n].post(api(`/recipients/${recipientId}/photo/upload-url`)).send({ kind: 'PHOTO', mimeType: 'image/jpeg', sizeBytes, originalFileName: 'synthetic.jpg' });
  const setTier = (n: Name, tier: PaidTier | null) => prisma.billingAccount.update({ where: { userId: ids[n] }, data: { tier } });

  beforeAll(async () => {
    Object.assign(process.env, ENV);
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule, RedisModule, AuthModule, BillingModule, UsersModule, MediaModule, RecipientsModule],
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
    const passwordHash = await argon2.hash('StrongPassword123!', { type: argon2.argon2id });
    const tiers: Record<Name, PaidTier | null> = { prem: 'PREMIUM', comp: 'COMPLETE', unm: null, old: 'COMPLETE', lapsed: 'PREMIUM' };
    for (const n of names) {
      ids[n] = (await prisma.user.create({ data: { email: emails[n], passwordHash, firstName: n, lastName: 'Test', role: 'CUSTOMER', emailVerifiedAt: new Date() }, select: { id: true } })).id;
      memories[n] = (await prisma.memoryVaultItem.create({ data: { ownerUserId: ids[n], title: 'Holder', category: 'OTHER' }, select: { id: true } })).id;
      const ended = n === 'lapsed';
      await prisma.billingAccount.create({
        data: {
          userId: ids[n],
          stripeCustomerId: `cus_fictional_limits_${n}_${run}`,
          livemode: false,
          plan: 'monthly',
          tier: tiers[n],
          subscriptionStatus: ended ? 'canceled' : 'active',
          cancelAtPeriodEnd: false,
          currentPeriodEnd: new Date(run + (ended ? -DAY : 30 * DAY)),
        },
      });
    }
    await prisma.user.update({ where: { id: ids.old }, data: { createdAt: new Date(run - DAY) } }); // before enforcement
    for (const n of names) {
      const a = request.agent(app.getHttpServer());
      await a.post(api('/auth/login')).send({ email: emails[n], password: 'StrongPassword123!' }).expect(200);
      agents[n] = a;
    }
  });

  afterAll(async () => {
    for (const k of Object.keys(ENV)) delete process.env[k];
    await prisma?.user.deleteMany({ where: { email: { in: Object.values(emails) } } });
    await app?.close();
  });

  it('Premium: the 10th person is added, the 11th is refused (PLAN_LIMIT); deleting frees a slot; editing takes none', async () => {
    await seedRecipients('prem', 8);
    await create('prem', 'Ninth').expect(201);
    const tenth = (await create('prem', 'Tenth').expect(201)).body.id;
    expectPlanLimit(await create('prem', 'Eleventh'), 10);
    expect(await live('prem')).toBe(10);
    await agents.prem.patch(api(`/recipients/${tenth}`)).send({ firstName: 'Tenth, renamed' }).expect(200);
    expect(await live('prem')).toBe(10);
    await agents.prem.delete(api(`/recipients/${tenth}`)).expect(204);
    await create('prem', 'Replacement').expect(201);
    expectPlanLimit(await create('prem', 'Still too many'), 10);
  });

  it('Premium: parallel creates near the boundary never pass 10', async () => {
    const ids3 = await recipientIds('prem', 3);
    for (const id of ids3) await agents.prem.delete(api(`/recipients/${id}`)).expect(204); // 7 live
    const res = await Promise.all(Array.from({ length: 6 }, (_, i) => create('prem', `Parallel ${i}`)));
    expect(res.filter((r) => r.status === 201)).toHaveLength(3);
    for (const r of res.filter((r) => r.status !== 201)) expectPlanLimit(r, 10);
    expect(await live('prem')).toBe(10);
  });

  it('Complete: parallel creates reach exactly 50; the 51st is refused', async () => {
    await seedRecipients('comp', 46);
    const res = await Promise.all(Array.from({ length: 8 }, (_, i) => create('comp', `Parallel ${i}`)));
    expect(res.filter((r) => r.status === 201)).toHaveLength(4);
    for (const r of res.filter((r) => r.status !== 201)) expectPlanLimit(r, 50);
    expect(await live('comp')).toBe(50);
    expectPlanLimit(await create('comp', 'Fifty-first'), 50);
  });

  it('Premium storage: exactly 2,000,000,000 bytes fits; one byte more does not; usage reports the plan limit', async () => {
    await seedReady('prem', PREMIUM - 1000);
    const [a, b] = await recipientIds('prem', 2);
    expect((await photoUpload('prem', a, 1001).expect(409)).body.message).toBe(NOT_ENOUGH_STORAGE);
    await photoUpload('prem', a, 1000).expect(201);
    expect(await usage('prem')).toMatchObject({ limitBytes: PREMIUM, usedBytes: PREMIUM - 1000, reservedBytes: 1000, remainingBytes: 0, percentage: 100, level: 'FULL' });
    expect((await photoUpload('prem', b, 1).expect(409)).body.message).toBe(STORAGE_FULL);
  });

  it('Complete storage: exactly 5,000,000,000 fits, one byte more does not; parallel reservations never exceed it', async () => {
    for (const size of [2_000_000_000, 2_000_000_000, 1_000_000_000 - 3000]) await seedReady('comp', size); // 3,000 left
    const targets = await recipientIds('comp', 6);
    const res = await Promise.all(targets.map((id) => photoUpload('comp', id, 1000)));
    expect(res.filter((r) => r.status === 201)).toHaveLength(3);
    for (const r of res.filter((r) => r.status !== 201)) expect([r.status, r.body.message]).toEqual([409, STORAGE_FULL]);
    const u = await usage('comp');
    expect(u).toMatchObject({ limitBytes: COMPLETE, reservedBytes: 3000, remainingBytes: 0, level: 'FULL' });
    expect(u.usedBytes + u.reservedBytes).toBe(COMPLETE);
    expect((await photoUpload('comp', targets[0], 1).expect(409)).body.message).toBe(STORAGE_FULL);
  });

  it('a plan change during an upload: the reservation made under Complete completes once, with no second charge; the account is then over Premium', async () => {
    // Make 2,000 bytes free on Complete by shrinking one seeded file (synthetic row), then reserve them.
    const holder = await prisma.memoryVaultMediaAsset.findFirstOrThrow({ where: { ownerUserId: ids.comp, sizeBytes: 1_000_000_000 - 3000 }, select: { id: true } });
    await prisma.memoryVaultMediaAsset.update({ where: { id: holder.id }, data: { sizeBytes: 1_000_000_000 - 5000 } }); // 2,000 free
    const target = (await recipientIds('comp', 7))[6];
    const reserved = (await photoUpload('comp', target, 2000).expect(201)).body;
    const fileId = storage.upload(reserved.upload, { sizeBytes: 2000, contentType: 'image/jpeg' });
    await setTier('comp', 'PREMIUM'); // downgrade while the upload is in flight
    await agents.comp.post(api(`/recipients/${target}/photo/${reserved.mediaAssetId}/complete`)).send({ providerFileId: fileId }).expect(200);
    const u = await usage('comp');
    expect(u.limitBytes).toBe(PREMIUM);
    expect(u.usedBytes + u.reservedBytes).toBe(COMPLETE); // counted once (2,000 moved from reserved to used)
    expect(u).toMatchObject({ remainingBytes: 0, percentage: 100, level: 'FULL' });
  });

  it('downgrade excess: everything stays readable, editable, downloadable and deletable; new people and uploads are refused', async () => {
    // comp is now PREMIUM with 50 people and ~5 GB.
    expect((await agents.comp.get(api('/recipients?limit=100')).expect(200)).body.pagination.total).toBe(50);
    const someone = await anyRecipient('comp');
    await agents.comp.patch(api(`/recipients/${someone}`)).send({ firstName: 'Still editable' }).expect(200);
    expectPlanLimit(await create('comp', 'Over Premium'), 10);
    expect((await photoUpload('comp', someone, 1).expect(409)).body.message).toBe(STORAGE_FULL);
    const withPhoto = await prisma.recipientPhoto.findFirstOrThrow({ where: { ownerUserId: ids.comp, status: 'READY', deletedAt: null }, select: { id: true, recipientId: true } });
    expect((await agents.comp.get(api(`/recipients/${withPhoto.recipientId}/photo/${withPhoto.id}/access-url`)).expect(200)).body.url).toEqual(expect.any(String));
    await agents.comp.delete(api(`/recipients/${someone}`)).expect(204);
    expect(await live('comp')).toBe(49); // only the deliberate delete; nothing removed automatically
    expect(await prisma.memoryVaultMediaAsset.count({ where: { ownerUserId: ids.comp, deletedAt: null } })).toBe(3);
  });

  it('unmapped paid (no stored tier): configured storage and no recipient cap, as before', async () => {
    for (let i = 0; i < 12; i++) await create('unm', `Person ${i}`).expect(201);
    expect((await usage('unm')).limitBytes).toBe(CONFIGURED);
    expect((await agents.unm.get(api('/billing')).expect(200)).body.productTier).toMatchObject({ tier: null, mapping: 'unmapped' });
  });

  it('grandfathered with a stored Complete tier: exempt, so configured storage and no cap (the tier is not applied)', async () => {
    await seedRecipients('old', 50);
    await create('old', 'Fifty-first').expect(201);
    expect((await usage('old')).limitBytes).toBe(CONFIGURED);
  });

  it('a stored tier without entitled access cannot bypass the gate: writes 402, reads and deletes stay open', async () => {
    await seedRecipients('lapsed', 2);
    const res = await create('lapsed', 'Not allowed');
    expect(res.status).toBe(402);
    expect(res.body.code).toBe('PLAN_ENDED');
    const id = await anyRecipient('lapsed');
    expect((await photoUpload('lapsed', id, 1000)).status).toBe(402);
    await agents.lapsed.get(api('/recipients')).expect(200);
    expect((await usage('lapsed')).limitBytes).toBe(CONFIGURED);
    await agents.lapsed.delete(api(`/recipients/${id}`)).expect(204);
  });

  it('Updated Plans Step 7: GET /billing people = live counts and the limits the create routes enforce (never derived in the app)', async () => {
    const people = async (n: Name) => (await agents[n].get(api('/billing')).expect(200)).body.people;
    for (const n of names) {
      const p = await people(n);
      expect(p.recipients.used).toBe(await live(n));
      expect(p.trustedContacts.used).toBe(await prisma.trustedContact.count({ where: { ownerUserId: ids[n], deletedAt: null } }));
      expect(p.trustedContacts).toMatchObject({ limit: 2, limitSource: 'maximum' }); // no plan raises the two-contact maximum
    }
    expect((await people('prem')).recipients).toMatchObject({ limit: 10, limitSource: 'plan' });
    expect((await people('comp')).recipients).toMatchObject({ limit: 10, limitSource: 'plan' }); // downgraded earlier in this file
    await setTier('comp', 'COMPLETE'); // the stored tier, read again: no cache, no interval-derived limit
    expect((await people('comp')).recipients).toMatchObject({ limit: 50, limitSource: 'plan' });
    // No count limit is null, never a number or "unlimited": unmapped paid, grandfathered (with a stored tier), ended.
    for (const n of ['unm', 'old', 'lapsed'] as const) expect((await people(n)).recipients).toMatchObject({ limit: null, limitSource: null });
  });
});
