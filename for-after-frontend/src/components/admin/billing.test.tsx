import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BillingPage, BillingSummary } from '@/lib/api/admin';
import type { AccessState } from '@/lib/api/billing';
import { json, renderWithClient, routeFetch, router } from '@/test/utils';
import { AdminBillingList } from './billing';

vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/admin/billing' }));

// Fictional accounts; server time fixed. Nothing here talks to Stripe.
const NOW = '2026-11-12T02:00:00.000Z';
const FUTURE = '2026-12-12T02:00:00.000Z';
const PAST = '2026-11-01T02:00:00.000Z';
const ID = '11111111-1111-4111-8111-111111111111';
const NONE: Record<AccessState, number> = {
  no_billing_record: 0,
  trial_available: 0,
  trial_active: 0,
  trial_expired: 0,
  paid_active: 0,
  cancellation_scheduled: 0,
  payment_issue: 0,
  payment_pending: 0,
  plan_unresolved: 0,
  access_ended: 0,
};
const row = (over: Partial<BillingSummary> = {}): BillingSummary => ({
  accountId: ID,
  email: 'ana.test@example.test',
  firstName: 'Ana',
  lastName: 'Test',
  accountCreatedAt: PAST,
  state: 'cancellation_scheduled',
  hasAccess: true,
  trialStartedAt: null,
  trialEndsAt: null,
  plan: 'monthly',
  subscriptionStatus: 'active',
  subscriptionReference: 'sub_123',
  cancelAtPeriodEnd: true,
  currentPeriodEnd: FUTURE,
  lastSyncedAt: PAST,
  ...over,
});
const billingPage = (
  items: BillingSummary[],
  states: Partial<Record<AccessState, number>> = {},
  { enabled = true, verified = 0, total }: { enabled?: boolean; verified?: number; total?: number } = {},
): BillingPage => {
  const s = { ...NONE, ...states };
  const accounts = Object.values(s).reduce((a, b) => a + b, 0);
  const t = total ?? accounts;
  return {
    evaluatedAt: NOW,
    enabled,
    enforceFrom: enabled ? '2026-11-01T00:00:00.000Z' : null,
    summary: { accounts, verified, states: s },
    items,
    pagination: { page: 1, limit: 25, total: t, pages: Math.max(1, Math.ceil(t / 25)) },
  };
};
const card = (label: string) => within(screen.getByRole('region', { name: 'Billing summary' })).getByText(label).parentElement!;
const dataPanel = () => within(screen.getByRole('region', { name: 'Data & access' }));

beforeEach(() => vi.clearAllMocks());

describe('Subscriptions & payments', () => {
  it('billing off, no records: off notice, zero cards, compact overview, one empty state, verification Not available', async () => {
    routeFetch({ 'GET /admin/billing/accounts': json(200, billingPage([], {}, { enabled: false })) });
    renderWithClient(<AdminBillingList filters={{ page: 1 }} />);
    expect(await screen.findByRole('heading', { name: 'Billing is switched off' })).toBeInTheDocument();
    expect(screen.getByText(/No billing access restrictions apply\. Trials and checkout are unavailable\./)).toBeInTheDocument();
    expect(screen.queryByText(/may continue independently/)).not.toBeInTheDocument();
    expect(screen.getByText('Read-only')).toBeInTheDocument();
    expect(within(card('Accounts listed')).getByText('0')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Recorded access states' })).toBeInTheDocument();
    expect(screen.getByText(/No billing records to summarise/)).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /by status/ })).not.toBeInTheDocument();
    expect(screen.getAllByText('No trials or subscriptions yet')).toHaveLength(1);
    expect(dataPanel().getAllByText('None')).toHaveLength(2); // accounts listed, with a billing record
    expect(dataPanel().getByText('Not available')).toBeInTheDocument();
    expect(dataPanel().getByText('No billing record does not mean unpaid.')).toBeInTheDocument();
    expect(screen.getByText(/Billing enforcement is off/)).toBeInTheDocument();
  });

  it('billing off with recorded subscriptions: states are counted, not zeroed, and the independence note shows', async () => {
    routeFetch({
      'GET /admin/billing/accounts': json(200, billingPage([row({ state: 'paid_active', cancelAtPeriodEnd: false })], { paid_active: 2, trial_active: 1 }, { enabled: false, verified: 2 })),
    });
    renderWithClient(<AdminBillingList filters={{ page: 1 }} />);
    expect(await screen.findByText(/Existing Stripe subscriptions are not cancelled by this setting and may continue independently\./)).toBeInTheDocument();
    expect(within(card('Paid, in current period')).getByText('2')).toBeInTheDocument();
    expect(within(card('Active trials')).getByText('1')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /Subscribed 2 \(67%\), .*Free trial 1 \(33%\)|Free trial 1 \(33%\), Subscribed 2 \(67%\)/ })).toBeInTheDocument();
    expect(screen.getByText(/none of these restrict access/)).toBeInTheDocument();
    expect(dataPanel().getByText('2 of 3 accounts')).toBeInTheDocument();
  });

  it('billing on, no records: neutral on notice that does not claim Stripe is connected', async () => {
    routeFetch({ 'GET /admin/billing/accounts': json(200, billingPage([])) });
    renderWithClient(<AdminBillingList filters={{ page: 1 }} />);
    expect(await screen.findByRole('heading', { name: 'Billing is switched on' })).toBeInTheDocument();
    expect(screen.getByText(/older accounts keep their access/)).toBeInTheDocument();
    expect(screen.getByText(/doesn’t confirm the Stripe connection/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Access overview' })).toBeInTheDocument();
    expect(screen.getByText('No trials or subscriptions yet')).toBeInTheDocument();
  });

  it('mixed states: cards from server totals (overlap allowed), every state once in the bar, rows read accurately', async () => {
    const states = { trial_active: 3, paid_active: 4, cancellation_scheduled: 1, payment_issue: 2, access_ended: 1, trial_expired: 1, trial_available: 1 };
    routeFetch({
      'GET /admin/billing/accounts': json(
        200,
        billingPage(
          [
            row(),
            row({ accountId: 'b', firstName: 'Ben', state: 'payment_issue', subscriptionStatus: 'past_due', cancelAtPeriodEnd: false, lastSyncedAt: null }),
            row({ accountId: 'c', firstName: 'Cal', state: 'access_ended', subscriptionStatus: 'active', cancelAtPeriodEnd: false, currentPeriodEnd: PAST }),
            row({ accountId: 'd', firstName: 'Dee', state: 'trial_active', plan: null, subscriptionStatus: null, subscriptionReference: null, currentPeriodEnd: null, cancelAtPeriodEnd: false, trialStartedAt: PAST, trialEndsAt: FUTURE, lastSyncedAt: null }),
            row({ accountId: 'e', firstName: 'Eve', state: 'trial_expired', plan: null, subscriptionStatus: null, subscriptionReference: null, currentPeriodEnd: null, cancelAtPeriodEnd: false, trialStartedAt: PAST, trialEndsAt: PAST, lastSyncedAt: null }),
          ],
          states,
          { verified: 8 },
        ),
      ),
    });
    renderWithClient(<AdminBillingList filters={{ page: 1 }} />);
    const table = await screen.findByRole('table', { name: 'Billing accounts' });
    expect(within(card('Accounts listed')).getByText('13')).toBeInTheDocument();
    // Users' definition: listed minus the two "nothing yet" states (here trial_available: 1).
    expect(within(dataPanel().getByText('With a billing record').closest('div')!).getByText('12')).toBeInTheDocument();
    expect(within(card('Paid, in current period')).getByText('7')).toBeInTheDocument(); // 4 + 1 + 2
    expect(within(card('Payment issues')).getByText('2')).toBeInTheDocument();
    const bar = screen.getByRole('img', { name: /by status/ });
    expect(bar.getAttribute('aria-label')).toMatch(/Total 13\.$/);
    expect(bar.getAttribute('aria-label')).not.toMatch(/No billing record/); // zero states are left out of the bar
    const r = (first: string) => within(within(table).getByText(`${first} Test`).closest('tr')!);
    expect(r('Ana').getByText('Cancels at period end')).toBeInTheDocument();
    expect(r('Ana').getByText(/^Paid until .*, then ends$/)).toBeInTheDocument();
    expect(r('Ben').getByText('Payment issue')).toBeInTheDocument();
    expect(r('Ben').getByText('Never verified')).toBeInTheDocument();
    expect(r('Cal').getByText(/^Paid period ended /)).toBeInTheDocument();
    expect(r('Dee').getAllByText('Free trial')).toHaveLength(2); // plan column and access badge
    expect(r('Dee').getByText(/^Trial ends /)).toBeInTheDocument();
    expect(r('Dee').getByText('Not applicable (trial only)')).toBeInTheDocument();
    expect(r('Eve').getByText(/^Trial ended /)).toBeInTheDocument();
    expect(r('Ana').getByRole('link', { name: 'View account: Ana Test' })).toHaveAttribute('href', `/admin/users/${ID}`);
    expect(screen.queryByRole('button', { name: /refund|charge|extend|cancel|enable|disable|sync|checkout|trial/i })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/card ending|payment method:|whsec|sk_test|cus_/i);
  });

  it('the access filter narrows the table only; the summary scope is labelled', async () => {
    routeFetch({ 'GET /admin/billing/accounts': json(200, billingPage([row({ state: 'payment_issue' })], { payment_issue: 1, paid_active: 5 }, { total: 1 })) });
    renderWithClient(<AdminBillingList filters={{ page: 1, state: 'payment_issue', plan: 'monthly', from: '2026-11-01', to: '2026-11-02' }} />);
    await screen.findByRole('table', { name: 'Billing accounts' });
    expect(within(card('Accounts listed')).getByText('6')).toBeInTheDocument();
    expect(screen.getByText(/every access state · Monthly plan, accounts created 1 November 2026 to 2 November 2026/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Access: Payment issue/ })).toBeInTheDocument();
    // Account-created days go to the API as whole local days, inclusive.
    const url = new URL(String(vi.mocked(fetch).mock.calls[0]![0]));
    expect(url.searchParams.get('from')).toMatch(/^2026-11-01T00:00:00[+-]\d\d:\d\d$/);
    expect(url.searchParams.get('to')).toMatch(/^2026-11-02T23:59:59\.999[+-]\d\d:\d\d$/);
    expect(url.searchParams.get('state')).toBe('payment_issue');
    await userEvent.click(screen.getByRole('button', { name: /Access: Payment issue/ }));
    expect(router.replace).toHaveBeenLastCalledWith('/admin/billing?plan=monthly&from=2026-11-01&to=2026-11-02', { scroll: false });
  });

  it('filters keep their Apply step and validation; secondary fields live in More filters; no matches offers Clear', async () => {
    routeFetch({ 'GET /admin/billing/accounts': json(200, billingPage([], {}, { total: 0 })) });
    renderWithClient(<AdminBillingList filters={{ page: 1, plan: 'annual' }} />);
    expect(await screen.findByText('No matching billing records')).toBeInTheDocument();
    router.replace.mockClear();
    await userEvent.click(screen.getByText(/More filters/, { selector: 'summary' }));
    await userEvent.type(screen.getByLabelText('Subscription ID'), 'price_123');
    await userEvent.click(screen.getByRole('button', { name: 'Apply filters' }));
    expect(await screen.findByText(/Enter a Stripe subscription ID/)).toBeInTheDocument();
    expect(router.replace).not.toHaveBeenCalled();
    await userEvent.clear(screen.getByLabelText('Subscription ID'));
    await userEvent.selectOptions(screen.getByLabelText('Access'), 'trial_active');
    await userEvent.click(screen.getByRole('button', { name: 'Apply filters' }));
    expect(router.replace).toHaveBeenLastCalledWith('/admin/billing?plan=annual&state=trial_active', { scroll: false });
    const clear = screen.getAllByRole('button', { name: 'Clear filters' });
    await userEvent.click(clear[clear.length - 1]!);
    expect(router.replace).toHaveBeenLastCalledWith('/admin/billing', { scroll: false });
  });

  it('Refresh re-reads stored data with a GET only; a failed refresh keeps the last data with a notice', async () => {
    let n = 0;
    const api = routeFetch({
      'GET /admin/billing/accounts': () => (++n === 2 ? json(500, { message: 'Internal server error' }) : json(200, billingPage([row()], { cancellation_scheduled: 1 }))),
    });
    renderWithClient(<AdminBillingList filters={{ page: 1 }} />);
    await screen.findByRole('table', { name: 'Billing accounts' });
    expect(screen.getByText(/^Page data read /)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Couldn’t refresh/);
    expect(screen.getByText('Ana Test')).toBeInTheDocument();
    expect(api.calls.every((c) => c.method === 'GET' && c.path === '/admin/billing/accounts')).toBe(true);
  });

  it('a failed first load shows an error with Try again, never an off notice or zero counts', async () => {
    routeFetch({ 'GET /admin/billing/accounts': json(500, { message: 'Internal server error' }) });
    renderWithClient(<AdminBillingList filters={{ page: 1 }} />);
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.queryByText(/Billing is switched/)).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Billing summary' })).not.toBeInTheDocument();
  });

  it('a non-super-admin is refused by the API and told so', async () => {
    routeFetch({ 'GET /admin/billing/accounts': json(403, { message: 'Billing details are visible to super admins only.' }) });
    renderWithClient(<AdminBillingList filters={{ page: 1 }} />);
    expect(await screen.findByText('Access denied')).toBeInTheDocument();
    expect(screen.queryByText(/Billing is switched/)).not.toBeInTheDocument();
  });

  it('keyboard: Tab reaches View account', async () => {
    routeFetch({ 'GET /admin/billing/accounts': json(200, billingPage([row()], { cancellation_scheduled: 1 })) });
    renderWithClient(<AdminBillingList filters={{ page: 1 }} />);
    const link = await screen.findByRole('link', { name: 'View account: Ana Test' });
    for (let i = 0; i < 40 && document.activeElement !== link; i += 1) await userEvent.tab();
    await waitFor(() => expect(link).toHaveFocus());
  });
});
