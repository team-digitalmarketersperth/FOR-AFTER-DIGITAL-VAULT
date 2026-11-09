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
  | 'access_ended';
export type PlanKey = 'monthly' | 'annual';

export type BillingStatus = {
  /** The launch gate: false = plans and trials are not available at all. */
  enabled: boolean;
  state: AccessState;
  enforced: boolean;
  hasAccess: boolean;
  trialEligible: boolean;
  trial: { startedAt: string; endsAt: string } | null;
  subscription: { plan: string | null; cancelAtPeriodEnd: boolean; currentPeriodEnd: string | null } | null;
  plans: PlanKey[];
  canManageSubscription: boolean;
};

export const billingApi = {
  status: (signal?: AbortSignal) => apiRequest<BillingStatus>('/billing', { signal }),
  startTrial: () => apiRequest<BillingStatus>('/billing/trial', { method: 'POST', body: {} }),
  checkout: (plan: PlanKey) => apiRequest<{ url: string }>('/billing/checkout', { method: 'POST', body: { plan } }),
  portal: () => apiRequest<{ url: string }>('/billing/portal', { method: 'POST', body: {} }),
};
