import { PaidTier } from '../generated/prisma/client.js';
import type { BillingInterval } from './billing-access.js';

/**
 * Updated Plans Step 6: explicit server-side price mappings (docs/billing.md §9 Step 6). A tier comes only from a
 * configured price id, never from an interval, product name, amount or metadata.
 *
 * Legacy STRIPE_PRICE_MONTHLY / STRIPE_PRICE_ANNUAL stay recognised for syncing existing subscriptions (interval only,
 * no tier: the existing unmapped behaviour). They are not sold any more and never mean a particular tier.
 */
export const TIER_PRICE_SETTINGS = {
  PREMIUM: { monthly: 'STRIPE_PRICE_PREMIUM_MONTHLY', annual: 'STRIPE_PRICE_PREMIUM_ANNUAL' },
  COMPLETE: { monthly: 'STRIPE_PRICE_COMPLETE_MONTHLY', annual: 'STRIPE_PRICE_COMPLETE_ANNUAL' },
} as const satisfies Record<PaidTier, Record<BillingInterval, string>>;
export const LEGACY_PRICE_SETTINGS = { monthly: 'STRIPE_PRICE_MONTHLY', annual: 'STRIPE_PRICE_ANNUAL' } as const satisfies Record<BillingInterval, string>;

export type CheckoutOption = { tier: PaidTier; interval: BillingInterval };
type Mapping = { tier: PaidTier | null; interval: BillingInterval; setting: string };

export class PriceCatalog {
  private constructor(
    private readonly byPrice: ReadonlyMap<string, Mapping>,
    private readonly sellable: ReadonlyMap<string, string>,
  ) {}

  /** Reads and validates every price setting; throws (start-up) on a malformed id or one id in two settings. */
  static fromConfig(get: (key: string) => string | undefined): PriceCatalog {
    const byPrice = new Map<string, Mapping>();
    const sellable = new Map<string, string>();
    const add = (setting: string, tier: PaidTier | null, interval: BillingInterval) => {
      const id = get(setting)?.trim();
      if (!id) return;
      if (!/^price_[A-Za-z0-9_]{1,200}$/.test(id)) throw new Error(`${setting} must be a Stripe price id (price_…).`);
      const other = byPrice.get(id);
      if (other) throw new Error(`${setting} and ${other.setting} name the same Stripe price: each price may map to one tier and interval only.`);
      byPrice.set(id, { tier, interval, setting });
      if (tier) sellable.set(`${tier}:${interval}`, id);
    };
    for (const tier of [PaidTier.PREMIUM, PaidTier.COMPLETE])
      for (const interval of ['monthly', 'annual'] as const) add(TIER_PRICE_SETTINGS[tier][interval], tier, interval);
    for (const interval of ['monthly', 'annual'] as const) add(LEGACY_PRICE_SETTINGS[interval], null, interval);
    return new PriceCatalog(byPrice, sellable);
  }

  /** The configured price for a tier and interval, or undefined (not configured = not offered). */
  priceFor(tier: PaidTier, interval: BillingInterval) {
    return this.sellable.get(`${tier}:${interval}`);
  }

  /** What Checkout can offer, from configuration alone (no Stripe call). */
  get options(): CheckoutOption[] {
    return [...this.sellable.keys()].map((k) => {
      const [tier, interval] = k.split(':') as [PaidTier, BillingInterval];
      return { tier, interval };
    });
  }

  /**
   * A subscription's items → its mapping. Exactly one item, quantity 1, with a configured price resolves; a legacy
   * price resolves to an interval with no tier. Several items, another quantity, or an unconfigured price do not:
   * nothing is guessed from the first item.
   */
  resolve(items: readonly { price?: { id?: string | null } | null; quantity?: number | null }[]): SubscriptionPrice {
    const priceIds = items.map((i) => i.price?.id ?? null);
    if (items.length !== 1) return { kind: 'ambiguous', reason: items.length ? 'several_items' : 'no_items', priceIds };
    const item = items[0]!;
    if ((item.quantity ?? 1) !== 1) return { kind: 'ambiguous', reason: 'quantity', priceIds };
    const m = item.price?.id ? this.byPrice.get(item.price.id) : undefined;
    if (!m) return { kind: 'unknown', reason: 'unknown_price', priceIds };
    return m.tier ? { kind: 'mapped', tier: m.tier, interval: m.interval } : { kind: 'legacy', interval: m.interval };
  }
}

export type SubscriptionPrice =
  | { kind: 'mapped'; tier: PaidTier; interval: BillingInterval }
  | { kind: 'legacy'; interval: BillingInterval }
  | { kind: 'unknown' | 'ambiguous'; reason: 'unknown_price' | 'several_items' | 'no_items' | 'quantity'; priceIds: (string | null)[] };

/** The checks a price must pass before Checkout may use it; null = usable, else the reason (logged, never shown). */
export function priceProblem(
  price: { active?: boolean; livemode?: boolean; type?: string; recurring?: { interval?: string; interval_count?: number; usage_type?: string } | null },
  interval: BillingInterval,
  livemode: boolean,
): string | null {
  if (price.livemode !== livemode) return 'wrong_mode';
  if (!price.active) return 'inactive';
  if (price.type !== 'recurring' || !price.recurring) return 'not_recurring';
  if (price.recurring.interval !== (interval === 'monthly' ? 'month' : 'year') || (price.recurring.interval_count ?? 1) !== 1) return 'wrong_interval';
  if (price.recurring.usage_type && price.recurring.usage_type !== 'licensed') return 'metered';
  return null;
}
