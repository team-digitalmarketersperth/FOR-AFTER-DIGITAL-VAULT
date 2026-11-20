import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CaseFilters, CasePage, DeathCaseSummary } from '@/lib/api/admin';
import type { CaseStatus } from '@/lib/api/portals';
import { makeQueryClient } from '@/lib/query/query-client';
import { json, routeFetch, router } from '@/test/utils';
import { CaseList, safeguardText } from './death-verifications';

vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/admin/death-verifications' }));

// Fictional cases only. Server time is fixed; the browser clock is never used.
const NOW = '2026-11-09T06:00:00.000Z';
const ZERO: Record<CaseStatus, number> = {
  PENDING_VERIFICATION: 0,
  SAFEGUARD_ACTIVE: 0,
  READY_FOR_REVIEW: 0,
  VERIFIED: 0,
  REJECTED: 0,
  CANCELLED: 0,
};
const kase = (n: number, over: Partial<DeathCaseSummary> = {}): DeathCaseSummary => ({
  caseId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  status: 'READY_FOR_REVIEW',
  openedAt: '2026-10-20T00:00:00.000Z',
  safetyNotice: 'provider_accepted',
  safeguardStartedAt: '2026-10-20T01:00:00.000Z',
  safeguardEndsAt: '2026-11-03T01:00:00.000Z',
  reportCount: 1,
  receivedConfirmations: 1,
  requiredConfirmations: 1,
  confirmationRequirementMet: true,
  accountHolder: { userId: `u${n}`, email: `holder${n}@example.test`, displayName: `Holder ${n}` },
  ...over,
});
const casePage = (
  items: DeathCaseSummary[],
  counts: Partial<Record<CaseStatus, number>> = {},
  over: Partial<CasePage> = {},
): CasePage => {
  const c = { ...ZERO, ...counts };
  const total = over.pagination?.total ?? Object.values(c).reduce((a, b) => a + b, 0);
  return {
    items,
    counts: c,
    evaluatedAt: NOW,
    readyAwaitingConfirmations: 0,
    pagination: { page: 1, limit: 25, total, pages: Math.max(1, Math.ceil(total / 25)) },
    ...over,
  };
};

function renderList(filters: CaseFilters = { page: 1 }) {
  const queryClient = makeQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  const ui = (f: CaseFilters): ReactElement => (
    <QueryClientProvider client={queryClient}>
      <CaseList filters={f} />
    </QueryClientProvider>
  );
  const r = render(ui(filters));
  return { ...r, rerenderWith: (f: CaseFilters) => r.rerender(ui(f)) };
}
const cards = () => within(screen.getByRole('region', { name: 'Case summary' }));
const card = (label: string) => cards().getByText(label).parentElement!;
const row = (name: string) => within(screen.getByText(name).closest('tr')!);

beforeEach(() => vi.clearAllMocks());

describe('Death verification list', () => {
  it('the existing single cancelled case: counted, closed, not decision-ready', async () => {
    const one = kase(1, { status: 'CANCELLED', safetyNotice: 'provider_accepted' });
    routeFetch({ 'GET /admin/death-verifications': json(200, casePage([one], { CANCELLED: 1 })) });
    renderList();
    expect(await screen.findByRole('heading', { level: 1, name: 'Death verification' })).toBeInTheDocument();
    await screen.findByText('Holder 1');
    expect(within(card('Total cases')).getByText('1')).toBeInTheDocument();
    expect(within(card('Ready for review')).getByText('0')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /Cancelled 1 \(100%\).*Total 1\./ })).toBeInTheDocument();
    expect(row('Holder 1').getByText('Closed')).toBeInTheDocument();
    expect(row('Holder 1').getByRole('link', { name: /^View case/ })).toHaveAttribute('href', `/admin/death-verifications/${one.caseId}`);
    expect(row('Holder 1').queryByText(/Review case/)).not.toBeInTheDocument();
    expect(screen.getByText('No case is approved automatically.')).toBeInTheDocument();
    expect(screen.getByText('All cases, all time, every status')).toBeInTheDocument();
  });

  it('no cases at all: zero cards, empty chart without NaN, and "No death reports yet"', async () => {
    routeFetch({ 'GET /admin/death-verifications': json(200, casePage([])) });
    renderList();
    expect(await screen.findByText('No death reports yet')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Cases by status: No cases. Total 0.' })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/NaN|Infinity/);
  });

  it('mixed statuses: categories reconcile with the total and come from server counts, not the page', async () => {
    const counts = { READY_FOR_REVIEW: 3, SAFEGUARD_ACTIVE: 4, PENDING_VERIFICATION: 2, VERIFIED: 1, REJECTED: 1, CANCELLED: 1 };
    routeFetch({
      'GET /admin/death-verifications': json(200, casePage([kase(1)], counts, { readyAwaitingConfirmations: 2 })),
    });
    renderList();
    await screen.findByText('Holder 1');
    expect(within(card('Total cases')).getByText('12')).toBeInTheDocument();
    expect(within(card('Ready for review')).getByText('3')).toBeInTheDocument();
    expect(within(card('Safeguard active')).getByText('4')).toBeInTheDocument();
    expect(within(card('Pending verification')).getByText('2')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /Ready for review 3 \(25%\), Safeguard active 4 \(33%\), Pending verification 2 \(17%\), Verified 1 \(8%\), Rejected 1 \(8%\), Cancelled 1 \(8%\)\. Total 12\./ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /3 ready for review.*2 need another confirmation/ })).toHaveAttribute('href', '/admin/death-verifications?status=READY_FOR_REVIEW');
    expect(screen.getByRole('link', { name: /4 in the safeguard period/ })).toHaveAttribute('href', '/admin/death-verifications?status=SAFEGUARD_ACTIVE');
    const tabs = within(screen.getByRole('navigation', { name: 'Filter by status' }));
    expect(tabs.getByRole('link', { name: 'All 12' })).toHaveAttribute('aria-current', 'true');
    expect(tabs.getByRole('link', { name: 'Ready 3' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Rejected (1)' })).toBeInTheDocument();
  });

  it('a status filter narrows the table, but the tabs and cards keep counts across all statuses', async () => {
    routeFetch({
      'GET /admin/death-verifications': json(
        200,
        casePage([kase(1)], { READY_FOR_REVIEW: 1, CANCELLED: 5 }, { pagination: { page: 1, limit: 25, total: 1, pages: 1 } }),
      ),
    });
    renderList({ page: 1, status: 'READY_FOR_REVIEW' });
    await screen.findByText('Holder 1');
    expect(within(card('Total cases')).getByText('6')).toBeInTheDocument();
    const tabs = within(screen.getByRole('navigation', { name: 'Filter by status' }));
    expect(tabs.getByRole('link', { name: 'Ready 1' })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByText('Status: Ready for review')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(router.replace).toHaveBeenLastCalledWith('/admin/death-verifications', { scroll: false });
  });

  it('notice states use the recorded labels: queued is never "sent", accepted is not "received"', async () => {
    routeFetch({
      'GET /admin/death-verifications': json(
        200,
        casePage(
          [
            kase(1, { status: 'PENDING_VERIFICATION', safetyNotice: 'queued', safeguardStartedAt: null, safeguardEndsAt: null }),
            kase(2, { status: 'PENDING_VERIFICATION', safetyNotice: 'attempted', safeguardStartedAt: null, safeguardEndsAt: null }),
            kase(3, { status: 'SAFEGUARD_ACTIVE', safeguardEndsAt: '2026-11-20T00:00:00.000Z' }),
            kase(4, { status: 'REJECTED', safetyNotice: 'not_sent_case_closed', safeguardEndsAt: null }),
          ],
          { PENDING_VERIFICATION: 2, SAFEGUARD_ACTIVE: 1, REJECTED: 1 },
        ),
      ),
    });
    renderList();
    await screen.findByText('Holder 1');
    expect(row('Holder 1').getByText('Waiting to send')).toBeInTheDocument();
    expect(row('Holder 1').getByText('Not started')).toBeInTheDocument();
    expect(row('Holder 2').getByText('Attempted, not accepted yet')).toBeInTheDocument();
    expect(row('Holder 3').getByText('Accepted by the email provider')).toBeInTheDocument();
    expect(row('Holder 3').getByText(/^Ends /)).toBeInTheDocument();
    expect(row('Holder 4').getByText('Not sent (case closed)')).toBeInTheDocument();
    expect(row('Holder 4').getByText('Closed')).toBeInTheDocument();
    for (const n of [1, 2, 3, 4]) {
      expect(row(`Holder ${n}`).queryByText(/^(Sent|Delivered|Received)$/i)).not.toBeInTheDocument();
    }
  });

  it('ready but short of confirmations: says so; the decision itself stays in the case page', async () => {
    routeFetch({
      'GET /admin/death-verifications': json(
        200,
        casePage([kase(1, { reportCount: 2, receivedConfirmations: 1, requiredConfirmations: 2, confirmationRequirementMet: false })], { READY_FOR_REVIEW: 1 }, { readyAwaitingConfirmations: 1 }),
      ),
    });
    renderList();
    await screen.findByText('Holder 1');
    expect(row('Holder 1').getByText('Confirmations 1 of 2')).toBeInTheDocument();
    expect(row('Holder 1').getByText('2')).toBeInTheDocument(); // reports, not people
    expect(row('Holder 1').getByRole('link', { name: /^Review case/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Verify|Reject|Release/ })).not.toBeInTheDocument();
  });

  it('an unavailable confirmation check reads "Unavailable", not zero', async () => {
    routeFetch({ 'GET /admin/death-verifications': json(200, casePage([kase(1)], { READY_FOR_REVIEW: 1 }, { readyAwaitingConfirmations: null })) });
    renderList();
    expect(await screen.findByText('Confirmation check unavailable')).toBeInTheDocument();
  });

  it('search and the More statuses select go through the URL; search is debounced', async () => {
    routeFetch({ 'GET /admin/death-verifications': json(200, casePage([kase(1)], { READY_FOR_REVIEW: 1 })) });
    renderList();
    await screen.findByText('Holder 1');
    await userEvent.selectOptions(screen.getByLabelText('More statuses'), 'VERIFIED');
    expect(router.replace).toHaveBeenLastCalledWith('/admin/death-verifications?status=VERIFIED', { scroll: false });
    await userEvent.type(screen.getByLabelText('Search account or case ID'), 'holder');
    await waitFor(() => expect(router.replace).toHaveBeenLastCalledWith('/admin/death-verifications?search=holder', { scroll: false }));
    expect(router.replace.mock.calls.filter(([h]) => String(h).includes('search='))).toHaveLength(1);
  });

  it('search scope is labelled; no matches offers Clear filters', async () => {
    routeFetch({ 'GET /admin/death-verifications': json(200, casePage([])) });
    renderList({ page: 1, search: 'nobody' });
    expect(await screen.findByText('No cases match these filters')).toBeInTheDocument();
    expect(screen.getByText('Cases matching “nobody”, all time, every status')).toBeInTheDocument();
  });

  it('pages on the server and keeps filters in page links', async () => {
    routeFetch({
      'GET /admin/death-verifications': json(200, casePage([kase(1)], { READY_FOR_REVIEW: 30 }, { pagination: { page: 1, limit: 25, total: 30, pages: 2 } })),
    });
    renderList({ page: 1, status: 'READY_FOR_REVIEW' });
    await screen.findByText('Holder 1');
    expect(screen.getByRole('link', { name: 'Next' })).toHaveAttribute('href', '/admin/death-verifications?page=2&status=READY_FOR_REVIEW');
  });

  it('a slow response for an older search never replaces the newer one', async () => {
    let releaseOld!: () => void;
    routeFetch({
      'GET /admin/death-verifications': (_b, url) =>
        url.searchParams.get('search') === 'old'
          ? new Promise<Response>((resolve) => {
              releaseOld = () => resolve(json(200, casePage([kase(1)], { READY_FOR_REVIEW: 1 })));
            })
          : json(200, casePage([kase(2)], { READY_FOR_REVIEW: 1 })),
    });
    const { rerenderWith } = renderList({ page: 1, search: 'old' });
    await waitFor(() => expect(releaseOld).toBeTypeOf('function'));
    rerenderWith({ page: 1, search: 'new' });
    await screen.findByText('Holder 2');
    releaseOld();
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText('Holder 1')).not.toBeInTheDocument();
  });

  it('Refresh is a GET only; a failed refresh keeps the last data with a notice; first-load failure is an error, not zeros', async () => {
    let n = 0;
    const api = routeFetch({
      'GET /admin/death-verifications': () => (++n === 2 ? json(500, { message: 'Internal server error' }) : json(200, casePage([kase(1)], { READY_FOR_REVIEW: 1 }))),
    });
    renderList();
    await screen.findByText('Holder 1');
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Couldn’t refresh/);
    expect(screen.getByText('Holder 1')).toBeInTheDocument();
    expect(api.calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('first load failure shows an error with Try again and no counts', async () => {
    routeFetch({ 'GET /admin/death-verifications': json(500, { message: 'Internal server error' }) });
    renderList();
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Case summary' })).not.toBeInTheDocument();
  });

  it('keyboard: Tab reaches the case link', async () => {
    routeFetch({ 'GET /admin/death-verifications': json(200, casePage([kase(1)], { READY_FOR_REVIEW: 1 })) });
    renderList();
    const link = await screen.findByRole('link', { name: 'Review case: Holder 1' });
    for (let i = 0; i < 40 && document.activeElement !== link; i += 1) await userEvent.tab();
    expect(link).toHaveFocus();
  });
});

describe('safeguardText (server time only)', () => {
  const base = kase(1, { status: 'SAFEGUARD_ACTIVE', safeguardEndsAt: '2026-11-09T06:00:00.000Z' });
  it('at the exact boundary the period has ended, by server time, but the status has not moved yet', () => {
    expect(safeguardText(base, '2026-11-09T05:59:59.999Z')).toMatch(/^Ends /);
    expect(safeguardText(base, '2026-11-09T06:00:00.000Z')).toMatch(/^Ended .*status not updated yet$/);
  });
  it('terminal and pending cases never read as waiting; missing timestamps read Unavailable', () => {
    expect(safeguardText({ ...base, status: 'CANCELLED' }, NOW)).toBe('Closed');
    expect(safeguardText({ ...base, status: 'REJECTED' }, NOW)).toBe('Closed');
    expect(safeguardText({ ...base, status: 'PENDING_VERIFICATION' }, NOW)).toBe('Not started');
    expect(safeguardText({ ...base, status: 'READY_FOR_REVIEW', safeguardEndsAt: null }, NOW)).toBe('Unavailable');
    expect(safeguardText({ ...base, status: 'VERIFIED' }, NOW)).toMatch(/^Ended /);
  });
});
