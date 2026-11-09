import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { BillingStatus } from '@/lib/api/billing';
import { json, renderWithClient, routeFetch, router } from '@/test/utils';
import { PlanPage } from './plan';

vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/settings/plan' }));

const T = '2026-11-05T02:00:00.000Z';
const END = '2026-11-12T02:00:00.000Z';
const status = (over: Partial<BillingStatus> = {}): BillingStatus => ({
  enabled: true,
  state: 'trial_available',
  enforced: true,
  hasAccess: false,
  trialEligible: true,
  trial: null,
  subscription: null,
  plans: ['monthly', 'annual'],
  canManageSubscription: false,
  ...over,
});

describe('Plan page', () => {
  it('launch gate off: says plans are not available; no trial or checkout controls', async () => {
    routeFetch({ 'GET /billing': json(200, status({ enabled: false, state: 'no_billing_record', enforced: false, hasAccess: true, trialEligible: false, plans: [] })) });
    renderWithClient(<PlanPage />);
    expect(await screen.findByText(/Plans and free trials aren’t available yet/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('start free trial: card-free, one click, then the server’s real dates; a double click sends once', async () => {
    // The trial request stays in flight until released, like a slow network.
    let release!: () => void;
    const pending = new Promise<void>((r) => (release = r));
    const { called } = routeFetch({
      'GET /billing': json(200, status()),
      'POST /billing/trial': (() =>
        pending.then(() =>
          json(200, status({ state: 'trial_active', hasAccess: true, trialEligible: false, trial: { startedAt: T, endsAt: END } })),
        )) as unknown as () => Response,
    });
    renderWithClient(<PlanPage />);
    expect(await screen.findByText(/No card is needed, and nothing is charged when it ends/)).toBeInTheDocument();
    const start = screen.getByRole('button', { name: 'Start free trial' });
    await userEvent.dblClick(start);
    expect(called('POST', '/billing/trial')).toHaveLength(1);
    release();
    expect(await screen.findByText('Free trial', { selector: 'dt' })).toBeInTheDocument();
    expect(called('POST', '/billing/trial')).toHaveLength(1);
    expect(screen.getByText(/to .*November 2026/)).toBeInTheDocument();
    expect(called('POST', '/billing/trial')[0]!.body).toEqual({}); // no dates or owner from the browser
  });

  it('expired trial: explains what is limited and what is kept; plans go to checkout by plan key only', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    const { called } = routeFetch({
      'GET /billing': json(200, status({ state: 'trial_expired', trialEligible: false, trial: { startedAt: T, endsAt: END } })),
      'POST /billing/checkout': json(200, { url: 'https://checkout.stripe.example/c/test' }),
    });
    renderWithClient(<PlanPage />);
    expect(await screen.findByText('Free trial ended')).toBeInTheDocument();
    expect(screen.getByText(/You can still read everything you’ve saved, and nothing is deleted or released early/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Monthly plan' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://checkout.stripe.example/c/test'));
    expect(called('POST', '/billing/checkout')[0]!.body).toEqual({ plan: 'monthly' });
    vi.unstubAllGlobals();
  });

  it('back from checkout: "Confirming" until the server confirms; the URL alone never shows success', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let n = 0;
    routeFetch({
      'GET /billing': () =>
        n++ < 2
          ? json(200, status({ state: 'trial_expired', trialEligible: false }))
          : json(200, status({ state: 'paid_active', hasAccess: true, trialEligible: false, subscription: { plan: 'monthly', cancelAtPeriodEnd: false, currentPeriodEnd: END }, canManageSubscription: true })),
    });
    renderWithClient(<PlanPage checkout="success" />);
    expect(await screen.findByText(/Confirming your subscription/)).toBeInTheDocument();
    expect(screen.queryByText('Your subscription is confirmed.')).not.toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100);
    });
    expect(await screen.findByText('Your subscription is confirmed.')).toBeInTheDocument();
    expect(screen.getByText('Renews')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Manage subscription' })).toBeInTheDocument();
    vi.useRealTimers();
  });

  it('confirmation is bounded: after the checks it offers Refresh instead of polling forever', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { called } = routeFetch({ 'GET /billing': json(200, status({ state: 'payment_pending', trialEligible: false })) });
    renderWithClient(<PlanPage checkout="success" />);
    await screen.findByText(/Confirming your subscription/);
    for (let i = 0; i < 12; i++)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3100);
      });
    expect(await screen.findByText(/We haven’t received confirmation yet/)).toBeInTheDocument();
    const count = called('GET', '/billing').length;
    expect(count).toBeLessThanOrEqual(12);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(called('GET', '/billing').length).toBe(count); // no more automatic checks
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument();
    vi.useRealTimers();
  });

  it('payment issue and scheduled cancellation say what happens and until when', async () => {
    routeFetch({
      'GET /billing': json(200, status({ state: 'payment_issue', hasAccess: true, trialEligible: false, subscription: { plan: 'annual', cancelAtPeriodEnd: false, currentPeriodEnd: END }, canManageSubscription: true })),
    });
    const { unmount } = renderWithClient(<PlanPage />);
    expect(await screen.findByText(/Your last payment didn’t go through/)).toBeInTheDocument();
    expect(screen.getByText('Paid until')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Choose a plan' })).not.toBeInTheDocument();
    unmount();
    routeFetch({
      'GET /billing': json(200, status({ state: 'cancellation_scheduled', hasAccess: true, trialEligible: false, subscription: { plan: 'monthly', cancelAtPeriodEnd: true, currentPeriodEnd: END }, canManageSubscription: true })),
    });
    renderWithClient(<PlanPage />);
    expect(await screen.findByText('Access ends')).toBeInTheDocument();
    expect(screen.getByText(/won’t renew. You keep full access until the date above/)).toBeInTheDocument();
  });
});
