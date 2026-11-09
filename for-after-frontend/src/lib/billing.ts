import type { AccessState, PlanKey } from '@/lib/api/billing';

// One set of plan/access wording for the Customer plan page and the admin pages.
export const ACCESS_LABEL: Record<AccessState, string> = {
  no_billing_record: 'No billing record',
  trial_available: 'Free trial available',
  trial_active: 'Free trial',
  trial_expired: 'Free trial ended',
  paid_active: 'Subscribed',
  cancellation_scheduled: 'Cancels at period end',
  payment_issue: 'Payment issue',
  payment_pending: 'Payment pending',
  access_ended: 'Plan ended',
};

export const ACCESS_TONE: Record<AccessState, 'neutral' | 'open' | 'done' | 'warning' | 'danger'> = {
  no_billing_record: 'neutral',
  trial_available: 'open',
  trial_active: 'open',
  trial_expired: 'warning',
  paid_active: 'done',
  cancellation_scheduled: 'warning',
  payment_issue: 'danger',
  payment_pending: 'warning',
  access_ended: 'warning',
};

export const PLAN_LABEL: Record<PlanKey | 'unknown', string> = { monthly: 'Monthly', annual: 'Annual', unknown: 'Unknown plan' };
export const planLabel = (p: string | null) => (p ? (PLAN_LABEL[p as PlanKey] ?? p) : '—');
