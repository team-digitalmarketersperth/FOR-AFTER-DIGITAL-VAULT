import { SetMetadata } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';

/**
 * The one definition of a Customer's billing/access state (docs/billing.md §3),
 * used by enforcement, the Customer plan page, Admin → Users and the admin
 * billing page. Pure: time comes in as `now`, so expiry needs no scheduler.
 * Billing state is kept apart from account security (User.status).
 */
export const TRIAL_DAYS = 7; // decided 2026-10-31: card-free, app-run 7-day trial
const DAY = 24 * 60 * 60 * 1000;
export const trialEnd = (start: Date) => new Date(start.getTime() + TRIAL_DAYS * DAY);

export const ACCESS_STATES = [
  'no_billing_record', // not subject to billing (billing off, or an account created before enforcement)
  'trial_available', // subject to billing, no trial or subscription yet
  'trial_active',
  'trial_expired',
  'paid_active',
  'cancellation_scheduled', // paid, cancels at period end; access until then
  'payment_issue', // past_due within the paid period; access until period end
  'payment_pending', // checkout started, first payment not confirmed (incomplete)
  'access_ended', // subscription ended, unpaid, expired or paused
] as const;
export type AccessState = (typeof ACCESS_STATES)[number];

export type BillingInputs = {
  userCreatedAt: Date;
  trial: { startedAt: Date; endsAt: Date } | null;
  account: {
    plan: string | null;
    subscriptionStatus: string | null;
    cancelAtPeriodEnd: boolean;
    currentPeriodEnd: Date | null;
  } | null;
};
export type BillingPolicy = { enabled: boolean; enforceFrom: Date | null };

// Stripe statuses that keep paid access while the paid period lasts.
const PAID = ['active', 'trialing', 'past_due'];

export const REQUIRES_PLAN = 'billing:requires-plan';
/**
 * On a Customer controller whose POST/PUT/PATCH routes create or change content,
 * upload, or use the AI companion: refused (402) without access. Reads and DELETE
 * stay open (docs/billing.md §3). Enforced by BillingAccessInterceptor.
 */
export const RequiresPlan = () => SetMetadata(REQUIRES_PLAN, true);

/**
 * Which of a customer's Stripe subscriptions the account shows: higher wins, so a
 * late event for a replaced subscription can never displace the entitled one.
 */
export const subscriptionRank = (s: { status: string; cancelAtPeriodEnd: boolean; currentPeriodEnd: Date | null }, now: Date) => {
  if (PAID.includes(s.status) && !!s.currentPeriodEnd && s.currentPeriodEnd > now) {
    if (s.status === 'past_due') return 2;
    return s.cancelAtPeriodEnd ? 3 : 4;
  }
  return s.status === 'incomplete' ? 1 : 0;
};

export function accessState({ userCreatedAt, trial, account }: BillingInputs, policy: BillingPolicy, now: Date) {
  // Accounts created before enforcement keep their access (rollout rule, §5).
  const enforced = policy.enabled && !!policy.enforceFrom && userCreatedAt >= policy.enforceFrom;
  const status = account?.subscriptionStatus ?? null;
  const inPeriod = !!account?.currentPeriodEnd && account.currentPeriodEnd > now;
  let state: AccessState;
  if (status && PAID.includes(status) && inPeriod) {
    state = status === 'past_due' ? 'payment_issue' : account!.cancelAtPeriodEnd ? 'cancellation_scheduled' : 'paid_active';
  } else if (trial && trial.endsAt > now) {
    state = 'trial_active';
  } else if (status === 'incomplete') {
    state = 'payment_pending';
  } else if (status) {
    // Unknown, ended, unpaid, paused or a paid status whose period has passed: never treated as paid.
    state = 'access_ended';
  } else if (trial) {
    state = 'trial_expired';
  } else {
    state = enforced ? 'trial_available' : 'no_billing_record';
  }
  const entitled = ['trial_active', 'paid_active', 'cancellation_scheduled', 'payment_issue'].includes(state);
  return {
    state,
    enforced,
    // What the gate uses: unenforced accounts keep access whatever their records say.
    hasAccess: !enforced || entitled,
    trialEligible: enforced && !trial && !status,
  };
}

/** The states the admin list can filter by: those a billing row can be in whatever the enforcement date. */
export const ADMIN_BILLING_FILTERS = ['trial_active', 'trial_expired', 'paid_active', 'cancellation_scheduled', 'payment_issue', 'payment_pending', 'access_ended'] as const;
export type AdminBillingFilter = (typeof ADMIN_BILLING_FILTERS)[number];

/** accessState() as a query, in its order of precedence: the billing e2e checks they agree on every combination. */
export function accessStateWhere(state: AdminBillingFilter, now: Date): Prisma.UserWhereInput {
  const account = (is: Prisma.BillingAccountWhereInput): Prisma.UserWhereInput => ({ billingAccount: { is } });
  const inPeriod = { currentPeriodEnd: { gt: now } };
  const notPaid: Prisma.UserWhereInput = {
    OR: [
      { billingAccount: { is: null } },
      account({ OR: [{ subscriptionStatus: null }, { subscriptionStatus: { notIn: PAID } }, { currentPeriodEnd: null }, { currentPeriodEnd: { lte: now } }] }),
    ],
  };
  const noTrialNow: Prisma.UserWhereInput = { OR: [{ trial: { is: null } }, { trial: { is: { endsAt: { lte: now } } } }] };
  switch (state) {
    case 'paid_active':
      return account({ subscriptionStatus: { in: ['active', 'trialing'] }, cancelAtPeriodEnd: false, ...inPeriod });
    case 'cancellation_scheduled':
      return account({ subscriptionStatus: { in: ['active', 'trialing'] }, cancelAtPeriodEnd: true, ...inPeriod });
    case 'payment_issue':
      return account({ subscriptionStatus: 'past_due', ...inPeriod });
    case 'trial_active':
      return { AND: [{ trial: { is: { endsAt: { gt: now } } } }, notPaid] };
    case 'payment_pending':
      return { AND: [account({ subscriptionStatus: 'incomplete' }), noTrialNow] };
    case 'access_ended':
      return { AND: [account({ subscriptionStatus: { not: 'incomplete' } }), notPaid, noTrialNow] };
    case 'trial_expired':
      return { AND: [{ trial: { is: { endsAt: { lte: now } } } }, { OR: [{ billingAccount: { is: null } }, account({ subscriptionStatus: null })] }] };
  }
}
