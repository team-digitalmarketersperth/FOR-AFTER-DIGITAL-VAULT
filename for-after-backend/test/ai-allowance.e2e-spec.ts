import { ConfigModule } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import argon2 from 'argon2';
import session from 'express-session';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AiUsageService, AI_ALLOWANCE_EXHAUSTED, AI_REQUEST_DUPLICATE, AI_USAGE_UNRECORDED } from '../src/assistant/ai-usage.service.js';
import { AssistantModule } from '../src/assistant/assistant.module.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { BillingModule } from '../src/billing/billing.module.js';
import { configureApp } from '../src/config/app.setup.js';
import type { PaidTier } from '../src/generated/prisma/client.js';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { RedisModule } from '../src/redis/redis.module.js';

// Updated Plans Step 5: durable AI allowances. Groq is never called: fetch is stubbed with fake replies whose kind each
// test chooses. Billing on with the real gate; tiers are synthetic (set directly on BillingAccount). Real PostgreSQL and
// the isolated Redis. Rows are metadata only (no prompt or reply text), which the last test checks.
describe('AI companion allowances (e2e, PostgreSQL, Groq faked)', () => {
  const DAY = 86_400_000;
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let usage: AiUsageService;
  const run = Date.now();
  const names = ['trial', 'prem', 'comp', 'unm', 'exp', 'race', 'swap'] as const;
  type Name = (typeof names)[number];
  const emails = Object.fromEntries(names.map((n) => [n, `aiallow.${n}.${run}@example.test`])) as Record<Name, string>;
  const agents = {} as Record<Name, ReturnType<typeof request.agent>>;
  const ids = {} as Record<Name, string>;
  const api = (p: string) => `/api/v1${p}`;
  const ENV = {
    BILLING_ENABLED: 'true',
    BILLING_ENFORCE_FROM: new Date(run - 60_000).toISOString(),
    STRIPE_SECRET_KEY: '',
    STRIPE_WEBHOOK_SECRET: '',
    GROQ_API_KEY: 'e2e-fake-key-not-real',
    ASSISTANT_USER_LIMIT_PER_HOUR: '1000',
    ASSISTANT_GLOBAL_LIMIT_PER_MINUTE: '1000',
    ASSISTANT_MAX_CONCURRENT: '50',
  };
  // What the fake provider does next: a complete reply unless a test says otherwise.
  let mode: 'ok' | 'truncated' | 'empty' | 'error' = 'ok';
  let delayMs = 0;
  let calls = 0;
  const SECRET_PROMPT = `private words ${run}`;
  const send = (n: Name, requestId: string = randomUUID()) =>
    agents[n].post(api('/assistant/reply')).send({ page: 'dashboard', action: 'ask', message: SECRET_PROMPT, requestId });
  const status = async (n: Name) => (await agents[n].get(api('/assistant/usage')).expect(200)).body;
  const month = () => {
    const d = new Date();
    return `month:${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  };
  // Synthetic past usage in this month's paid bucket.
  const seedUsed = (n: Name, count: number, period = month()) =>
    prisma.aiUsage.createMany({ data: Array.from({ length: count }, () => ({ userId: ids[n], requestId: randomUUID(), period, status: 'USED' as const, expiresAt: new Date(), settledAt: new Date() })) });
  const paid = (n: Name, tier: PaidTier | null, plan = 'monthly') =>
    prisma.billingAccount.upsert({
      where: { userId: ids[n] },
      create: { userId: ids[n], stripeCustomerId: `cus_fictional_ai_${n}_${run}`, livemode: false, plan, tier, subscriptionStatus: 'active', cancelAtPeriodEnd: false, currentPeriodEnd: new Date(run + 400 * DAY) },
      update: { plan, tier, subscriptionStatus: 'active', currentPeriodEnd: new Date(run + 400 * DAY) },
    });
  const expectExhausted = (res: request.Response) => {
    expect(res.status).toBe(409);
    expect(res.body.code).toBe(AI_ALLOWANCE_EXHAUSTED);
  };

  beforeAll(async () => {
    Object.assign(process.env, ENV);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        if (input !== 'https://api.groq.com/openai/v1/chat/completions') throw new Error(`unexpected fetch ${input}`);
        calls++;
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        if (mode === 'error') return new Response('{}', { status: 500 });
        const content = mode === 'empty' ? '[DRAFT]' : 'A fictional suggestion.';
        return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: mode === 'truncated' ? 'length' : 'stop' }] }), { status: 200 });
      }),
    );
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule, RedisModule, AuthModule, BillingModule, AssistantModule],
    })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app, new session.MemoryStore());
    await app.init();
    prisma = app.get(PrismaService);
    usage = app.get(AiUsageService);
    const passwordHash = await argon2.hash('StrongPassword123!', { type: argon2.argon2id });
    for (const n of names) {
      ids[n] = (await prisma.user.create({ data: { email: emails[n], passwordHash, firstName: n, lastName: 'Test', role: 'CUSTOMER', emailVerifiedAt: new Date() }, select: { id: true } })).id;
    }
    await prisma.customerTrial.create({ data: { userId: ids.trial, startedAt: new Date(run - DAY), endsAt: new Date(run + 6 * DAY) } });
    await prisma.customerTrial.create({ data: { userId: ids.exp, startedAt: new Date(run - 8 * DAY), endsAt: new Date(run - DAY) } });
    await paid('prem', 'PREMIUM', 'annual'); // annual: still a monthly allowance
    await paid('comp', 'COMPLETE');
    await paid('unm', null);
    await paid('race', 'PREMIUM');
    await paid('swap', 'PREMIUM');
    for (const n of names) {
      const a = request.agent(app.getHttpServer());
      await a.post(api('/auth/login')).send({ email: emails[n], password: 'StrongPassword123!' }).expect(200);
      agents[n] = a;
    }
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    for (const k of Object.keys(ENV)) delete process.env[k];
    await prisma?.user.deleteMany({ where: { email: { in: Object.values(emails) } } });
    await app?.close();
  });

  beforeEach(() => {
    mode = 'ok';
    delayMs = 0;
  });

  it('trial: replies 1–5 succeed; the 6th is refused (409 AI_ALLOWANCE_EXHAUSTED) before any provider call', async () => {
    expect(await status('trial')).toMatchObject({ metered: true, kind: 'trial', allowance: 5, used: 0, remaining: 5, resetsAt: null });
    for (let i = 0; i < 5; i++) await send('trial').expect(200);
    const before = calls;
    const res = await send('trial');
    expectExhausted(res);
    expect(res.body).toMatchObject({ kind: 'trial', allowance: 5, used: 5, resetsAt: null });
    expect(calls).toBe(before);
    expect(await status('trial')).toMatchObject({ used: 5, inProgress: 0, remaining: 0 });
  });

  it('Premium (annual billing, monthly allowance): the 50th succeeds, the 51st is refused; resets at the next UTC month', async () => {
    await seedUsed('prem', 49);
    const s = await status('prem');
    expect(s).toMatchObject({ metered: true, kind: 'month', allowance: 50, used: 49, remaining: 1 });
    const d = new Date();
    expect(s.resetsAt).toBe(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString());
    await send('prem').expect(200);
    expectExhausted(await send('prem'));
  });

  it('Complete: the 200th succeeds, the 201st is refused', async () => {
    await seedUsed('comp', 199);
    await send('comp').expect(200);
    const res = await send('comp');
    expectExhausted(res);
    expect(res.body).toMatchObject({ kind: 'month', allowance: 200, used: 200 });
  });

  it('failed, empty and truncated replies are not charged (released); a truncated reply is still shown', async () => {
    await prisma.aiUsage.deleteMany({ where: { userId: ids.comp } });
    for (const [m, code] of [['error', 502], ['empty', 502], ['truncated', 200]] as const) {
      mode = m;
      expect([m, (await send('comp')).status]).toEqual([m, code]);
    }
    expect(await status('comp')).toMatchObject({ used: 0, inProgress: 0, remaining: 200 });
    expect(await prisma.aiUsage.count({ where: { userId: ids.comp, status: 'RELEASED' } })).toBe(3);
  });

  it('concurrent requests with one slot left: exactly one is answered and charged', async () => {
    await seedUsed('race', 49);
    delayMs = 300;
    const res = await Promise.all(Array.from({ length: 6 }, () => send('race')));
    expect(res.filter((r) => r.status === 200)).toHaveLength(1);
    for (const r of res.filter((r) => r.status !== 200)) expectExhausted(r);
    expect(await status('race')).toMatchObject({ used: 50, inProgress: 0, remaining: 0 });
  });

  it('a reused request id: one provider call and one charge; another account may use the same id', async () => {
    await prisma.aiUsage.deleteMany({ where: { userId: ids.comp } });
    const id = randomUUID();
    const before = calls;
    await send('comp', id).expect(200);
    const again = await send('comp', id);
    expect([again.status, again.body.code]).toEqual([409, AI_REQUEST_DUPLICATE]);
    expect(calls).toBe(before + 1);
    expect((await status('comp')).used).toBe(1);
    await send('swap', id).expect(200); // bound to the account: not a duplicate for someone else
  });

  it('tier changes keep the month’s usage: Premium → Complete raises the limit; Complete → Premium blocks when already over', async () => {
    await seedUsed('swap', 60); // 60 + 1 above in this month's shared bucket
    expectExhausted(await send('swap'));
    await paid('swap', 'COMPLETE');
    expect(await status('swap')).toMatchObject({ allowance: 200, used: 61, remaining: 139 });
    await send('swap').expect(200);
    await paid('swap', 'PREMIUM', 'annual'); // back to Premium, and monthly → annual: no fresh bucket either way
    expect(await status('swap')).toMatchObject({ allowance: 50, used: 62, remaining: 0 });
    expectExhausted(await send('swap'));
  });

  it('trial → paid: the paid month is a separate bucket; trial usage is kept in its own', async () => {
    await paid('trial', 'PREMIUM');
    expect(await status('trial')).toMatchObject({ kind: 'month', allowance: 50, used: 0 });
    await send('trial').expect(200);
    expect(await prisma.aiUsage.count({ where: { userId: ids.trial, period: { startsWith: 'trial:' }, status: 'USED' } })).toBe(5);
  });

  it('unmapped paid: not metered (no rows), existing behaviour; expired: the gate still refuses (402)', async () => {
    for (let i = 0; i < 7; i++) await send('unm').expect(200);
    expect(await status('unm')).toEqual({ metered: false, reason: 'unmapped_paid' });
    expect(await prisma.aiUsage.count({ where: { userId: ids.unm } })).toBe(0);
    const res = await send('exp');
    expect([res.status, res.body.code]).toEqual([402, 'TRIAL_EXPIRED']);
    expect(await status('exp')).toEqual({ metered: false, reason: 'no_access' });
  });

  it('reservations: an abandoned one counts until it expires, then frees itself; a late settle is refused and nothing is released', async () => {
    await prisma.aiUsage.deleteMany({ where: { userId: ids.race } });
    await seedUsed('race', 49);
    const now = new Date();
    const crashed = await usage.reserve(ids.race, randomUUID(), 55_000, now); // a request that crashed mid-call
    expect(crashed).toEqual(expect.any(String));
    expect(await usage.status(ids.race, now)).toMatchObject({ used: 49, inProgress: 1, remaining: 0 });
    const blocked = await usage.reserve(ids.race, randomUUID(), 55_000, now).catch((e: { getResponse: () => { code: string } }) => e.getResponse().code);
    expect(blocked).toBe(AI_ALLOWANCE_EXHAUSTED);
    const later = new Date(now.getTime() + 55_001);
    // After expiry it no longer counts…
    expect(await usage.status(ids.race, later)).toMatchObject({ used: 49, inProgress: 0, remaining: 1 });
    // …and can no longer settle (a reply that late is never shown or charged); its row is left as it was.
    const late = await usage.settle(crashed!, later).catch((e: { getResponse: () => { code: string } }) => e.getResponse().code);
    expect(late).toBe(AI_USAGE_UNRECORDED);
    expect((await prisma.aiUsage.findUniqueOrThrow({ where: { id: crashed! } })).status).toBe('RESERVED');
    // Settling twice in time charges once; releasing a settled row changes nothing.
    const fresh = await usage.reserve(ids.race, randomUUID(), 55_000, later);
    await usage.settle(fresh!, later);
    await usage.settle(fresh!, later);
    await usage.release(fresh!);
    expect(await usage.status(ids.race, later)).toMatchObject({ used: 50, inProgress: 0 });
  });

  it('exact UTC month boundary: the last millisecond of the month counts in it; the first of the next month starts empty', async () => {
    // The next UTC month boundary, inside comp's paid period (it runs 400 days from setup).
    const d = new Date();
    const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
    await seedUsed('comp', 3);
    const last = await usage.status(ids.comp, new Date(end.getTime() - 1));
    expect(last).toMatchObject({ metered: true, resetsAt: end.toISOString() });
    expect((last as { used: number }).used).toBeGreaterThanOrEqual(3);
    expect(await usage.status(ids.comp, end)).toMatchObject({
      used: 0,
      remaining: 200,
      resetsAt: new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 1)).toISOString(),
    });
  });

  it('usage rows hold metadata only: no prompt or reply text anywhere in them', async () => {
    const rows = await prisma.aiUsage.findMany({ where: { userId: { in: Object.values(ids) } } });
    expect(rows.length).toBeGreaterThan(0);
    const text = JSON.stringify(rows);
    expect(text).not.toContain(SECRET_PROMPT);
    expect(text).not.toContain('A fictional suggestion');
    expect(Object.keys(rows[0]).sort()).toEqual(['createdAt', 'expiresAt', 'id', 'period', 'requestId', 'settledAt', 'status', 'userId']);
  });
});
