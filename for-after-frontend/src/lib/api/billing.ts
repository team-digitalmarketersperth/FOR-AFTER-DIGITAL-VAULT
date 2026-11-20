import { apiRequest } from '@/lib/api/client';

// Step 10 billing (backend docs/billing.md). Dates and access come from the
// server; the browser never decides access, and a checkout return URL grants nothing.

export type AccessState =
  | 'no_billing_record'
  | 'trial_available'
  | 'trial_active'
  | 'trial_expired'
  | 'paid_active'
  | 'cancellation_scheduled'
  | 'payment_issue'
  | 'payment_pending'
  /** Updated Plans Step 6: paid in Stripe, but the price matches no configured plan (no access until resolved). */
  | 'plan_unresolved'
  | 'access_ended';
export type PlanKey = 'monthly' | 'annual';
export type PaidTier = 'PREMIUM' | 'COMPLETE';
export type CheckoutOption = { tier: PaidTier; interval: PlanKey };

export type BillingStatus = {
  /** The launch gate: false = plans and trials are not available at all. */
  enabled: boolean;
  state: AccessState;
  enforced: boolean;
  hasAccess: boolean;
  trialEligible: boolean;
  trial: { startedAt: string; endsAt: string } | null;
  subscription: {
    plan: string | null;
    cancelAtPeriodEnd: boolean;
    currentPeriodEnd: string | null;
    /** Step 6: mapped = a configured tier price; unmapped = an existing/legacy subscription (access kept); unresolved = an unknown price. */
    mapping?: 'mapped' | 'unmapped' | 'unresolved';
  } | null;
  plans: PlanKey[];
  /** Step 6: the tier + interval pairs the server can sell now (unconfigured ones are absent). */
  checkoutOptions?: CheckoutOption[];
  /** Updated Plans Step 2: the tier in force (null without one), from the server. */
  productTier?: {
    tier: 'FREE_TRIAL' | PaidTier | null;
    interval: PlanKey | null;
    mapping: 'trial' | 'mapped' | 'unmapped' | 'none';
    exemption?: 'billing_off' | 'grandfathered' | null;
  };
  /** Step 7: live counts and the limits the API enforces on creating (limit null = no count limit, never "unlimited"). */
  people?: {
    recipients: { used: number; limit: number | null; limitSource: 'trial' | 'plan' | null };
    trustedContacts: { used: number; limit: number; limitSource: 'trial' | 'maximum' };
  };
  /** Step 7: the server's approved plan matrix (the comparison's numbers come only from here). */
  planDefinitions?: Record<'FREE_TRIAL' | PaidTier, PlanDefinition>;
  canManageSubscription: boolean;
  /** Trial caps the API enforces on creating records; null = no trial cap (paid, exempt, billing off). */
  trialCaps?: { recipients: number | null; trustedContacts: number | null; questions?: number | null; memories?: number | null };
  /** Trial Step 5: My Story + My Wishes questions with written answers (the count the API enforces against trialCaps.questions). */
  questionsAnswered?: number;
  /** Trial Step 7: live Memory Vault memories (the count the API enforces against trialCaps.memories). */
  memoriesSaved?: number;
  /** Trial Step 4: paid-only features the API enforces; media false only during an enforced active trial. */
  features?: { media: boolean; memoryLinks?: boolean; /** Updated Plans Step 4: kinds of new media allowed now. */ mediaKinds?: ('PHOTO' | 'AUDIO' | 'VIDEO')[] };
};

/** One plan's approved limits, exactly as the API's PLAN_DEFINITIONS (null = no count limit). */
export type PlanDefinition = {
  storageBytes: number;
  recipients: number;
  trustedContacts: number;
  answeredQuestions: number | null;
  memoryVaultEntries: number | null;
  contentMedia: ('PHOTO' | 'AUDIO' | 'VIDEO')[];
  memoryLinks: boolean;
  aiRequests: { successful: number; per: 'trial' | 'month' };
  support: 'standard' | 'priority';
};

export const billingApi = {
  status: (signal?: AbortSignal) => apiRequest<BillingStatus>('/billing', { signal }),
  startTrial: () => apiRequest<BillingStatus>('/billing/trial', { method: 'POST', body: {} }),
  // Step 6: a tier and an interval only; the server chooses the price.
  checkout: (option: CheckoutOption) => apiRequest<{ url: string }>('/billing/checkout', { method: 'POST', body: { tier: option.tier, interval: option.interval } }),
  portal: () => apiRequest<{ url: string }>('/billing/portal', { method: 'POST', body: {} }),
};
