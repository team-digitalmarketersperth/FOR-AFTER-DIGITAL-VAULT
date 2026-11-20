import { ConfigModule, ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import argon2 from 'argon2';
import session from 'express-session';
import { randomUUID } from 'node:crypto';
import Stripe from 'stripe';
import request from 'supertest';
import { AiUsageService } from '../src/assistant/ai-usage.service.js';
import { AssistantModule } from '../src/assistant/assistant.module.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { PLAN_UNRESOLVED_MESSAGE } from '../src/billing/billing-access.interceptor.js';
import { PLAN_LIMIT, utcMonth } from '../src/billing/billing-access.js';
import { BillingModule } from '../src/billing/billing.module.js';
import { StripeGateway } from '../src/billing/stripe-gateway.js';
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
import { SupportModule } from '../src/support/support.module.js';
import { UsersModule } from '../src/users/users.module.js';
import { FakeEmailProvider } from './fake-email.js';
import { FakeMalwareScanner } from './fake-malware-scanner.js';
import { FakeMediaStorage } from './fake-media-storage.js';

// Updated Plans Step 6: Stripe price → tier/interval mapping through Checkout and signed webhooks. Real PostgreSQL,
// real HTTP, sessions and the real Stripe signature check; the Stripe API is a fake (nothing reaches Stripe, nothing is
// charged). This is NOT sandbox evidence. Fictional people; fictional ids. Premium prices are test configuration only
// (real Premium pricing is undecided).
const WHSEC = 'whsec_test_fictional_secret_for_tiers_e2e';
const PRICE = { pm: 'price_t6_premium_month', pa: 'price_t6_premium_year', cm: 'price_t6_complete_month', ca: 'price_t6_complete_year', legacy: 'price_t6_legacy_month', other: 'price_t6_not_configured' };
describe('Stripe tier mapping and Checkout (e2e, PostgreSQL, Stripe faked)', () => {
  const DAY = 86_400_000;
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let usage: AiUsageService;
  const run = Date.now();
  const names = ['cara', 'pete', 'leg', 'unk', 'held', 'amb', 'lock'] as const;
  type Name = (typeof names)[number];
  const emails = Object.fromEntries(names.map((n) => [n, `tiers6.${n}.${run}@example.test`])) as Record<Name, string>;
  const agents = {} as Record<Name, ReturnType<typeof request.agent>>;
  const ids = {} as Record<Name, string>;
  const customer = (n: Name) => `cus_t6_${n}_${run}`;
  const api = (p: string) => `/api/v1${p}`;
  const ENV = {
    BILLING_ENABLED: 'true',
    BILLING_ENFORCE_FROM: new Date(run - 60_000).toISOString(),
    STRIPE_SECRET_KEY: 'sk_test_fictional_not_a_real_key',
    STRIPE_WEBHOOK_SECRET: WHSEC,
    STRIPE_PRICE_PREMIUM_MONTHLY: PRICE.pm,
    STRIPE_PRICE_PREMIUM_ANNUAL: PRICE.pa,
    STRIPE_PRICE_COMPLETE_MONTHLY: PRICE.cm,
    STRIPE_PRICE_COMPLETE_ANNUAL: PRICE.ca,
    STRIPE_PRICE_MONTHLY: PRICE.legacy,
    STRIPE_PRICE_ANNUAL: '',
    STORAGE_LIMIT_BYTES: '7000000000',
    THROTTLE_KEY_PREFIX: `for_after:test_tiers6_throttle:${run}:`,
  };

  const subs = new Map<string, Stripe.Subscription>();
  const priceOverrides = new Map<string, Partial<Stripe.Price>>();
  const fake = {
    createCustomer: vi.fn(async () => ({ id: customer('cara'), livemode: false }) as Stripe.Customer),
    createCheckout: vi.fn(async (input: unknown) => input && ({ url: 'https://checkout.stripe.example/c/t6' }) as Stripe.Checkout.Session),
    createPortal: vi.fn(async () => ({ url: 'https://billing.stripe.example/p/t6' }) as Stripe.BillingPortal.Session),
    retrievePrice: vi.fn(
      async (id: string) =>
        ({
          id,
          active: true,
          livemode: false,
          type: 'recurring',
          recurring: { interval: id.endsWith('_year') ? 'year' : 'month', interval_count: 1, usage_type: 'licensed' },
          ...priceOverrides.get(id),
        }) as Stripe.Price,
    ),
    retrieveSubscription: vi.fn(async (id: string) => {
      const s = subs.get(id);
      if (!s) throw new Error('No such subscription (fake)');
      return s;
    }),
    listSubscriptions: vi.fn(async (cus: string) => [...subs.values()].filter((s) => s.customer === cus).reverse()),
  };
  const setSub = (id: string, n: Name, status: string, prices: string[], opts: { end?: Date; cancel?: boolean; created?: number; quantity?: number } = {}) =>
    subs.set(id, {
      id,
      object: 'subscription',
      customer: customer(n),
      status,
      livemode: false,
      created: opts.created ?? Math.floor(Date.now() / 1000),
      cancel_at_period_end: opts.cancel ?? false,
      items: { data: prices.map((p) => ({ price: p ? { id: p } : null, quantity: opts.quantity ?? 1, current_period_end: Math.floor((opts.end ?? new Date(Date.now() + 30 * DAY)).getTime() / 1000) })) },
    } as unknown as Stripe.Subscription);
  const send = (event: object, secret = WHSEC) => {
    const payload = JSON.stringify(event);
    const header = Stripe.webhooks.generateTestHeaderString({ payload, secret });
    return request(app.getHttpServer()).post(api('/webhooks/stripe')).set('Stripe-Signature', header).set('Content-Type', 'application/json').send(payload);
  };
  const event = (type: string, object: object) => ({
    id: `evt_${randomUUID().replace(/-/g, '')}`,
    object: 'event',
    type,
    livemode: false,
    created: Math.floor(Date.now() / 1000),
    data: { object },
  });
  const sync = (n: Name, sub: string) => send(event('customer.subscription.updated', { id: sub, customer: customer(n) }));
  const billing = async (n: Name) => (await agents[n].get(api('/billing')).expect(200)).body;
  const storageLimit = async (n: Name) => (await agents[n].get(api('/users/me/storage')).expect(200)).body.limitBytes as number;
  const write = (n: Name) => agents[n].post(api('/recipients')).send({ firstName: 'Mia' });
  const stored = (n: Name) => prisma.billingAccount.findUniqueOrThrow({ where: { userId: ids[n] } });
  const useAi = (n: Name, count: number) => {
    const m = utcMonth(new Date());
    return prisma.aiUsage.createMany({
      data: Array.from({ length: count }, () => ({ userId: ids[n], requestId: randomUUID(), period: m.key, status: 'USED' as const, expiresAt: new Date(), settledAt: new Date() })),
    });
  };

  beforeAll(async () => {
    Object.assign(process.env, ENV);
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule, RedisModule, AuthModule, BillingModule, UsersModule, MediaModule, RecipientsModule, AssistantModule, SupportModule],
    })
      .overrideProvider(StripeGateway)
      .useFactory({ factory: (config: ConfigService) => Object.assign(new StripeGateway(config), fake), inject: [ConfigService] })
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
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ rawBody: true });
    configureApp(app, new session.MemoryStore(), new session.MemoryStore());
    await app.init();
    prisma = app.get(PrismaService);
    usage = app.get(AiUsageService);
    const passwordHash = await argon2.hash('StrongPassword123!', { type: argon2.argon2id });
    for (const n of names) {
      ids[n] = (await prisma.user.create({ data: { email: emails[n], passwordHash, firstName: n, lastName: 'Test', role: 'CUSTOMER', emailVerifiedAt: new Date() }, select: { id: true } })).id;
      // Stripe customers this app created (as ensureCustomer would); cara's comes from her own Checkout below.
      if (n !== 'cara') await prisma.billingAccount.create({ data: { userId: ids[n], stripeCustomerId: customer(n), livemode: false } });
    }
    // held: an unmapped subscription synced before Step 6 (no tier, an unrecognised price at the time).
    await prisma.billingAccount.update({
      where: { userId: ids.held },
      data: { stripeSubscriptionId: `sub_t6_held_${run}`, plan: 'unknown', subscriptionStatus: 'active', currentPeriodEnd: new Date(run + 30 * DAY), syncedAt: new Date(run - DAY) },
    });
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

  it('Checkout: tier + interval only, the server picks the price; tampered inputs, unpriced and invalid prices are refused before Stripe', async () => {
    const offered = (await billing('cara')).checkoutOptions;
    expect(offered).toHaveLength(4);
    for (const body of [{ tier: 'COMPLETE', interval: 'monthly', price: PRICE.pm }, { tier: 'COMPLETE', interval: 'monthly', priceId: PRICE.cm }, { tier: 'complete', interval: 'monthly' }, { interval: 'annual' }, { tier: 'COMPLETE', interval: 'annual', metadata: { tier: 'COMPLETE' } }])
      await agents.cara.post(api('/billing/checkout')).send(body).expect(400);
    // A configured price that Stripe says is unusable: 503, logged for operators, no Checkout session.
    for (const bad of [{ active: false }, { recurring: { interval: 'month', interval_count: 1 } }, { livemode: true }, { type: 'one_time', recurring: null }] as Partial<Stripe.Price>[]) {
      priceOverrides.set(PRICE.ca, bad);
      await agents.cara.post(api('/billing/checkout')).send({ tier: 'COMPLETE', interval: 'annual' }).expect(503);
    }
    priceOverrides.clear();
    expect(fake.createCheckout).not.toHaveBeenCalled();
    expect(fake.createCustomer).not.toHaveBeenCalled();

    const [a, b] = await Promise.all([
      agents.cara.post(api('/billing/checkout')).send({ tier: 'COMPLETE', interval: 'annual' }),
      agents.cara.post(api('/billing/checkout')).send({ tier: 'COMPLETE', interval: 'annual' }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const calls = fake.createCheckout.mock.calls.map((c) => c[0] as { price: string; customer: string; idempotencyKey: string });
    expect(calls.map((c) => c.price)).toEqual([PRICE.ca, PRICE.ca]);
    expect(new Set(calls.map((c) => c.idempotencyKey)).size).toBe(1); // a double click is the same Stripe session
    expect(calls.every((c) => c.customer === customer('cara'))).toBe(true);
    expect(await prisma.billingAccount.count({ where: { userId: ids.cara } })).toBe(1);
  });

  it('the return before the webhook unlocks nothing; pending payment stores the tier but grants none of it; a verified payment activates every Complete policy', async () => {
    expect(await billing('cara')).toMatchObject({ state: 'trial_available', hasAccess: false, productTier: { tier: null } });
    await write('cara').expect(402);
    setSub(`sub_t6_cara_${run}`, 'cara', 'incomplete', [PRICE.ca]);
    await send(event('checkout.session.completed', { id: 'cs_t6', customer: customer('cara'), subscription: `sub_t6_cara_${run}` })).expect(200);
    expect(await billing('cara')).toMatchObject({ state: 'payment_pending', hasAccess: false, productTier: { tier: null }, subscription: { plan: 'annual', mapping: 'mapped' } });
    expect(await stored('cara')).toMatchObject({ tier: 'COMPLETE', plan: 'annual', priceUnresolved: false });
    await write('cara').expect(402);
    // Step 8 regression: no second Checkout while the first payment is unconfirmed (it could be paid twice).
    const before = fake.createCheckout.mock.calls.length;
    await agents.cara.post(api('/billing/checkout')).send({ tier: 'COMPLETE', interval: 'monthly' }).expect(409);
    expect(fake.createCheckout.mock.calls.length).toBe(before);

    setSub(`sub_t6_cara_${run}`, 'cara', 'active', [PRICE.ca]);
    const paid = event('invoice.paid', { id: 'in_t6', customer: customer('cara'), parent: { subscription_details: { subscription: `sub_t6_cara_${run}` } } });
    await send(paid).expect(200);
    const b = await billing('cara');
    expect(b).toMatchObject({ state: 'paid_active', hasAccess: true, productTier: { tier: 'COMPLETE', interval: 'annual', mapping: 'mapped' }, features: { mediaKinds: ['PHOTO', 'AUDIO', 'VIDEO'] } });
    expect(await storageLimit('cara')).toBe(5_000_000_000);
    expect(await usage.status(ids.cara)).toMatchObject({ metered: true, kind: 'month', allowance: 200, used: 0 });
    await write('cara').expect(201);
    // Duplicate delivery: processed once; a forged signature changes nothing.
    await send(paid).expect(200, { received: true, duplicate: true });
    await send(event('customer.subscription.updated', { id: `sub_t6_cara_${run}`, customer: customer('cara') }), 'whsec_wrong').expect(400);
    // Already subscribed: no second subscription.
    await agents.cara.post(api('/billing/checkout')).send({ tier: 'PREMIUM', interval: 'monthly' }).expect(409);
    // The audit row holds the tier and references only.
    const rows = await prisma.auditLog.findMany({ where: { eventType: 'SUBSCRIPTION_SYNCED', subjectId: ids.cara } });
    expect(rows.at(-1)!.metadata).toMatchObject({ tier: 'COMPLETE', plan: 'annual', priceMapping: 'mapped', priceUnresolved: false });
    expect(JSON.stringify(rows)).not.toMatch(/whsec|sk_test|card/);
  });

  it('an old subscription\'s late event never replaces the current one\'s tier; out-of-order events converge on Stripe\'s state', async () => {
    setSub(`sub_t6_cara_old_${run}`, 'cara', 'canceled', [PRICE.pm], { end: new Date(Date.now() - DAY), created: 1 });
    const res = await sync('cara', `sub_t6_cara_old_${run}`).expect(200);
    expect(res.body).toEqual({ received: true, superseded: true });
    expect(await stored('cara')).toMatchObject({ stripeSubscriptionId: `sub_t6_cara_${run}`, tier: 'COMPLETE', plan: 'annual' });
    // A late "created" event re-reads Stripe: still Complete, active.
    await send(event('customer.subscription.created', { id: `sub_t6_cara_${run}`, customer: customer('cara') })).expect(200);
    expect((await billing('cara')).productTier).toMatchObject({ tier: 'COMPLETE' });
  });

  it('each Premium mapping applies Premium policies; tier and interval changes keep this month\'s AI usage', async () => {
    const sub = `sub_t6_pete_${run}`;
    setSub(sub, 'pete', 'active', [PRICE.pm]);
    await sync('pete', sub).expect(200);
    expect(await billing('pete')).toMatchObject({ state: 'paid_active', productTier: { tier: 'PREMIUM', interval: 'monthly' }, features: { mediaKinds: ['PHOTO', 'AUDIO'] } });
    expect(await storageLimit('pete')).toBe(2_000_000_000);
    await prisma.recipient.createMany({ data: Array.from({ length: 10 }, (_, i) => ({ ownerUserId: ids.pete, firstName: `Seeded ${i}` })) });
    const over = await write('pete').expect(409);
    expect(over.body.code).toBe(PLAN_LIMIT);
    await useAi('pete', 60);
    expect(await usage.status(ids.pete)).toMatchObject({ allowance: 50, used: 60, remaining: 0 });

    setSub(sub, 'pete', 'active', [PRICE.cm]); // Premium → Complete: same month bucket, higher limit
    await sync('pete', sub).expect(200);
    expect((await billing('pete')).productTier).toMatchObject({ tier: 'COMPLETE', interval: 'monthly' });
    expect(await usage.status(ids.pete)).toMatchObject({ allowance: 200, used: 60, remaining: 140 });
    await write('pete').expect(201); // 11th recipient fits Complete's 50

    setSub(sub, 'pete', 'active', [PRICE.pa]); // Complete → Premium annual: usage kept, blocked again
    await sync('pete', sub).expect(200);
    expect((await billing('pete')).productTier).toMatchObject({ tier: 'PREMIUM', interval: 'annual' });
    expect(await usage.status(ids.pete)).toMatchObject({ kind: 'month', allowance: 50, used: 60, remaining: 0 });
    expect(await prisma.aiUsage.count({ where: { userId: ids.pete } })).toBe(60); // no new bucket, nothing reset
  });

  it('payment issues and scheduled cancellation keep the tier; ended access keeps the stored tier but locks every part of it', async () => {
    const sub = `sub_t6_pete_${run}`;
    const future = new Date(Date.now() + DAY);
    setSub(sub, 'pete', 'past_due', [PRICE.pa], { end: future });
    await sync('pete', sub).expect(200);
    expect(await billing('pete')).toMatchObject({ state: 'payment_issue', hasAccess: true, productTier: { tier: 'PREMIUM' } });
    setSub(sub, 'pete', 'active', [PRICE.pa], { end: future, cancel: true });
    await sync('pete', sub).expect(200);
    expect(await billing('pete')).toMatchObject({ state: 'cancellation_scheduled', hasAccess: true, productTier: { tier: 'PREMIUM' } });
    setSub(sub, 'pete', 'canceled', [PRICE.pa], { end: future });
    await sync('pete', sub).expect(200);
    const b = await billing('pete');
    expect(b).toMatchObject({ state: 'access_ended', hasAccess: false, productTier: { tier: null } });
    expect(await stored('pete')).toMatchObject({ tier: 'PREMIUM' }); // stored, not in force
    expect(await usage.status(ids.pete)).toMatchObject({ metered: false, reason: 'no_access' });
    expect((await write('pete').expect(402)).body.code).toBe('PLAN_ENDED');
  });

  it('a legacy price keeps the existing unmapped behaviour: access, its interval, no tier, no tier limits', async () => {
    const sub = `sub_t6_leg_${run}`;
    setSub(sub, 'leg', 'active', [PRICE.legacy]);
    await sync('leg', sub).expect(200);
    expect(await billing('leg')).toMatchObject({ state: 'paid_active', hasAccess: true, productTier: { tier: null, interval: 'monthly', mapping: 'unmapped' }, subscription: { plan: 'monthly', mapping: 'unmapped' } });
    expect(await storageLimit('leg')).toBe(7_000_000_000); // the configured default, unchanged
    expect(await usage.status(ids.leg)).toMatchObject({ metered: false, reason: 'unmapped_paid' });
    await write('leg').expect(201);
  });

  it('an unknown price on a new subscription is unresolved: no tier, no paid access, a diagnostic, and no second Checkout', async () => {
    const sub = `sub_t6_unk_${run}`;
    setSub(sub, 'unk', 'active', [PRICE.other]);
    await sync('unk', sub).expect(200);
    const b = await billing('unk');
    expect(b).toMatchObject({ state: 'plan_unresolved', hasAccess: false, productTier: { tier: null }, subscription: { plan: 'unknown', mapping: 'unresolved' } });
    expect(await stored('unk')).toMatchObject({ tier: null, priceUnresolved: true, subscriptionStatus: 'active' });
    expect((await write('unk').expect(402)).body.code).toBe('PLAN_UNRESOLVED');
    await agents.unk.get(api('/recipients')).expect(200); // reads stay open
    await agents.unk.post(api('/billing/checkout')).send({ tier: 'COMPLETE', interval: 'monthly' }).expect(409);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { eventType: 'SUBSCRIPTION_SYNCED', subjectId: ids.unk } });
    expect(audit.metadata).toMatchObject({ priceMapping: 'unknown', priceUnresolved: true, tier: null });
    // Fixing the subscription in Stripe resolves it on the next event.
    setSub(sub, 'unk', 'active', [PRICE.cm]);
    await sync('unk', sub).expect(200);
    expect(await billing('unk')).toMatchObject({ state: 'paid_active', hasAccess: true, productTier: { tier: 'COMPLETE' } });
  });

  it('several items or another quantity are ambiguous: a known mapping is not overwritten with a default and is not in force', async () => {
    const sub = `sub_t6_amb_${run}`;
    setSub(sub, 'amb', 'active', [PRICE.cm]);
    await sync('amb', sub).expect(200);
    expect((await billing('amb')).productTier).toMatchObject({ tier: 'COMPLETE' });
    setSub(sub, 'amb', 'active', [PRICE.cm, PRICE.pm]);
    await sync('amb', sub).expect(200);
    expect(await billing('amb')).toMatchObject({ state: 'plan_unresolved', hasAccess: false, productTier: { tier: null } });
    expect(await stored('amb')).toMatchObject({ tier: 'COMPLETE', priceUnresolved: true }); // kept as stored, not guessed
    setSub(sub, 'amb', 'active', [PRICE.cm], { quantity: 2 });
    await sync('amb', sub).expect(200);
    expect((await billing('amb')).state).toBe('plan_unresolved');
  });

  it('close-out: a retained COMPLETE tier cannot bypass PLAN_UNRESOLVED (storage, recipients, media, AI); reads, deletes, billing, support, account stay open', async () => {
    // amb is unresolved (previous test) with tier COMPLETE still stored.
    expect(await stored('amb')).toMatchObject({ tier: 'COMPLETE', priceUnresolved: true });
    const b = await billing('amb');
    expect(b).toMatchObject({ state: 'plan_unresolved', hasAccess: false, productTier: { tier: null }, features: { media: true } });
    expect(b.features.mediaKinds).toEqual(expect.arrayContaining(['PHOTO']));
    expect(await storageLimit('amb')).toBe(7_000_000_000); // the configured default, never Complete's 5 GB
    expect(await usage.status(ids.amb)).toMatchObject({ metered: false, reason: 'no_access' });
    const rid = (await prisma.recipient.create({ data: { ownerUserId: ids.amb, firstName: 'Kept' }, select: { id: true } })).id;
    const refused = [
      await write('amb'),
      await agents.amb.post(api(`/recipients/${rid}/photo/upload-url`)).send({ kind: 'PHOTO', mimeType: 'image/jpeg', sizeBytes: 1000, originalFileName: 'x.jpg' }),
      await agents.amb.post(api(`/messages/${randomUUID()}/media/upload-url`)).send({ kind: 'VIDEO', mimeType: 'video/mp4', sizeBytes: 1000, originalFileName: 'x.mp4' }),
      await agents.amb.post(api('/assistant/reply')).send({ page: 'my-story', action: 'ask', message: 'Fictional question' }),
      await agents.amb.patch(api(`/recipients/${rid}`)).send({ firstName: 'Changed' }),
    ];
    const labels = ['recipient create', 'recipient photo', 'media upload', 'assistant reply', 'recipient edit'];
    expect(refused.map((r, i) => [labels[i], r.status, r.body.code])).toEqual(labels.map((l) => [l, 402, 'PLAN_UNRESOLVED']));
    // The refusal never tells the customer to buy again.
    expect(refused[0]!.body.message).toBe(PLAN_UNRESOLVED_MESSAGE);
    expect(refused.every((r) => !/choose a plan|purchase|subscribe/i.test(r.body.message))).toBe(true);
    expect(await prisma.recipient.count({ where: { ownerUserId: ids.amb, deletedAt: null } })).toBe(1);
    // Open: reads, delete, billing (plan page, portal), support, account settings.
    await agents.amb.get(api('/recipients')).expect(200);
    await agents.amb.get(api('/users/me/storage')).expect(200);
    await agents.amb.post(api('/billing/portal')).expect(200);
    const ticket = await agents.amb.post(api('/support/requests')).send({ clientRequestId: randomUUID(), subject: 'Plan question', category: 'ACCOUNT_ACCESS', description: 'A fictional support request about my plan.' });
    expect(ticket.status).toBe(201);
    await agents.amb.patch(api('/users/me')).send({ firstName: 'Renamed' }).expect(200);
    await agents.amb.delete(api(`/recipients/${rid}`)).expect((r) => expect([200, 204]).toContain(r.status));
  });

  it('close-out: a transient Stripe failure is never stored as an unknown price; a valid sync clears the flag and restores access', async () => {
    const sub = `sub_t6_amb_${run}`;
    const fixed = () => setSub(sub, 'amb', 'active', [PRICE.cm]);
    fixed();
    // The list fails: 500, nothing recorded or changed, so Stripe retries.
    fake.listSubscriptions.mockRejectedValueOnce(new Error('stripe unreachable (fake)'));
    const ev = event('customer.subscription.updated', { id: sub, customer: customer('amb') });
    await send(ev).expect(500);
    expect(await prisma.stripeEvent.count({ where: { id: ev.id } })).toBe(0);
    expect(await stored('amb')).toMatchObject({ priceUnresolved: true, tier: 'COMPLETE' });
    // A mapped account hitting an outage keeps its mapping (no unresolved flag from an error).
    const caraBefore = await stored('cara');
    fake.listSubscriptions.mockRejectedValueOnce(new Error('timeout (fake)'));
    await sync('cara', `sub_t6_cara_${run}`).expect(500);
    fake.listSubscriptions.mockResolvedValueOnce([]); // the named subscription missing from the list → retrieved...
    fake.retrieveSubscription.mockRejectedValueOnce(new Error('network (fake)')); // ...and that read fails too
    await sync('cara', `sub_t6_cara_${run}`).expect(500);
    expect(await stored('cara')).toMatchObject({ tier: caraBefore.tier, plan: caraBefore.plan, priceUnresolved: false, syncedAt: caraBefore.syncedAt });
    // Malformed data that Stripe did return (an item without a price) is a real, stored answer: unresolved.
    setSub(sub, 'amb', 'active', [null as unknown as string]);
    await sync('amb', sub).expect(200);
    expect((await stored('amb')).priceUnresolved).toBe(true);
    // The retry with a valid configured price: flag cleared, Complete back in force.
    fixed();
    await send(ev).expect(200);
    expect(await stored('amb')).toMatchObject({ priceUnresolved: false, tier: 'COMPLETE', plan: 'monthly' });
    expect(await billing('amb')).toMatchObject({ state: 'paid_active', hasAccess: true, productTier: { tier: 'COMPLETE' }, subscription: { mapping: 'mapped' } });
    expect(await storageLimit('amb')).toBe(5_000_000_000);
    expect(await usage.status(ids.amb)).toMatchObject({ metered: true, allowance: 200 });
    await write('amb').expect(201);
    // Sign-out works in any state.
    await agents.amb.post(api('/auth/logout')).expect((r) => expect(r.status).toBeLessThan(300));
  });

  it('the unmapped subscription an account already held keeps its access when its price is still unknown', async () => {
    const sub = `sub_t6_held_${run}`;
    setSub(sub, 'held', 'active', [PRICE.other]);
    await sync('held', sub).expect(200);
    expect(await billing('held')).toMatchObject({ state: 'paid_active', hasAccess: true, productTier: { tier: null, mapping: 'unmapped' }, subscription: { mapping: 'unmapped' } });
    expect(await stored('held')).toMatchObject({ tier: null, priceUnresolved: false });
    await write('held').expect(201);
    // A replacement subscription on an unknown price is new, so it is unresolved.
    setSub(sub, 'held', 'canceled', [PRICE.other], { end: new Date(Date.now() - DAY) });
    setSub(`sub_t6_held_new_${run}`, 'held', 'active', [PRICE.other]);
    await sync('held', `sub_t6_held_new_${run}`).expect(200);
    expect((await billing('held')).state).toBe('plan_unresolved');
  });

  it('a stored tier on a non-entitled account opens nothing; webhooks never read client metadata for the tier', async () => {
    await prisma.billingAccount.update({ where: { userId: ids.lock }, data: { tier: 'COMPLETE', plan: 'annual', subscriptionStatus: 'incomplete' } });
    expect(await billing('lock')).toMatchObject({ state: 'payment_pending', hasAccess: false, productTier: { tier: null } });
    await write('lock').expect(402);
    const sub = `sub_t6_lock_${run}`;
    subs.set(sub, { ...(setSub(sub, 'lock', 'active', [PRICE.other]).get(sub) as object), metadata: { tier: 'COMPLETE' } } as unknown as Stripe.Subscription);
    await send(event('checkout.session.completed', { id: 'cs_t6_lock', customer: customer('lock'), subscription: sub, metadata: { tier: 'COMPLETE' } })).expect(200);
    expect(await billing('lock')).toMatchObject({ state: 'plan_unresolved', hasAccess: false, productTier: { tier: null } });
  });
});
