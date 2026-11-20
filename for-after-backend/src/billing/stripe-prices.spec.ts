import { accessState } from './billing-access.js';
import { PriceCatalog, priceProblem } from './stripe-prices.js';

const env = (over: Record<string, string> = {}) => (key: string) =>
  ({
    STRIPE_PRICE_PREMIUM_MONTHLY: '',
    STRIPE_PRICE_PREMIUM_ANNUAL: '',
    STRIPE_PRICE_COMPLETE_MONTHLY: 'price_cm',
    STRIPE_PRICE_COMPLETE_ANNUAL: 'price_ca',
    STRIPE_PRICE_MONTHLY: 'price_legacy_m',
    ...over,
  })[key];
const item = (id: string | null, quantity = 1) => ({ price: id ? { id } : null, quantity });

describe('PriceCatalog (Updated Plans Step 6)', () => {
  it('maps each configured tier/interval; unconfigured Premium is simply not offered', () => {
    const c = PriceCatalog.fromConfig(env({ STRIPE_PRICE_PREMIUM_MONTHLY: 'price_pm', STRIPE_PRICE_PREMIUM_ANNUAL: 'price_pa' }));
    expect(c.options).toEqual([
      { tier: 'PREMIUM', interval: 'monthly' },
      { tier: 'PREMIUM', interval: 'annual' },
      { tier: 'COMPLETE', interval: 'monthly' },
      { tier: 'COMPLETE', interval: 'annual' },
    ]);
    for (const [id, tier, interval] of [['price_pm', 'PREMIUM', 'monthly'], ['price_pa', 'PREMIUM', 'annual'], ['price_cm', 'COMPLETE', 'monthly'], ['price_ca', 'COMPLETE', 'annual']])
      expect(c.resolve([item(id)])).toEqual({ kind: 'mapped', tier, interval });
    const noPremium = PriceCatalog.fromConfig(env());
    expect(noPremium.priceFor('PREMIUM', 'monthly')).toBeUndefined();
    expect(noPremium.options.map((o) => o.tier)).toEqual(['COMPLETE', 'COMPLETE']);
  });

  it('legacy settings stay interval-only (no tier) and are never sold', () => {
    const c = PriceCatalog.fromConfig(env());
    expect(c.resolve([item('price_legacy_m')])).toEqual({ kind: 'legacy', interval: 'monthly' });
    expect(c.options.some((o) => o.interval === 'monthly' && c.priceFor(o.tier, o.interval) === 'price_legacy_m')).toBe(false);
  });

  it('one price in two settings, or a malformed id, fails start-up', () => {
    expect(() => PriceCatalog.fromConfig(env({ STRIPE_PRICE_PREMIUM_MONTHLY: 'price_cm' }))).toThrow(/same Stripe price/);
    expect(() => PriceCatalog.fromConfig(env({ STRIPE_PRICE_MONTHLY: 'price_ca' }))).toThrow(/STRIPE_PRICE_MONTHLY and STRIPE_PRICE_COMPLETE_ANNUAL/);
    expect(() => PriceCatalog.fromConfig(env({ STRIPE_PRICE_COMPLETE_MONTHLY: 'prod_123' }))).toThrow(/price id/);
  });

  it('unknown, several items, no items and other quantities never resolve (no first-item guess)', () => {
    const c = PriceCatalog.fromConfig(env());
    expect(c.resolve([item('price_other')])).toMatchObject({ kind: 'unknown', reason: 'unknown_price' });
    expect(c.resolve([item('price_cm'), item('price_ca')])).toMatchObject({ kind: 'ambiguous', reason: 'several_items' });
    expect(c.resolve([item('price_cm'), item('price_other')])).toMatchObject({ kind: 'ambiguous' });
    expect(c.resolve([])).toMatchObject({ kind: 'ambiguous', reason: 'no_items' });
    expect(c.resolve([item('price_cm', 2)])).toMatchObject({ kind: 'ambiguous', reason: 'quantity' });
    expect(c.resolve([item(null)])).toMatchObject({ kind: 'unknown' });
  });

  it('Checkout price checks: active, recurring, the intended interval, licensed, this mode', () => {
    const ok = { active: true, livemode: false, type: 'recurring', recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' } };
    expect(priceProblem(ok, 'monthly', false)).toBeNull();
    expect(priceProblem({ ...ok, recurring: { ...ok.recurring, interval: 'year' } }, 'annual', false)).toBeNull();
    expect(priceProblem(ok, 'annual', false)).toBe('wrong_interval');
    expect(priceProblem({ ...ok, recurring: { ...ok.recurring, interval_count: 3 } }, 'monthly', false)).toBe('wrong_interval');
    expect(priceProblem({ ...ok, active: false }, 'monthly', false)).toBe('inactive');
    expect(priceProblem({ ...ok, type: 'one_time', recurring: null }, 'monthly', false)).toBe('not_recurring');
    expect(priceProblem({ ...ok, recurring: { ...ok.recurring, usage_type: 'metered' } }, 'monthly', false)).toBe('metered');
    expect(priceProblem(ok, 'monthly', true)).toBe('wrong_mode');
  });
});

describe('plan_unresolved access state', () => {
  const policy = { enabled: true, enforceFrom: new Date('2026-01-01T00:00:00Z') };
  const now = new Date('2026-11-17T00:00:00Z');
  const later = new Date('2026-12-17T00:00:00Z');
  const acct = (priceUnresolved: boolean, status = 'active') => ({ plan: 'unknown', tier: 'PREMIUM' as const, priceUnresolved, subscriptionStatus: status, cancelAtPeriodEnd: false, currentPeriodEnd: later });
  const at = (account: ReturnType<typeof acct>, trial: { startedAt: Date; endsAt: Date } | null = null, userCreatedAt = new Date('2026-06-01T00:00:00Z')) =>
    accessState({ userCreatedAt, trial, account }, policy, now);

  it('paid in Stripe but unresolved: no access (fail closed); an active trial still applies; grandfathered keep access', () => {
    expect(at(acct(false))).toMatchObject({ state: 'paid_active', hasAccess: true });
    expect(at(acct(true))).toMatchObject({ state: 'plan_unresolved', hasAccess: false });
    expect(at(acct(true, 'past_due'))).toMatchObject({ state: 'plan_unresolved', hasAccess: false });
    expect(at(acct(true, 'canceled'))).toMatchObject({ state: 'access_ended', hasAccess: false });
    expect(at(acct(true), { startedAt: now, endsAt: later })).toMatchObject({ state: 'trial_active', hasAccess: true });
    expect(at(acct(true), null, new Date('2025-01-01T00:00:00Z'))).toMatchObject({ state: 'plan_unresolved', hasAccess: true, enforced: false });
  });
});
