import { ConfigModule, ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import session from 'express-session';
import { randomUUID } from 'node:crypto';
import Stripe from 'stripe';
import request from 'supertest';
import { adminSignIn } from './admin-sign-in.js';
import { AdminModule } from '../src/admin/admin.module.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { accessState, accessStateWhere, ADMIN_BILLING_FILTERS } from '../src/billing/billing-access.js';
import { BillingModule } from '../src/billing/billing.module.js';
import { BillingService } from '../src/billing/billing.service.js';
import { StripeGateway } from '../src/billing/stripe-gateway.js';
import { configureApp } from '../src/config/app.setup.js';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { RecipientsModule } from '../src/recipients/recipients.module.js';
import { RedisModule } from '../src/redis/redis.module.js';

// Step 10 billing on real HTTP, sessions, PostgreSQL and the real Stripe
// signature check. Stripe API calls are fakes: nothing reaches Stripe, nothing
// is charged. Fictional people only.
const WHSEC = 'whsec_test_fictional_secret_for_e2e';
describe('Billing (e2e, PostgreSQL, Stripe mocked)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const run = Date.now();
  const at = (n: string) => `billing.${n}.${run}@example.test`;
  const emails = { ana: at('ana'), ben: at('ben'), old: at('old'), admin: at('admin'), root: at('root') };
  const password = 'StrongPassword123!';
  type Agent = ReturnType<typeof request.agent>;
  const agents = {} as Record<'ana' | 'ben' | 'old' | 'admin' | 'root', Agent>;
  const ids = {} as Record<string, string>;
  const subs = new Map<string, Stripe.Subscription>(); // the fake Stripe's current subscriptions
  const fake = {
    createCustomer: vi.fn(async (userId: string) => ({ id: `cus_${userId.slice(0, 8)}${run}`, livemode: false }) as Stripe.Customer),
    createCheckout: vi.fn(async (input: unknown) => input && ({ url: 'https://checkout.stripe.example/c/test_session' }) as Stripe.Checkout.Session),
    createPortal: vi.fn(async () => ({ url: 'https://billing.stripe.example/p/test' }) as Stripe.BillingPortal.Session),
    retrieveSubscription: vi.fn(async (id: string) => {
      const s = subs.get(id);
      if (!s) throw new Error('No such subscription (fake)');
      return s;
    }),
    listSubscriptions: vi.fn(async (customer: string) => [...subs.values()].filter((s) => s.customer === customer).reverse()),
  };
  const api = (p: string) => `/api/v1${p}`;
  const signIn = async (email: string) => {
    const agent = request.agent(app.getHttpServer());
    await agent.post(api('/auth/login')).send({ email, password }).expect(200);
    return agent;
  };
  const fakeSub = (id: string, customer: string, status: string, periodEnd: Date, cancelAtPeriodEnd = false, price = 'price_monthly_test') =>
    subs.set(id, {
      id,
      object: 'subscription',
      customer,
      status,
      livemode: false,
      cancel_at_period_end: cancelAtPeriodEnd,
      items: { data: [{ price: { id: price }, current_period_end: Math.floor(periodEnd.getTime() / 1000) }] },
    } as unknown as Stripe.Subscription);
  const send = (event: object, secret = WHSEC) => {
    const payload = JSON.stringify(event);
    const header = Stripe.webhooks.generateTestHeaderString({ payload, secret });
    return request(app.getHttpServer()).post(api('/webhooks/stripe')).set('Stripe-Signature', header).set('Content-Type', 'application/json').send(payload);
  };
  const event = (type: string, object: object, over: object = {}) => ({
    id: `evt_${randomUUID().replace(/-/g, '')}`,
    object: 'event',
    type,
    livemode: false,
    created: Math.floor(Date.now() / 1000),
    data: { object },
    ...over,
  });
  const status = async (agent: Agent) => (await agent.get(api('/billing')).expect(200)).body;
  const write = (agent: Agent) => agent.post(api('/recipients')).send({ firstName: 'Mia' });

  beforeAll(async () => {
    Object.assign(process.env, {
      BILLING_ENABLED: 'true',
      BILLING_ENFORCE_FROM: new Date(run - 60_000).toISOString(),
      STRIPE_SECRET_KEY: 'sk_test_fictional_not_a_real_key',
      STRIPE_WEBHOOK_SECRET: WHSEC,
      STRIPE_PRICE_MONTHLY: 'price_monthly_test',
      STRIPE_PRICE_ANNUAL: 'price_annual_test',
      THROTTLE_KEY_PREFIX: `for_after:test_billing_throttle:${run}:`,
    });
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule, RedisModule, AuthModule, BillingModule, RecipientsModule, AdminModule],
    })
      .overrideProvider(StripeGateway)
      .useFactory({
        factory: (config: ConfigService) => Object.assign(new StripeGateway(config), fake),
        inject: [ConfigService],
      })
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ rawBody: true });
    configureApp(app, new session.MemoryStore(), new session.MemoryStore());
    await app.init();
    prisma = app.get(PrismaService);
    for (const [k, email] of Object.entries(emails)) {
      await request(app.getHttpServer()).post(api('/auth/register')).send({ email, password, firstName: k, lastName: 'Test' }).expect(201);
      ids[k] = (await prisma.user.findUniqueOrThrow({ where: { email } })).id;
    }
    // An account from before billing enforcement (rollout rule).
    await prisma.user.update({ where: { id: ids.old }, data: { createdAt: new Date(run - 86_400_000) } });
    await prisma.user.updateMany({ where: { email: { in: [emails.ana, emails.ben, emails.old, emails.admin, emails.root] } }, data: { emailVerifiedAt: new Date() } });
    await prisma.user.update({ where: { id: ids.admin }, data: { role: 'ADMIN' } });
    await prisma.user.update({ where: { id: ids.root }, data: { role: 'SUPER_ADMIN' } });
    agents.ana = await signIn(emails.ana);
    agents.ben = await signIn(emails.ben);
    agents.old = await signIn(emails.old);
    agents.admin = (await adminSignIn(app, emails.admin, password)).agent;
    agents.root = (await adminSignIn(app, emails.root, password)).agent;
  });

  afterAll(async () => {
    for (const k of ['BILLING_ENABLED', 'BILLING_ENFORCE_FROM', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_PRICE_MONTHLY', 'STRIPE_PRICE_ANNUAL', 'THROTTLE_KEY_PREFIX'])
      delete process.env[k];
    await prisma?.user.deleteMany({ where: { email: { in: Object.values(emails) } } });
    await prisma?.user.deleteMany({ where: { email: { startsWith: `billing.fx.${run}.` } } });
    await app?.close();
  });

  it('a new account must start a trial: content writes are refused (402), reading and the plan page are not; no-store', async () => {
    const res = await agents.ana.get(api('/billing')).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({ enabled: true, state: 'trial_available', hasAccess: false, trialEligible: true, trial: null, subscription: null, plans: ['monthly', 'annual'] });
    expect(JSON.stringify(res.body)).not.toMatch(/sk_test|whsec|cus_|price_/);
    await write(agents.ana).expect(402);
    await agents.ana.get(api('/recipients')).expect(200);
    await request(app.getHttpServer()).get(api('/billing')).expect(401);
    await agents.admin.get(api('/billing')).expect(401); // admins are not Customers
  });

  it('trial: server dates (7 days), one per account under concurrency, retries return the same trial, audited; a GET never starts one', async () => {
    expect(await prisma.customerTrial.count({ where: { userId: ids.ana } })).toBe(0);
    const forged = { userId: ids.ben, endsAt: '2099-01-01T00:00:00Z', startedAt: '2000-01-01T00:00:00Z' };
    const [a, b] = await Promise.all([
      agents.ana.post(api('/billing/trial')).send(forged),
      agents.ana.post(api('/billing/trial')).send({}),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const trials = await prisma.customerTrial.findMany({ where: { userId: ids.ana } });
    expect(trials).toHaveLength(1);
    expect(trials[0]!.endsAt.getTime() - trials[0]!.startedAt.getTime()).toBe(7 * 86_400_000);
    expect(trials[0]!.endsAt.getFullYear()).not.toBe(2099);
    expect(await prisma.customerTrial.count({ where: { userId: ids.ben } })).toBe(0); // forged owner ignored
    const again = await agents.ana.post(api('/billing/trial')).expect(200);
    expect(again.body.trial).toEqual(a.body.trial);
    expect(again.body).toMatchObject({ state: 'trial_active', hasAccess: true, trialEligible: false });
    expect(await prisma.auditLog.count({ where: { eventType: 'TRIAL_STARTED', subjectId: ids.ana } })).toBe(1);
    await write(agents.ana).expect(201);
  });

  it('expiry needs no scheduler: past the end instant writes are refused, reads and support stay; no second trial; nothing deleted', async () => {
    await prisma.customerTrial.update({ where: { userId: ids.ana }, data: { endsAt: new Date(Date.now() - 1000) } });
    expect(await status(agents.ana)).toMatchObject({ state: 'trial_expired', hasAccess: false, trialEligible: false });
    const blocked = await write(agents.ana).expect(402);
    expect(blocked.body.message).toMatch(/Choose a plan/);
    expect((await agents.ana.get(api('/recipients')).expect(200)).body).toBeDefined();
    expect(await prisma.recipient.count({ where: { ownerUserId: ids.ana, deletedAt: null } })).toBe(1);
    // Asking again returns the same (expired) trial: no restart, no extension.
    const again = await agents.ana.post(api('/billing/trial')).expect(200);
    expect(again.body).toMatchObject({ state: 'trial_expired', hasAccess: false });
    expect(await prisma.customerTrial.count({ where: { userId: ids.ana } })).toBe(1);
  });

  it('accounts created before enforcement keep access and get no trial (rollout rule)', async () => {
    expect(await status(agents.old)).toMatchObject({ state: 'no_billing_record', hasAccess: true, trialEligible: false });
    await write(agents.old).expect(201);
    await agents.old.post(api('/billing/trial')).expect(409);
  });

  it('checkout: allowlisted plan → configured price and fixed return URLs; one Stripe customer per account; the success URL grants nothing', async () => {
    await agents.ana.post(api('/billing/checkout')).send({ plan: 'weekly' }).expect(400);
    await agents.ana.post(api('/billing/checkout')).send({ plan: 'monthly', price: 'price_free', amount: 0 }).expect(400);
    const res = await agents.ana.post(api('/billing/checkout')).send({ plan: 'monthly' }).expect(200);
    expect(res.body).toEqual({ url: 'https://checkout.stripe.example/c/test_session' });
    await agents.ana.post(api('/billing/checkout')).send({ plan: 'annual' }).expect(200);
    expect(fake.createCustomer).toHaveBeenCalledTimes(1);
    const args = fake.createCheckout.mock.calls.map((c) => c[0] as { price: string; successUrl: string; cancelUrl: string; idempotencyKey: string });
    expect(args.map((a) => a.price)).toEqual(['price_monthly_test', 'price_annual_test']);
    expect(args[0]!.successUrl).toMatch(/\/settings\/plan\?checkout=success$/);
    expect(args[0]!.idempotencyKey).toMatch(new RegExp(`^checkout-${ids.ana}-monthly-\\d+$`));
    // Returning to the success URL is just a page: still no access until a verified webhook.
    expect(await status(agents.ana)).toMatchObject({ state: 'trial_expired', hasAccess: false });
  });

  it('webhooks: unsigned, forged, wrong-environment and foreign events change nothing', async () => {
    const acct = await prisma.billingAccount.findUniqueOrThrow({ where: { userId: ids.ana } });
    fakeSub('sub_ana1', acct.stripeCustomerId, 'active', new Date(Date.now() + 30 * 86_400_000));
    const ev = event('customer.subscription.updated', { id: 'sub_ana1', customer: acct.stripeCustomerId });
    await request(app.getHttpServer()).post(api('/webhooks/stripe')).send(ev).expect(400); // no signature
    await send(ev, 'whsec_wrong').expect(400);
    await send({ ...ev, livemode: true }).expect(400);
    // A customer this app never created: acknowledged, ignored.
    await send(event('customer.subscription.updated', { id: 'sub_other', customer: 'cus_not_ours' })).expect(200, { received: true, ignored: true });
    // A subscription that belongs to someone else: refused, not recorded (Stripe would retry).
    fakeSub('sub_foreign', 'cus_someone_else', 'active', new Date(Date.now() + 86_400_000));
    const foreign = event('customer.subscription.updated', { id: 'sub_foreign', customer: acct.stripeCustomerId });
    await send(foreign).expect(400);
    expect(await prisma.stripeEvent.count({ where: { id: foreign.id } })).toBe(0);
    expect(await status(agents.ana)).toMatchObject({ state: 'trial_expired', hasAccess: false });
  });

  it('webhooks: pending payment grants nothing; verified active grants access; duplicates, retries and out-of-order events converge', async () => {
    const acct = await prisma.billingAccount.findUniqueOrThrow({ where: { userId: ids.ana } });
    const periodEnd = new Date(Date.now() + 30 * 86_400_000);
    fakeSub('sub_ana1', acct.stripeCustomerId, 'incomplete', periodEnd);
    await send(event('checkout.session.completed', { id: 'cs_1', customer: acct.stripeCustomerId, subscription: 'sub_ana1' })).expect(200);
    expect(await status(agents.ana)).toMatchObject({ state: 'payment_pending', hasAccess: false });

    // A failed fetch from Stripe: 500, not recorded, so Stripe's retry can still apply it.
    fake.listSubscriptions.mockRejectedValueOnce(new Error('stripe down'));
    fakeSub('sub_ana1', acct.stripeCustomerId, 'active', periodEnd);
    const paid = event('invoice.paid', { id: 'in_1', customer: acct.stripeCustomerId, parent: { subscription_details: { subscription: 'sub_ana1' } } });
    await send(paid).expect(500);
    expect(await prisma.stripeEvent.count({ where: { id: paid.id } })).toBe(0);
    expect((await status(agents.ana)).hasAccess).toBe(false); // an outage never grants access
    await send(paid).expect(200);
    const s = await status(agents.ana);
    expect(s).toMatchObject({ state: 'paid_active', hasAccess: true, subscription: { plan: 'monthly', cancelAtPeriodEnd: false } });
    expect(Date.parse(s.subscription.currentPeriodEnd)).toBe(Math.floor(periodEnd.getTime() / 1000) * 1000);
    await write(agents.ana).expect(201);

    // The same event again, and two deliveries at once: processed exactly once.
    const audits = () => prisma.auditLog.count({ where: { eventType: 'SUBSCRIPTION_SYNCED', subjectId: ids.ana } });
    const before = await audits();
    await send(paid).expect(200, { received: true, duplicate: true });
    const twice = event('customer.subscription.updated', { id: 'sub_ana1', customer: acct.stripeCustomerId });
    await Promise.all([send(twice), send(twice)]);
    expect(await audits()).toBe(before + 1);
    // An old "incomplete" event arriving late re-reads the current state: still paid.
    await send(event('customer.subscription.created', { id: 'sub_ana1', customer: acct.stripeCustomerId }, { created: 1 })).expect(200);
    expect((await status(agents.ana)).state).toBe('paid_active');
    // The audit holds states and references only.
    const rows = await prisma.auditLog.findMany({ where: { eventType: 'SUBSCRIPTION_SYNCED', subjectId: ids.ana } });
    expect(rows[0]).toMatchObject({ actorType: 'SYSTEM', actorUserId: null });
    expect(JSON.stringify(rows)).not.toMatch(/whsec|sk_test|card|checkout\.stripe/);
  });

  it('cancellation scheduled keeps access until the period ends; payment issue keeps access; ended removes it', async () => {
    const acct = await prisma.billingAccount.findUniqueOrThrow({ where: { userId: ids.ana } });
    const sync = async (statusName: string, end: Date, cancel = false) => {
      fakeSub('sub_ana1', acct.stripeCustomerId, statusName, end, cancel);
      await send(event('customer.subscription.updated', { id: 'sub_ana1', customer: acct.stripeCustomerId })).expect(200);
      return status(agents.ana);
    };
    const future = new Date(Date.now() + 86_400_000);
    expect(await sync('active', future, true)).toMatchObject({ state: 'cancellation_scheduled', hasAccess: true });
    expect(await sync('past_due', future)).toMatchObject({ state: 'payment_issue', hasAccess: true });
    expect(await sync('canceled', future)).toMatchObject({ state: 'access_ended', hasAccess: false });
    await write(agents.ana).expect(402);
    expect(await prisma.recipient.count({ where: { ownerUserId: ids.ana, deletedAt: null } })).toBe(2); // nothing deleted
    // The plan page can still start a new checkout; a portal needs a subscription.
    await agents.ana.post(api('/billing/portal')).expect(200);
    await agents.ben.post(api('/billing/portal')).expect(404);
  });

  it('admin: billing is SUPER_ADMIN only; filters map to the same states; Users shows the summary to SUPER_ADMIN only', async () => {
    await agents.admin.get(api('/admin/billing/accounts')).expect(403);
    await agents.ana.get(api('/admin/billing/accounts')).expect(401);
    const all = await agents.root.get(api('/admin/billing/accounts')).query({ limit: 100 }).expect(200);
    expect(all.headers['cache-control']).toBe('no-store');
    const mine = all.body.items.find((i: { accountId: string }) => i.accountId === ids.ana);
    expect(mine).toMatchObject({ state: 'access_ended', subscriptionStatus: 'canceled', plan: 'monthly', subscriptionReference: 'sub_ana1' });
    expect(JSON.stringify(all.body)).not.toMatch(/cus_|whsec|sk_test|card/);
    // ben never started anything: not a billing row.
    expect(all.body.items.some((i: { accountId: string }) => i.accountId === ids.ben)).toBe(false);
    const ended = await agents.root.get(api('/admin/billing/accounts')).query({ state: 'access_ended', accountId: ids.ana }).expect(200);
    expect(ended.body.items).toHaveLength(1);
    expect((await agents.root.get(api('/admin/billing/accounts')).query({ state: 'trial_active', accountId: ids.ana }).expect(200)).body.items).toEqual([]);
    await agents.root.get(api('/admin/billing/accounts')).query({ state: 'free' }).expect(400);
    await agents.root.get(api('/admin/billing/accounts')).query({ subscriptionReference: 'drop table' }).expect(400);

    const rootUser = (await agents.root.get(api(`/admin/users/${ids.ana}`)).expect(200)).body;
    expect(rootUser.billing).toMatchObject({ state: 'access_ended' });
    const benUser = (await agents.root.get(api(`/admin/users/${ids.ben}`)).expect(200)).body;
    expect(benUser.billing).toMatchObject({ state: 'trial_available', trialEndsAt: null });
    const adminView = (await agents.admin.get(api(`/admin/users/${ids.ana}`)).expect(200)).body;
    expect(adminView).not.toHaveProperty('billing');
    const list = (await agents.admin.get(api('/admin/users')).query({ search: emails.ana }).expect(200)).body;
    expect(list.items[0]).not.toHaveProperty('billing');
  });

  it('the gate reads the matched route, so the spelling of the URL cannot avoid it; reads and deletes stay open', async () => {
    // Express routes case-insensitively: this really reaches the recipients controller.
    await agents.old.post(api('/RECIPIENTS')).send({ firstName: 'Upper' }).expect(201);
    expect((await status(agents.ana)).hasAccess).toBe(false);
    await agents.ana.post(api('/RECIPIENTS')).send({ firstName: 'Upper' }).expect(402);
    await agents.ana.post(api('/Recipients/')).send({ firstName: 'Upper' }).expect(402);
    await agents.ana.post(api('/recipients?x=1')).send({ firstName: 'Upper' }).expect(402);
    const [mine] = (await agents.ana.get(api('/RECIPIENTS')).expect(200)).body.items as { id: string }[];
    await agents.ana.get(api(`/recipients/${mine!.id}`)).expect(200);
    await agents.ana.patch(api(`/recipients/${mine!.id}`)).send({ firstName: 'Changed' }).expect(402);
    await agents.ana.delete(api(`/recipients/${mine!.id}`)).expect((r) => expect(r.status).toBeLessThan(300));
    await agents.ana.post(api('/billing/portal')).expect(200); // billing stays open
  });

  describe('which subscription the account holds, and concurrent syncs', () => {
    const future = () => new Date(Date.now() + 30 * 86_400_000);
    let n = 0;
    const account = async () => {
      n += 1;
      const email = `billing.fx.${run}.sync${n}@example.test`;
      const { id } = await prisma.user.create({ data: { email, passwordHash: 'x', role: 'CUSTOMER', emailVerifiedAt: new Date() }, select: { id: true } });
      const customer = `cus_sync${n}${run}`;
      await prisma.billingAccount.create({ data: { userId: id, stripeCustomerId: customer, livemode: false } });
      return { id, customer };
    };
    const updated = (subscription: string, customer: string) => event('customer.subscription.updated', { id: subscription, customer });
    const stored = (userId: string) => prisma.billingAccount.findUniqueOrThrow({ where: { userId } });
    const audits = (userId: string) => prisma.auditLog.count({ where: { eventType: 'SUBSCRIPTION_SYNCED', subjectId: userId } });
    const state = async (userId: string) => (await app.get(BillingService).status(userId)).state;
    const tag = () => `${run}${(n += 1)}`;

    it('an old subscription\'s late events never displace the replacement; recording them changes nothing and audits nothing', async () => {
      const { id, customer } = await account();
      const [a, b] = [`sub_a${tag()}`, `sub_b${tag()}`];
      fakeSub(a, customer, 'active', future());
      await send(updated(a, customer)).expect(200);
      expect(await stored(id)).toMatchObject({ stripeSubscriptionId: a, subscriptionStatus: 'active' });

      // The replacement: the first one lapsed, a new checkout succeeded.
      fakeSub(a, customer, 'past_due', new Date(Date.now() - 1000));
      fakeSub(b, customer, 'active', future());
      await send(event('checkout.session.completed', { id: 'cs_x', customer, subscription: b })).expect(200);
      expect(await stored(id)).toMatchObject({ stripeSubscriptionId: b, subscriptionStatus: 'active' });
      const before = await audits(id);

      // Dunning finishes on the old one, delivered after the replacement.
      fakeSub(a, customer, 'canceled', new Date(Date.now() - 1000));
      for (const late of [updated(a, customer), event('customer.subscription.deleted', { id: a, customer }), event('invoice.payment_failed', { id: 'in_x', customer, subscription: a })]) {
        await send(late).expect(200, { received: true, superseded: true });
        expect(await prisma.stripeEvent.count({ where: { id: late.id } })).toBe(1);
      }
      expect(await stored(id)).toMatchObject({ stripeSubscriptionId: b, subscriptionStatus: 'active' });
      expect(await state(id)).toBe('paid_active');
      expect(await audits(id)).toBe(before);
    });

    it('legitimate transitions still apply: renewal, scheduled cancellation, cancellation, then falling back to what is left', async () => {
      const { id, customer } = await account();
      const [a, b] = [`sub_a${tag()}`, `sub_b${tag()}`];
      fakeSub(a, customer, 'incomplete', future());
      await send(updated(a, customer)).expect(200);
      expect(await state(id)).toBe('payment_pending');
      const renewal = future();
      fakeSub(a, customer, 'active', renewal);
      await send(event('invoice.paid', { id: 'in_1', customer, subscription: a })).expect(200);
      expect((await stored(id)).currentPeriodEnd!.getTime()).toBe(Math.floor(renewal.getTime() / 1000) * 1000);
      fakeSub(a, customer, 'active', renewal, true);
      await send(updated(a, customer)).expect(200);
      expect(await state(id)).toBe('cancellation_scheduled');
      // A second, active subscription outranks the one that is cancelling, whichever event says so.
      fakeSub(b, customer, 'active', renewal);
      await send(updated(a, customer)).expect(200);
      const audit = await prisma.auditLog.findFirstOrThrow({ where: { eventType: 'SUBSCRIPTION_SYNCED', subjectId: id }, orderBy: { createdAt: 'desc' } });
      expect(audit.metadata).toMatchObject({ eventSubscriptionCurrent: false, subscriptionReplaced: true, newStatus: 'active' });
      expect(await stored(id)).toMatchObject({ stripeSubscriptionId: b, cancelAtPeriodEnd: false });
      // Cancelled for good: no entitled subscription left, so the account says so.
      fakeSub(b, customer, 'canceled', renewal);
      fakeSub(a, customer, 'canceled', renewal);
      await send(updated(b, customer)).expect(200);
      expect(await state(id)).toBe('access_ended');
    });

    it('a slow sync holding older Stripe data cannot overwrite a newer commit, even if it finishes last; it re-reads', async () => {
      const { id, customer } = await account();
      const a = `sub_a${tag()}`;
      fakeSub(a, customer, 'active', future());
      await send(updated(a, customer)).expect(200);
      const audited = await audits(id);

      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let read!: () => void;
      const hasRead = new Promise<void>((r) => (read = r));
      const stale = [...subs.values()].filter((s) => s.customer === customer);
      fake.listSubscriptions.mockImplementationOnce(async () => {
        read();
        await gate; // this response is delayed, and already out of date when it lands
        return stale;
      });
      const slowEvent = updated(a, customer);
      const slow = send(slowEvent).then((r) => r);
      await hasRead;

      fakeSub(a, customer, 'canceled', new Date(Date.now() - 1000));
      await send(updated(a, customer)).expect(200);
      expect(await stored(id)).toMatchObject({ subscriptionStatus: 'canceled' });

      release();
      expect((await slow).status).toBe(200);
      expect(await stored(id)).toMatchObject({ subscriptionStatus: 'canceled' });
      expect(await state(id)).toBe('access_ended');
      // One audit row per update applied; the stale read never produced one.
      expect(await audits(id)).toBe(audited + 2);
      const rows = await prisma.auditLog.findMany({ where: { eventType: 'SUBSCRIPTION_SYNCED', subjectId: id } });
      expect(rows.filter((r) => (r.metadata as { newStatus: string }).newStatus === 'canceled')).toHaveLength(2);
      expect(await prisma.stripeEvent.count({ where: { id: slowEvent.id } })).toBe(1);
    });

    it('losing every sync attempt is a non-2xx with nothing recorded, so Stripe retries the event', async () => {
      const { id, customer } = await account();
      const a = `sub_a${tag()}`;
      fakeSub(a, customer, 'active', future());
      const contended = updated(a, customer);
      const spy = fake.listSubscriptions.getMockImplementation()!;
      // Another sync commits during each of this event's reads.
      fake.listSubscriptions.mockImplementation(async (c: string) => {
        const listed = await spy(c);
        await prisma.billingAccount.update({ where: { userId: id }, data: { syncedAt: new Date(Date.now() + Math.random() * 1000) } });
        return listed;
      });
      try {
        await send(contended).expect(503);
      } finally {
        fake.listSubscriptions.mockImplementation(spy);
      }
      expect(await prisma.stripeEvent.count({ where: { id: contended.id } })).toBe(0);
      expect(await audits(id)).toBe(0);
      await send(contended).expect(200);
      expect(await stored(id)).toMatchObject({ subscriptionStatus: 'active' });
    });
  });

  it('admin filters and the displayed state agree on every combination of trial, status, period and cancel flag', async () => {
    const now = new Date();
    const later = new Date(now.getTime() + 86_400_000);
    const earlier = new Date(now.getTime() - 86_400_000);
    const trials = [null, { startedAt: earlier, endsAt: later }, { startedAt: earlier, endsAt: earlier }];
    const statuses = ['active', 'trialing', 'past_due', 'incomplete', 'incomplete_expired', 'canceled', 'unpaid', 'paused', 'something_new'];
    type Acct = { subscriptionStatus: string | null; currentPeriodEnd: Date | null; cancelAtPeriodEnd: boolean } | null;
    const accts: Acct[] = [null, { subscriptionStatus: null, currentPeriodEnd: null, cancelAtPeriodEnd: false }];
    for (const subscriptionStatus of statuses)
      for (const currentPeriodEnd of [later, earlier, null]) for (const cancelAtPeriodEnd of [false, true]) accts.push({ subscriptionStatus, currentPeriodEnd, cancelAtPeriodEnd });

    const expected = new Map<string, string>();
    const policy = { enabled: true, enforceFrom: new Date(run - 60_000) };
    let i = 0;
    for (const trial of trials)
      for (const acct of accts) {
        i += 1;
        const { id, createdAt } = await prisma.user.create({
          data: {
            email: `billing.fx.${run}.state${i}@example.test`,
            passwordHash: 'x',
            role: 'CUSTOMER',
            ...(trial && { trial: { create: trial } }),
            ...(acct && { billingAccount: { create: { ...acct, stripeCustomerId: `cus_state${i}${run}`, livemode: false } } }),
          },
          select: { id: true, createdAt: true },
        });
        expected.set(id, accessState({ userCreatedAt: createdAt, trial, account: acct && { ...acct, plan: null } }, policy, now).state);
      }

    const seen = new Map<string, string[]>();
    for (const state of ADMIN_BILLING_FILTERS) {
      const rows = await prisma.user.findMany({ where: { AND: [{ id: { in: [...expected.keys()] } }, accessStateWhere(state, now)] }, select: { id: true } });
      for (const { id } of rows) seen.set(id, [...(seen.get(id) ?? []), state]);
    }
    for (const [id, state] of expected) {
      const want = (ADMIN_BILLING_FILTERS as readonly string[]).includes(state) ? [state] : [];
      expect([state, seen.get(id) ?? []]).toEqual([state, want]);
    }
    // Every filter is exercised, and the API serves the same answer, paginated on the server.
    expect(new Set(expected.values())).toEqual(new Set([...ADMIN_BILLING_FILTERS, 'trial_available']));
    const scheduled = [...expected].find(([, s]) => s === 'cancellation_scheduled')![0];
    const http = await agents.root.get(api('/admin/billing/accounts')).query({ state: 'cancellation_scheduled', accountId: scheduled }).expect(200);
    expect(http.body.items).toEqual([expect.objectContaining({ accountId: scheduled, state: 'cancellation_scheduled' })]);
    expect((await agents.root.get(api('/admin/billing/accounts')).query({ state: 'paid_active', accountId: scheduled }).expect(200)).body.items).toEqual([]);
    const page = await agents.root.get(api('/admin/billing/accounts')).query({ state: 'trial_active', limit: 5, page: 1 }).expect(200);
    expect(page.body.items.length).toBe(5);
    expect(page.body.items.every((b: { state: string }) => b.state === 'trial_active')).toBe(true);
    expect(page.body.pagination.total).toBeGreaterThanOrEqual([...expected.values()].filter((s) => s === 'trial_active').length);
  });
});
