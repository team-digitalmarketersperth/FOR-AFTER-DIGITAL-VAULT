import { QueryClient } from '@tanstack/react-query';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BillingStatus, PlanDefinition } from '@/lib/api/billing';
import { queryKeys, resetPrivateCache } from '@/lib/query/query-client';
import { json, renderWithClient, routeFetch, router } from '@/test/utils';
import { ChoosePlanPage, PlanPage } from './plan';

vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/settings/plan' }));

// Updated Plans Step 7: Settings → Plan. Every number comes from the API (GET /billing, /users/me/storage,
// /assistant/usage); the plan matrix here is the server's PLAN_DEFINITIONS as GET /billing sends it. Fictional accounts.
const T = '2026-11-05T02:00:00.000Z';
const END = '2026-11-12T02:00:00.000Z';
const RESET = '2026-12-01T00:00:00.000Z';
const DEFS: Record<'FREE_TRIAL' | 'PREMIUM' | 'COMPLETE', PlanDefinition> = {
  FREE_TRIAL: { storageBytes: 100_000_000, recipients: 1, trustedContacts: 1, answeredQuestions: 4, memoryVaultEntries: 1, contentMedia: [], memoryLinks: false, aiRequests: { successful: 5, per: 'trial' }, support: 'standard' },
  PREMIUM: { storageBytes: 2_000_000_000, recipients: 10, trustedContacts: 2, answeredQuestions: null, memoryVaultEntries: null, contentMedia: ['PHOTO', 'AUDIO'], memoryLinks: true, aiRequests: { successful: 50, per: 'month' }, support: 'standard' },
  COMPLETE: { storageBytes: 5_000_000_000, recipients: 50, trustedContacts: 2, answeredQuestions: null, memoryVaultEntries: null, contentMedia: ['PHOTO', 'AUDIO', 'VIDEO'], memoryLinks: true, aiRequests: { successful: 200, per: 'month' }, support: 'priority' },
};
const people = (r: number, rl: number | null, rs: 'trial' | 'plan' | null, c = 0, cl = 2, cs: 'trial' | 'maximum' = 'maximum') => ({
  recipients: { used: r, limit: rl, limitSource: rs },
  trustedContacts: { used: c, limit: cl, limitSource: cs },
});
const status = (over: Partial<BillingStatus> = {}): BillingStatus => ({
  enabled: true,
  state: 'trial_available',
  enforced: true,
  hasAccess: false,
  trialEligible: true,
  trial: null,
  subscription: null,
  plans: ['monthly', 'annual'],
  // Step 6: Complete is priced; Premium pricing is undecided, so it isn't on sale.
  checkoutOptions: [
    { tier: 'COMPLETE', interval: 'monthly' },
    { tier: 'COMPLETE', interval: 'annual' },
  ],
  canManageSubscription: false,
  productTier: { tier: null, interval: null, mapping: 'none', exemption: null },
  people: people(0, null, null),
  planDefinitions: DEFS,
  ...over,
});
const storage = (usedBytes: number, limitBytes: number) => json(200, { usedBytes, reservedBytes: 0, limitBytes, percentage: Math.min(100, Math.round((usedBytes / limitBytes) * 100)), level: 'NORMAL' });
const aiMonth = (used: number, allowance: number) => json(200, { metered: true, kind: 'month', allowance, used, inProgress: 0, remaining: allowance - used, periodEndsAt: RESET, resetsAt: RESET });
const routes = (b: BillingStatus, extra: Record<string, ReturnType<typeof json> | (() => Response)> = {}) =>
  routeFetch({ 'GET /billing': json(200, b), 'GET /users/me/storage': storage(25_000_000, 2_000_000_000), 'GET /assistant/usage': aiMonth(0, 50), ...extra });
// Step 8: Settings → Plan has no sales cards or purchase controls; the tiers on sale are level-2 panels on the separate
// purchase route (/settings/plan/choose), reached from the plan page's one "Choose a plan" link.
const card = (name: string) => screen.getByRole('heading', { name, level: 2 }).closest('li')!;
const noCard = (name: string) => expect(screen.queryByRole('heading', { name })).not.toBeInTheDocument();
const chooseLink = () => screen.queryByRole('link', { name: 'Choose a plan' });
const COMPARE = /Compare plans/;
afterEach(() => vi.unstubAllEnvs());
const meter = async (label: string) => (await screen.findByText(label, { selector: 'li > p' })).closest('li')!;
// Claims the app can't make (case-sensitive where a short word would match ordinary text, e.g. "audio").
const NEVER = /[Uu]nlimited|[Mm]ost popular|[Pp]riority support|\bQR\b|[Tt]ranscri|[Ll]ifetime|\$|\bAUD\b/;

const ACTIVE_TRIAL = status({
  state: 'trial_active',
  hasAccess: true,
  trialEligible: false,
  trial: { startedAt: T, endsAt: END },
  productTier: { tier: 'FREE_TRIAL', interval: null, mapping: 'trial', exemption: null },
  trialCaps: { recipients: 1, trustedContacts: 1, questions: 4, memories: 1 },
  questionsAnswered: 4,
  memoriesSaved: 1,
  people: people(1, 1, 'trial', 0, 1, 'trial'),
});
const PREMIUM = status({
  state: 'paid_active',
  hasAccess: true,
  trialEligible: false,
  subscription: { plan: 'monthly', cancelAtPeriodEnd: false, currentPeriodEnd: END, mapping: 'mapped' },
  productTier: { tier: 'PREMIUM', interval: 'monthly', mapping: 'mapped', exemption: null },
  canManageSubscription: true,
  people: people(3, 10, 'plan', 2),
});

describe('Plan page: summary (Updated Plans Step 7)', () => {
  it('launch gate off: current access, no trial or checkout; no plans section', async () => {
    routes(status({ enabled: false, state: 'no_billing_record', enforced: false, hasAccess: true, trialEligible: false, plans: [], checkoutOptions: [], productTier: { tier: null, interval: null, mapping: 'none', exemption: 'billing_off' } }), {
      'GET /assistant/usage': json(200, { metered: false, reason: 'billing_off' }),
    });
    renderWithClient(<PlanPage />);
    expect(await screen.findByText(/Plans and free trials aren’t available yet/)).toBeInTheDocument();
    expect(screen.getByText('Your current access')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Start free trial|secure checkout/ })).not.toBeInTheDocument();
    expect(chooseLink()).not.toBeInTheDocument();
    expect(within(await meter('AI writing help')).getByText('Not counted on your account')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(NEVER);
  });

  it('start free trial: card-free, one click, then the server’s real dates; a double click sends once; it never restarts', async () => {
    let release!: () => void;
    const pending = new Promise<void>((r) => (release = r));
    const { called } = routes(status(), {
      'POST /billing/trial': (() => pending.then(() => json(200, ACTIVE_TRIAL))) as unknown as () => Response,
    });
    renderWithClient(<PlanPage />);
    expect(await screen.findByText(/No card is needed, and nothing is charged when it ends/)).toBeInTheDocument();
    noCard('Free Trial'); // no trial card: the summary is the only place to start it
    await userEvent.dblClick(screen.getByRole('button', { name: 'Start free trial' }));
    expect(called('POST', '/billing/trial')).toHaveLength(1);
    release();
    expect(await screen.findByText('Trial ends', { selector: 'dt' })).toBeInTheDocument();
    expect(called('POST', '/billing/trial')).toHaveLength(1);
    expect(called('POST', '/billing/trial')[0]!.body).toEqual({}); // no dates or owner from the browser
    expect(screen.queryByRole('button', { name: 'Start free trial' })).not.toBeInTheDocument(); // never restarts
  });

  it('Step 8 regression: starting the trial re-reads storage and AI usage, so the meters show the trial’s limits, not the cached ones', async () => {
    let started = false;
    const { called } = routes(status(), {
      'POST /billing/trial': () => {
        started = true;
        return json(200, ACTIVE_TRIAL);
      },
      'GET /users/me/storage': () => (started ? storage(0, 100_000_000) : storage(0, 5_000_000_000)),
      'GET /assistant/usage': () =>
        started
          ? json(200, { metered: true, kind: 'trial', allowance: 5, used: 0, inProgress: 0, remaining: 5, periodEndsAt: END, resetsAt: null })
          : json(200, { metered: false, reason: 'no_access' }),
    });
    renderWithClient(<PlanPage />);
    const s = await meter('Storage');
    expect(await within(s).findByText('0 KB of 5.0 GB used')).toBeInTheDocument();
    expect(await within(await meter('AI writing help')).findByText('Available again with an active plan')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Start free trial' }));
    expect(await within(s).findByText('0 KB of 100.0 MB used')).toBeInTheDocument();
    expect(await within(await meter('AI writing help')).findByText('0 of 5 replies used')).toBeInTheDocument();
    expect(called('GET', '/users/me/storage').length).toBe(2);
    expect(called('GET', '/assistant/usage').length).toBe(2);
  });

  it('active trial: plan and access separate; usage from the API, exactly at the trial limits; no plan cards', async () => {
    routes(ACTIVE_TRIAL, {
      'GET /users/me/storage': storage(100_000_000, 100_000_000),
      'GET /assistant/usage': json(200, { metered: true, kind: 'trial', allowance: 5, used: 5, inProgress: 0, remaining: 0, periodEndsAt: END, resetsAt: null }),
    });
    renderWithClient(<PlanPage />);
    expect(await screen.findByText('Free Trial', { selector: 'dd' })).toBeInTheDocument();
    expect(screen.getByText('Free trial', { selector: 'dd span' })).toBeInTheDocument(); // the access badge
    const s = await meter('Storage');
    expect(await within(s).findByText('100.0 MB of 100.0 MB used')).toBeInTheDocument();
    expect(within(s).getByText(/doesn’t reset each month/)).toBeInTheDocument();
    expect(within(s).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100000000');
    expect(within(await meter('People I Love')).getByText('1 of 1')).toBeInTheDocument();
    expect(within(await meter('Trusted contacts')).getByText('0 of 1')).toBeInTheDocument();
    const ai = await meter('AI writing help');
    expect(await within(ai).findByText('5 of 5 replies used')).toBeInTheDocument();
    expect(within(ai).getByText('For your whole free trial.')).toBeInTheDocument();
    expect(within(await meter('Questions answered (free trial)')).getByText('4 of 4')).toBeInTheDocument();
    expect(within(await meter('Memory Vault (free trial)')).getByText('1 of 1')).toBeInTheDocument();
    expect(screen.queryByText(/Above this allowance/)).not.toBeInTheDocument(); // at, not above
    noCard('Free Trial');
    expect(screen.queryByText('Your plan', { selector: 'span' })).not.toBeInTheDocument(); // no card badge
    // Buying stays reachable during the trial (Complete is on sale), through the separate route only.
    expect(chooseLink()).toHaveAttribute('href', '/settings/plan/choose');
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /secure checkout/ })).not.toBeInTheDocument();
  });

  it('above an allowance: the bar is capped at 100% but the text keeps the real value, and existing content is kept', async () => {
    routes(PREMIUM, { 'GET /users/me/storage': storage(2_500_000_000, 2_000_000_000) });
    renderWithClient(<PlanPage />);
    const s = await meter('Storage');
    expect(await within(s).findByText('2.5 GB of 2.0 GB used')).toBeInTheDocument();
    const bar = within(s).getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '2000000000');
    expect(bar).toHaveAttribute('aria-valuemax', '2000000000');
    expect(bar).toHaveAttribute('aria-valuetext', '2.5 GB of 2.0 GB used');
    expect((bar.firstElementChild as HTMLElement).style.width).toBe('100%');
    expect(within(s).getByText(/Above this allowance. Everything you’ve saved stays as it is/)).toBeInTheDocument();
  });

  it('a failed usage read says so with Try again (never a zero), separately per source', async () => {
    let storageOk = false;
    const { called } = routes(PREMIUM, {
      'GET /users/me/storage': () => (storageOk ? storage(1_000_000, 2_000_000_000) : json(500, { message: 'down' })),
      'GET /assistant/usage': json(500, { message: 'down' }),
    });
    renderWithClient(<PlanPage />);
    const s = await meter('Storage');
    expect(await within(s).findByText('Not available right now.', {}, { timeout: 5000 })).toBeInTheDocument();
    expect(within(s).queryByText(/0 KB|of .* used/)).not.toBeInTheDocument();
    expect(await within(await meter('AI writing help')).findByText('Not available right now.', {}, { timeout: 5000 })).toBeInTheDocument();
    expect(within(await meter('People I Love')).getByText('3 of 10')).toBeInTheDocument(); // other rows still show
    storageOk = true;
    await userEvent.click(within(s).getByRole('button', { name: 'Try loading storage again' }));
    expect(await within(s).findByText('1.0 MB of 2.0 GB used')).toBeInTheDocument();
    expect(called('GET', '/users/me/storage').length).toBeGreaterThanOrEqual(2);
  });

  it('a failed plan read is an error with retry, never confirmed access or a purchase section', async () => {
    routes(status(), { 'GET /billing': json(400, { message: 'down' }) }); // not retried by the client
    renderWithClient(<PlanPage />);
    expect(await screen.findByText("We couldn't load this", {}, { timeout: 8000 })).toBeInTheDocument();
    expect(chooseLink()).not.toBeInTheDocument();
    expect(screen.queryByText('Subscribed')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Try again/ })).toBeInTheDocument();
  });
});

describe('Plan page: plans and purchase (Updated Plans Step 7)', () => {
  it('expired trial: interval by keyboard, checkout sends only { tier, interval }; unpriced Premium is unavailable; no price is invented', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    const { called } = routes(status({ state: 'trial_expired', trialEligible: false, trial: { startedAt: T, endsAt: END } }), {
      'POST /billing/checkout': json(200, { url: 'https://checkout.stripe.example/c/test' }),
    });
    vi.stubEnv('NEXT_PUBLIC_PLANS_URL', 'https://site.example/plans');
    const { unmount } = renderWithClient(<PlanPage />);
    expect(await screen.findByText(/You can still read everything you’ve saved, and nothing is deleted or released early/)).toBeInTheDocument();
    noCard('Free Trial');
    // No count limit but no write access: never "no set limit" here.
    expect(within(await meter('People I Love')).getByText(/Adding people needs an active plan/)).toBeInTheDocument();
    // The plan page only navigates: "View plans" in the read-only notice (no second button), no selectors or checkout,
    // and the configured external comparison as a plain URL.
    const notice = screen.getByText(/You can still read everything you’ve saved/).closest('[role=status]') as HTMLElement;
    expect(within(notice).getByRole('link', { name: 'View plans' })).toHaveAttribute('href', '/settings/plan/choose');
    expect(chooseLink()).not.toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: COMPARE })).toHaveAttribute('href', 'https://site.example/plans');
    unmount();
    renderWithClient(<ChoosePlanPage />);
    const complete = await waitFor(() => card('For After Complete'));
    noCard('For After Premium'); // unpriced: not offered at all
    const monthly = within(complete).getByRole('radio', { name: 'Monthly' });
    expect(monthly).toBeChecked();
    monthly.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(within(complete).getByRole('radio', { name: 'Annual' })).toBeChecked();
    expect(within(complete).getByText(/billed annually/)).toBeInTheDocument();
    await userEvent.click(within(complete).getByRole('button', { name: 'Continue to secure checkout' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://checkout.stripe.example/c/test'));
    expect(called('POST', '/billing/checkout')).toHaveLength(1);
    expect(called('POST', '/billing/checkout')[0]!.body).toEqual({ tier: 'COMPLETE', interval: 'annual' });
    expect(document.body.textContent).not.toMatch(NEVER);
    expect(screen.queryByText(/\bsave \d|saving|% off|months free/i)).not.toBeInTheDocument(); // no annual-saving claim
    vi.unstubAllGlobals();
  });

  it('an interval that isn’t on sale is shown disabled, not offered', async () => {
    routes(status({ state: 'trial_expired', trialEligible: false, checkoutOptions: [{ tier: 'COMPLETE', interval: 'monthly' }] }));
    renderWithClient(<ChoosePlanPage />);
    const complete = await waitFor(() => card('For After Complete'));
    expect(within(complete).getByRole('radio', { name: /Annual/ })).toBeDisabled();
    expect(within(complete).getByText('(not available yet)')).toBeInTheDocument();
  });

  it('mapped Premium: tier, interval, renewal and billing management; no second subscription or tier switch is offered', async () => {
    routes(PREMIUM, { 'GET /assistant/usage': aiMonth(12, 50) });
    renderWithClient(<PlanPage />);
    expect(await screen.findByText('For After Premium', { selector: 'dd' })).toBeInTheDocument();
    expect(screen.getByText('Billed monthly')).toBeInTheDocument();
    expect(screen.getByText('Renews')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Manage billing' })).toBeInTheDocument();
    expect(chooseLink()).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /secure checkout|Upgrade/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    const ai = await meter('AI writing help');
    expect(await within(ai).findByText('12 of 50 replies used')).toBeInTheDocument();
    expect(within(ai).getByText(/Resets on 1 December 2026 \(UTC\). Annual plans reset monthly too./)).toBeInTheDocument();
    expect(within(await meter('People I Love')).getByText('3 of 10')).toBeInTheDocument();
    expect(within(await meter('Trusted contacts')).getByText('Up to two on every plan.')).toBeInTheDocument();
  });

  it('mapped Complete annual: named, nothing to buy', async () => {
    routes(status({ ...PREMIUM, trial: { startedAt: T, endsAt: END }, subscription: { plan: 'annual', cancelAtPeriodEnd: false, currentPeriodEnd: END, mapping: 'mapped' }, productTier: { tier: 'COMPLETE', interval: 'annual', mapping: 'mapped', exemption: null }, people: people(50, 50, 'plan', 2) }));
    renderWithClient(<PlanPage />);
    expect(await screen.findByText('For After Complete', { selector: 'dd' })).toBeInTheDocument();
    expect(screen.getByText('Billed annually')).toBeInTheDocument();
    expect(chooseLink()).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /secure checkout/ })).not.toBeInTheDocument();
  });

  it('legacy/unmapped subscription: the existing wording, no tier, no limit number and never "unlimited"', async () => {
    routes(status({ ...PREMIUM, subscription: { plan: 'monthly', cancelAtPeriodEnd: false, currentPeriodEnd: END, mapping: 'unmapped' }, productTier: { tier: null, interval: 'monthly', mapping: 'unmapped', exemption: null }, people: people(4, null, null) }), {
      'GET /assistant/usage': json(200, { metered: false, reason: 'unmapped_paid' }),
    });
    renderWithClient(<PlanPage />);
    expect(await screen.findByText('Subscription', { selector: 'dd' })).toBeInTheDocument();
    expect(screen.getByText('Monthly', { selector: 'dd span' })).toBeInTheDocument();
    const p = await meter('People I Love');
    expect(within(p).getByText('4 added')).toBeInTheDocument();
    expect(within(p).queryByRole('progressbar')).not.toBeInTheDocument();
    expect(within(p).getByText('Your account has no set limit on people.')).toBeInTheDocument();
    expect(within(await meter('AI writing help')).getByText('Not counted on your account')).toBeInTheDocument();
    expect(chooseLink()).not.toBeInTheDocument(); // holds a subscription: no second Checkout
    expect(document.body.textContent).not.toMatch(NEVER);
  });

  it('grandfathered: "isn’t on a plan and keeps its current access"', async () => {
    routes(status({ state: 'no_billing_record', enforced: false, hasAccess: true, trialEligible: false, productTier: { tier: null, interval: null, mapping: 'none', exemption: 'grandfathered' } }), {
      'GET /assistant/usage': json(200, { metered: false, reason: 'grandfathered' }),
    });
    renderWithClient(<PlanPage />);
    expect(await screen.findByText('Your account isn’t on a plan and keeps its current access.')).toBeInTheDocument();
    expect(screen.getByText('Your current access')).toBeInTheDocument();
  });

  it('unresolved: a stored tier never shows as active; support, no purchase or "choose a plan"', async () => {
    routes(status({ state: 'plan_unresolved', trialEligible: false, subscription: { plan: 'unknown', cancelAtPeriodEnd: false, currentPeriodEnd: END, mapping: 'unresolved' }, canManageSubscription: true }), {
      'GET /assistant/usage': json(200, { metered: false, reason: 'no_access' }),
    });
    renderWithClient(<PlanPage />);
    expect(await screen.findByText(/couldn’t match it to one of our plans/)).toBeInTheDocument();
    expect(screen.getByText('Subscription', { selector: 'dd' })).toBeInTheDocument();
    expect(screen.getByText('Plan being checked', { selector: 'dd span' })).toBeInTheDocument();
    expect(screen.queryByText(/For After (Premium|Complete)/, { selector: 'dd' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /secure checkout/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Choose a plan to keep|purchase|subscribe again/)).not.toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Contact support' })[0]).toHaveAttribute('href', '/support/new');
    expect(within(await meter('AI writing help')).getByText('Available again with an active plan')).toBeInTheDocument();
  });

  it('payment pending: explained; no second checkout while the first is unconfirmed', async () => {
    routes(status({ state: 'payment_pending', trialEligible: false, subscription: { plan: 'monthly', cancelAtPeriodEnd: false, currentPeriodEnd: END, mapping: 'mapped' } }));
    renderWithClient(<PlanPage />);
    expect(await screen.findByText('Your payment hasn’t been confirmed yet.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /secure checkout/ })).not.toBeInTheDocument();
  });

  it('payment issue and scheduled cancellation say what happens and until when', async () => {
    routes(status({ ...PREMIUM, state: 'payment_issue' }));
    const { unmount } = renderWithClient(<PlanPage />);
    expect(await screen.findByText(/Your last payment didn’t go through/)).toBeInTheDocument();
    expect(screen.getByText('Paid until')).toBeInTheDocument();
    unmount();
    routes(status({ ...PREMIUM, state: 'cancellation_scheduled', subscription: { plan: 'monthly', cancelAtPeriodEnd: true, currentPeriodEnd: END, mapping: 'mapped' } }));
    renderWithClient(<PlanPage />);
    expect(await screen.findByText('Access ends')).toBeInTheDocument();
    expect(screen.getByText(/won’t renew. You keep full access until the date above/)).toBeInTheDocument();
  });

  it('purchase route: no comparison or feature lists; the external "Compare plans" link only for a configured https URL', async () => {
    routes(status({ state: 'trial_expired', trialEligible: false }));
    const { unmount } = renderWithClient(<ChoosePlanPage />);
    await waitFor(() => card('For After Complete'));
    expect(screen.queryByText(/Compare everything in each plan/)).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByText(/of storage|replies a month/)).not.toBeInTheDocument(); // no feature lists
    expect(screen.queryByRole('link', { name: COMPARE })).not.toBeInTheDocument(); // unset: no link
    unmount();
    vi.stubEnv('NEXT_PUBLIC_PLANS_URL', 'http://insecure.example/plans');
    const r2 = renderWithClient(<ChoosePlanPage />);
    await waitFor(() => card('For After Complete'));
    expect(screen.queryByRole('link', { name: COMPARE })).not.toBeInTheDocument(); // not https: ignored
    r2.unmount();
    vi.stubEnv('NEXT_PUBLIC_PLANS_URL', 'https://site.example/plans');
    renderWithClient(<ChoosePlanPage />);
    await waitFor(() => card('For After Complete'));
    expect(screen.getAllByRole('link', { name: COMPARE })).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'Compare plans on our website' })).toHaveAttribute('href', 'https://site.example/plans');
    expect(screen.getByRole('link', { name: 'Your plan' })).toHaveAttribute('href', '/settings/plan'); // internal way back
  });

  it('purchase route refuses a second subscription, sends unresolved accounts to support and says when nothing is on sale', async () => {
    vi.stubEnv('NEXT_PUBLIC_PLANS_URL', 'https://site.example/plans');
    const cases: [BillingStatus, RegExp, string | null][] = [
      [PREMIUM, /You already have a subscription/, '/support/new'],
      [status({ ...PREMIUM, state: 'payment_pending', canManageSubscription: false }), /You already have a subscription/, '/support/new'],
      [status({ state: 'plan_unresolved', trialEligible: false, subscription: { plan: 'unknown', cancelAtPeriodEnd: false, currentPeriodEnd: END, mapping: 'unresolved' } }), /couldn’t match it to one of our plans/, '/support/new'],
      [status({ enabled: false, state: 'no_billing_record', enforced: false, hasAccess: true, trialEligible: false, checkoutOptions: [] }), /Plans aren’t available yet/, null],
      [status({ state: 'trial_expired', trialEligible: false, checkoutOptions: [] }), /can’t be bought online just yet/, '/support/new'],
    ];
    for (const [b, text, support] of cases) {
      routes(b);
      const { unmount } = renderWithClient(<ChoosePlanPage />);
      expect(await screen.findByText(text)).toBeInTheDocument();
      expect(screen.queryByRole('radio')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /secure checkout/ })).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: COMPARE })).not.toBeInTheDocument();
      if (support) expect(screen.getByRole('link', { name: 'Contact support' })).toHaveAttribute('href', support);
      unmount();
    }
  });

  it('concise dates: the trial end (not a start–end range) and the renewal, each once with a UTC offset and no long zone name', async () => {
    routes(ACTIVE_TRIAL);
    const { unmount } = renderWithClient(<PlanPage />);
    const ends = (await screen.findByText('Trial ends', { selector: 'dt' })).nextElementSibling!;
    expect(ends.textContent).toMatch(/^\d{1,2} Nov 2026, \d{1,2}:\d{2}\s[ap]m \(UTC[+-]\d/);
    expect(document.body.textContent).not.toMatch(/ to \d{1,2} Nov|Standard Time|Daylight Time/);
    expect(screen.getAllByText(/\(UTC[+-]/)).toHaveLength(1);
    unmount();
    routes(PREMIUM);
    renderWithClient(<PlanPage />);
    const renews = (await screen.findByText('Renews', { selector: 'dt' })).nextElementSibling!;
    expect(renews.textContent).toMatch(/^\d{1,2} Nov 2026, .*\(UTC[+-]\d/);
    expect(screen.queryByText(/Trial end/)).not.toBeInTheDocument(); // no trial row for a subscriber
  });

  it('"Compare plans" (external, plain configured URL) only for accounts that can buy; never for subscribers, unresolved or billing off', async () => {
    vi.stubEnv('NEXT_PUBLIC_PLANS_URL', 'https://site.example/plans');
    const cases: [BillingStatus, boolean][] = [
      [ACTIVE_TRIAL, true],
      [PREMIUM, false],
      [status({ ...PREMIUM, state: 'cancellation_scheduled', subscription: { plan: 'monthly', cancelAtPeriodEnd: true, currentPeriodEnd: END, mapping: 'mapped' } }), false],
      [status({ state: 'plan_unresolved', trialEligible: false, subscription: { plan: 'unknown', cancelAtPeriodEnd: false, currentPeriodEnd: END, mapping: 'unresolved' } }), false],
      [status({ enabled: false, state: 'no_billing_record', enforced: false, hasAccess: true, trialEligible: false, checkoutOptions: [] }), false],
    ];
    for (const [b, shown] of cases) {
      routes(b);
      const { unmount } = renderWithClient(<PlanPage />);
      await screen.findByText('Plan', { selector: 'dt' });
      const link = screen.queryByRole('link', { name: COMPARE });
      if (shown) {
        expect(link).toHaveAttribute('href', 'https://site.example/plans'); // nothing about the account appended
        expect(chooseLink()).toHaveAttribute('href', '/settings/plan/choose');
      } else {
        expect(link).not.toBeInTheDocument();
        expect(chooseLink()).not.toBeInTheDocument();
      }
      unmount();
    }
  });

  it('nothing on sale with access: the plan page offers no purchase and explains nothing', async () => {
    routes(status({ ...ACTIVE_TRIAL, checkoutOptions: [] }));
    renderWithClient(<PlanPage />);
    await screen.findByText('Free Trial', { selector: 'dd' });
    expect(chooseLink()).not.toBeInTheDocument();
    expect(screen.queryByText(/can’t be bought online/)).not.toBeInTheDocument(); // has access: nothing to explain
  });
});

describe('Plan page: checkout return (Step 6 behaviour kept)', () => {
  it('back from checkout: "Confirming" until the server confirms; the URL alone never shows success', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let n = 0;
    routes(status(), {
      'GET /billing': () => (n++ < 2 ? json(200, status({ state: 'trial_expired', trialEligible: false })) : json(200, PREMIUM)),
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
    vi.useRealTimers();
  });

  it('confirmation is bounded: after the checks it offers Refresh instead of polling forever', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { called } = routes(status({ state: 'payment_pending', trialEligible: false }));
    renderWithClient(<PlanPage checkout="success" />);
    await screen.findByText(/Confirming your subscription/);
    for (let i = 0; i < 12; i++)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3100);
      });
    expect(await screen.findByText(/We haven’t received confirmation yet/)).toBeInTheDocument();
    const count = called('GET', '/billing').length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(called('GET', '/billing').length).toBe(count);
    vi.useRealTimers();
  });

  it('an unresolved plan stops the return checks and never says confirmed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { called } = routes(status({ state: 'plan_unresolved', trialEligible: false, subscription: { plan: 'unknown', cancelAtPeriodEnd: false, currentPeriodEnd: END, mapping: 'unresolved' } }));
    renderWithClient(<PlanPage checkout="success" />);
    expect(await screen.findByText(/couldn’t match it to one of our plans/)).toBeInTheDocument();
    expect(screen.queryByText(/Confirming your subscription|Your subscription is confirmed/)).not.toBeInTheDocument();
    const count = called('GET', '/billing').length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(called('GET', '/billing').length).toBe(count);
    vi.useRealTimers();
  });
});

describe('Account isolation', () => {
  it('a sign-in or sign-out drops every account’s plan, storage and AI usage from the cache', async () => {
    const qc = new QueryClient();
    qc.setQueryData(queryKeys.billing, PREMIUM);
    qc.setQueryData(queryKeys.storage, { usedBytes: 1 });
    qc.setQueryData(queryKeys.assistantUsage, { metered: true, used: 12 });
    await resetPrivateCache(qc, { id: 'another-account' });
    expect(qc.getQueryData(queryKeys.billing)).toBeUndefined();
    expect(qc.getQueryData(queryKeys.storage)).toBeUndefined();
    expect(qc.getQueryData(queryKeys.assistantUsage)).toBeUndefined();
  });
});
