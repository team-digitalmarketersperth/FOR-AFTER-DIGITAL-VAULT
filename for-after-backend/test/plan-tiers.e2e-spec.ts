import { ConfigModule } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import argon2 from 'argon2';
import session from 'express-session';
import request from 'supertest';
import { AuthModule } from '../src/auth/auth.module.js';
import { PLAN_DEFINITIONS } from '../src/billing/billing-access.js';
import { BillingModule } from '../src/billing/billing.module.js';
import { configureApp } from '../src/config/app.setup.js';
import { EmailProvider } from '../src/email/email-provider.js';
import { MediaModule } from '../src/media/media.module.js';
import { MalwareScanner } from '../src/media/scanner/malware-scanner.service.js';
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

// Updated Plans Step 2: GET /billing gains `productTier` (additive). Tier, interval and exemption are reported
// truthfully; nothing about access, storage or caps changes yet. Real PostgreSQL; fake storage, scanner, email, SMS;
// Stripe unconfigured.
describe('Plan tiers foundation (e2e, PostgreSQL)', () => {
  const DAY = 86_400_000;
  const CONFIGURED = 7_000_000_000; // a distinctive STORAGE_LIMIT_BYTES, so "unchanged" can't pass by coincidence
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const run = Date.now();
  const names = ['trial', 'legacy', 'complete', 'old', 'expired'] as const;
  type Name = (typeof names)[number];
  const emails = Object.fromEntries(names.map((n) => [n, `plantiers.${n}.${run}@example.test`])) as Record<Name, string>;
  const agents = {} as Record<Name, ReturnType<typeof request.agent>>;
  const ids = {} as Record<Name, string>;
  const api = (p: string) => `/api/v1${p}`;
  const ENV = {
    BILLING_ENABLED: 'true',
    BILLING_ENFORCE_FROM: new Date(run - 60_000).toISOString(),
    STORAGE_LIMIT_BYTES: String(CONFIGURED),
    STRIPE_SECRET_KEY: '',
    STRIPE_WEBHOOK_SECRET: '',
    THROTTLE_KEY_PREFIX: `for_after:test_plan_tiers_throttle:${run}:`,
  };
  // Every key GET /billing returned before this step: consumers rely on them.
  const EXISTING = ['enabled', 'state', 'enforced', 'hasAccess', 'trialEligible', 'trialCaps', 'questionsAnswered', 'memoriesSaved', 'features', 'trial', 'subscription', 'plans', 'canManageSubscription'];
  const billing = async (n: Name) => (await agents[n].get(api('/billing')).expect(200)).body;
  const paid = (userId: string, plan: string, tier: 'PREMIUM' | 'COMPLETE' | null) =>
    prisma.billingAccount.create({
      data: { userId, stripeCustomerId: `cus_fictional_tiers_${userId}`, livemode: false, plan, tier, subscriptionStatus: 'active', cancelAtPeriodEnd: false, currentPeriodEnd: new Date(run + 30 * DAY) },
    });

  beforeAll(async () => {
    Object.assign(process.env, ENV);
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule, RedisModule, AuthModule, BillingModule, UsersModule, MediaModule, RecipientsModule],
    })
      .overrideProvider(MediaStorage)
      .useValue(new FakeMediaStorage())
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
    for (const n of names) {
      ids[n] = (await prisma.user.create({ data: { email: emails[n], passwordHash, firstName: n, lastName: 'Test', role: 'CUSTOMER', emailVerifiedAt: new Date() }, select: { id: true } })).id;
    }
    await prisma.user.update({ where: { id: ids.old }, data: { createdAt: new Date(run - DAY) } });
    await prisma.customerTrial.create({ data: { userId: ids.trial, startedAt: new Date(run - DAY), endsAt: new Date(run + 6 * DAY) } });
    await prisma.customerTrial.create({ data: { userId: ids.expired, startedAt: new Date(run - 8 * DAY), endsAt: new Date(run - DAY) } });
    // A legacy subscription (interval only, never mapped) and a mapped one; both with active trial dates (paid wins).
    for (const n of ['legacy', 'complete'] as const) await prisma.customerTrial.create({ data: { userId: ids[n], startedAt: new Date(run - DAY), endsAt: new Date(run + 6 * DAY) } });
    await paid(ids.legacy, 'annual', null);
    await paid(ids.complete, 'monthly', 'COMPLETE');
    await paid(ids.old, 'monthly', 'COMPLETE');
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

  it('the column is additive: no row outside test fixtures has a tier (no backfill)', async () => {
    // Fixtures in every suite use `cus_fictional_…` customers; other files may run in parallel on this database and seed
    // their own mapped tiers, so only rows they could not have created are checked.
    const mapped = await prisma.billingAccount.count({ where: { tier: { not: null }, NOT: { stripeCustomerId: { startsWith: 'cus_fictional_' } } } });
    expect(mapped).toBe(0);
  });

  it('existing fields are unchanged and productTier is added; an active trial is FREE_TRIAL with its definition', async () => {
    const b = await billing('trial');
    for (const k of EXISTING) expect(b).toHaveProperty(k);
    expect(b).toMatchObject({ state: 'trial_active', hasAccess: true, trialCaps: { recipients: 1, trustedContacts: 1, questions: 4, memories: 1 }, features: { media: false, memoryLinks: false } });
    expect(b.productTier).toMatchObject({ tier: 'FREE_TRIAL', interval: null, exemption: null, mapping: 'trial' });
    expect(b.productTier.definition).toEqual(JSON.parse(JSON.stringify(PLAN_DEFINITIONS.FREE_TRIAL)));
    // Updated Plans Step 7 (additive): the whole approved matrix, exactly the server's, for the comparison cards.
    expect(b.planDefinitions).toEqual(JSON.parse(JSON.stringify(PLAN_DEFINITIONS)));
    expect(b.productTier.notYetEnforced).toEqual(['support']); // AI: Updated Plans Step 5
    expect((await agents.trial.get(api('/users/me/storage')).expect(200)).body.limitBytes).toBe(100_000_000);
  });

  it('a legacy subscription with an interval but no tier is reported unmapped and keeps today’s paid behaviour', async () => {
    const b = await billing('legacy');
    expect(b).toMatchObject({ state: 'paid_active', hasAccess: true, subscription: { plan: 'annual' }, trialCaps: { recipients: null }, features: { media: true, memoryLinks: true } });
    expect(b.productTier).toEqual({ tier: null, interval: 'annual', exemption: null, mapping: 'unmapped', definition: null, inEffect: [], notYetEnforced: [] });
    expect((await agents.legacy.get(api('/users/me/storage')).expect(200)).body.limitBytes).toBe(CONFIGURED);
    for (let i = 0; i < 2; i++) await agents.legacy.post(api('/recipients')).send({ firstName: `P${i}` }).expect(201);
  });

  it('a mapped Complete subscription reports its definition; storage, recipients (Step 3) and AI (Step 5) apply; support is declared only', async () => {
    const b = await billing('complete');
    expect(b.productTier).toMatchObject({ tier: 'COMPLETE', interval: 'monthly', mapping: 'mapped' });
    expect(b.productTier.definition.storageBytes).toBe(5_000_000_000);
    expect(b.productTier.inEffect).toEqual(expect.arrayContaining(['storageBytes', 'recipients']));
    expect(b.productTier.notYetEnforced).toEqual(['support']); // AI: Updated Plans Step 5
    expect((await agents.complete.get(api('/users/me/storage')).expect(200)).body.limitBytes).toBe(5_000_000_000);
    // The trial-only caps never carry the paid limit (the trial UI reads them).
    expect(b.trialCaps).toEqual({ recipients: null, trustedContacts: null, questions: null, memories: null });
  });

  it('grandfathered: an exemption with no tier, even with a mapped subscription; expired: no tier and still 402 on writes', async () => {
    expect((await billing('old')).productTier).toEqual({ tier: null, interval: null, exemption: 'grandfathered', mapping: 'none', definition: null, inEffect: [], notYetEnforced: [] });
    const e = await billing('expired');
    expect(e).toMatchObject({ state: 'trial_expired', hasAccess: false });
    expect(e.productTier).toMatchObject({ tier: null, exemption: null, mapping: 'none' });
    expect((await agents.expired.post(api('/recipients')).send({ firstName: 'X' })).status).toBe(402);
    await agents.expired.get(api('/recipients')).expect(200);
  });
});
