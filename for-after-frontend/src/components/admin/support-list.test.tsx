import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminSupportFilters, AdminSupportSummary, SupportPage } from '@/lib/api/admin';
import type { SupportStatus } from '@/lib/api/support';
import { makeQueryClient } from '@/lib/query/query-client';
import { json, routeFetch, router } from '@/test/utils';
import { AdminSupportList } from './support';

vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/admin/support' }));

// Fictional requests only.
const NOW = '2026-11-09T06:00:00.000Z';
const ZERO: Record<SupportStatus, number> = { OPEN: 0, IN_PROGRESS: 0, WAITING_FOR_CUSTOMER: 0, RESOLVED: 0 };
const req = (n: number, over: Partial<AdminSupportSummary> = {}): AdminSupportSummary => ({
  id: `7d6f1d8e-3c55-4a3a-9f1e-${String(n).padStart(12, '0')}`,
  subject: `Subject ${n}`,
  category: 'TECHNICAL',
  status: 'OPEN',
  createdAt: '2026-11-01T02:00:00.000Z',
  lastPublicActivityAt: '2026-11-02T03:00:00.000Z',
  ownerUserId: `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`,
  ...over,
});
const supportPage = (items: AdminSupportSummary[], counts: Partial<Record<SupportStatus, number>> = {}, total?: number): SupportPage => {
  const c = { ...ZERO, ...counts };
  const t = total ?? Object.values(c).reduce((a, b) => a + b, 0);
  return { items, counts: c, evaluatedAt: NOW, pagination: { page: 1, limit: 25, total: t, pages: Math.max(1, Math.ceil(t / 25)) } };
};

function renderList(filters: AdminSupportFilters = { page: 1 }) {
  const queryClient = makeQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  const ui = (f: AdminSupportFilters): ReactElement => (
    <QueryClientProvider client={queryClient}>
      <AdminSupportList filters={f} />
    </QueryClientProvider>
  );
  const r = render(ui(filters));
  return { ...r, rerenderWith: (f: AdminSupportFilters) => r.rerender(ui(f)) };
}
const card = (label: string) => within(screen.getByRole('region', { name: 'Request summary' })).getByText(label).parentElement!;
const tabs = () => within(screen.getByRole('navigation', { name: 'Filter by status' }));

beforeEach(() => vi.clearAllMocks());

describe('Support inbox list', () => {
  it('the existing single resolved request: counted, every status shown, nothing open', async () => {
    routeFetch({ 'GET /admin/support/requests': json(200, supportPage([req(1, { status: 'RESOLVED' })], { RESOLVED: 1 })) });
    renderList();
    expect(await screen.findByRole('heading', { level: 1, name: 'Support' })).toBeInTheDocument();
    expect(screen.getByText('Only support requests are visible. Private legacy content stays private.')).toBeInTheDocument();
    await screen.findByText('Subject 1');
    expect(within(card('Total requests')).getByText('1')).toBeInTheDocument();
    expect(within(card('Resolved')).getByText('1')).toBeInTheDocument();
    expect(within(card('Waiting for customer')).getByText('0')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Requests by status: Open 0 (0%), In progress 0 (0%), Waiting for customer 0 (0%), Resolved 1 (100%). Total 1.' })).toBeInTheDocument();
    expect(screen.getByText('No open requests in this selection.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /View open requests/ })).not.toBeInTheDocument();
    expect(screen.getByText('All statuses · requests all time')).toBeInTheDocument();
  });

  it('empty: zero counts, empty bar, "No support requests yet"', async () => {
    routeFetch({ 'GET /admin/support/requests': json(200, supportPage([])) });
    renderList();
    expect(await screen.findByText('No support requests yet')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Requests by status: No requests. Total 0.' })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/NaN|Infinity/);
  });

  it('mixed: cards, bar and tabs use server counts beyond the page and reconcile; Needs attention filters to Open', async () => {
    routeFetch({
      'GET /admin/support/requests': json(200, supportPage([req(1)], { OPEN: 8, IN_PROGRESS: 5, WAITING_FOR_CUSTOMER: 2, RESOLVED: 9 })),
    });
    renderList({ page: 1, category: 'TECHNICAL' });
    await screen.findByText('Subject 1');
    expect(within(card('Total requests')).getByText('24')).toBeInTheDocument();
    expect(within(card('Open')).getByText('8')).toBeInTheDocument();
    expect(within(card('In progress')).getByText('5')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /Open 8 \(33%\), In progress 5 \(21%\), Waiting for customer 2 \(8%\), Resolved 9 \(38%\)\. Total 24\./ })).toBeInTheDocument();
    expect(tabs().getByRole('link', { name: 'All 24' })).toHaveAttribute('aria-current', 'true');
    expect(tabs().getByRole('link', { name: 'Waiting for customer 2' })).toHaveAttribute('href', '/admin/support?category=TECHNICAL&status=WAITING_FOR_CUSTOMER');
    expect(screen.getByRole('link', { name: /View open requests/ })).toHaveAttribute('href', '/admin/support?category=TECHNICAL&status=OPEN#support-inbox');
    expect(screen.getByText('All statuses · requests in Technical issue, all time')).toBeInTheDocument();
  });

  it('a status tab narrows the table only; counts stay across all statuses', async () => {
    routeFetch({ 'GET /admin/support/requests': json(200, supportPage([req(1)], { OPEN: 1, RESOLVED: 3 }, 1)) });
    renderList({ page: 1, status: 'OPEN' });
    await screen.findByText('Subject 1');
    expect(within(card('Total requests')).getByText('4')).toBeInTheDocument();
    expect(tabs().getByRole('link', { name: 'Open 1' })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('button', { name: /Status: Open/ })).toBeInTheDocument();
  });

  it('table: subject as text (never HTML), short reference with full value on request, account filter link, real activity time', async () => {
    const r = req(1, { subject: '<img src=x onerror=alert(1)> <b>bold</b>' });
    routeFetch({ 'GET /admin/support/requests': json(200, supportPage([r], { OPEN: 1 })) });
    const { container } = renderList();
    await screen.findByText('<img src=x onerror=alert(1)> <b>bold</b>');
    expect(container.querySelector('img[src="x"], b')).toBeNull();
    const row = within(screen.getByRole('table', { name: 'Support requests' }));
    expect(row.getByText(r.id)).toBeInTheDocument(); // inside the details element
    expect(row.getByRole('button', { name: /Copy/ })).toBeInTheDocument();
    expect(row.getByRole('link', { name: /show this account’s requests/ })).toHaveAttribute('href', `/admin/support?accountId=${r.ownerUserId}`);
    expect(row.getByRole('link', { name: `View request: ${r.subject}` })).toHaveAttribute('href', `/admin/support/${r.id}`);
    expect(screen.getByText(/never internal notes/)).toBeInTheDocument();
  });

  it('search is debounced through the URL; More filters keep the Apply step and validate dates', async () => {
    routeFetch({ 'GET /admin/support/requests': json(200, supportPage([req(1)], { OPEN: 1 })) });
    renderList({ page: 1, status: 'OPEN' });
    await screen.findByText('Subject 1');
    await userEvent.type(screen.getByLabelText('Search subject or full reference'), 'photo');
    await waitFor(() => expect(router.replace).toHaveBeenLastCalledWith('/admin/support?status=OPEN&search=photo', { scroll: false }));
    expect(router.replace.mock.calls.filter(([h]) => String(h).includes('search='))).toHaveLength(1);

    router.replace.mockClear();
    await userEvent.click(screen.getByText('More filters', { selector: 'summary' }));
    await userEvent.type(screen.getByLabelText('Created from'), '2026-11-05');
    await userEvent.type(screen.getByLabelText('Created to'), '2026-11-01');
    await userEvent.click(screen.getByRole('button', { name: 'Apply filters' }));
    expect(await screen.findByText('Must be on or after the start date.')).toBeInTheDocument();
    expect(router.replace).not.toHaveBeenCalled();
    await userEvent.clear(screen.getByLabelText('Created to'));
    await userEvent.type(screen.getByLabelText('Created to'), '2026-11-06');
    await userEvent.click(screen.getByRole('button', { name: 'Apply filters' }));
    expect(router.replace).toHaveBeenLastCalledWith('/admin/support?status=OPEN&from=2026-11-05&to=2026-11-06', { scroll: false });
  });

  it('dates go to the API as whole local days (inclusive end) and the applied range is labelled', async () => {
    const api = routeFetch({ 'GET /admin/support/requests': json(200, supportPage([req(1)], { OPEN: 1 })) });
    renderList({ page: 1, from: '2026-11-01', to: '2026-11-02' });
    await screen.findByText('Subject 1');
    const url = new URL(String(vi.mocked(fetch).mock.calls[0]![0]));
    expect(url.searchParams.get('from')).toMatch(/^2026-11-01T00:00:00[+-]\d\d:\d\d$/);
    expect(url.searchParams.get('to')).toMatch(/^2026-11-02T23:59:59\.999[+-]\d\d:\d\d$/);
    expect(api.calls).toHaveLength(1);
    expect(screen.getByText('All statuses · requests created 1 November 2026 to 2 November 2026')).toBeInTheDocument();
    expect(screen.getByText('More filters', { selector: 'summary' }).closest('details')).toHaveAttribute('open');
  });

  it('active filters show and clear; no matches offers Clear filters', async () => {
    routeFetch({ 'GET /admin/support/requests': json(200, supportPage([])) });
    renderList({ page: 1, search: 'nothing', category: 'OTHER' });
    expect(await screen.findByText('No requests match these filters')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Category: Other/ }));
    expect(router.replace).toHaveBeenLastCalledWith('/admin/support?search=nothing', { scroll: false });
    const clear = screen.getAllByRole('button', { name: 'Clear filters' });
    await userEvent.click(clear[0]!);
    expect(router.replace).toHaveBeenLastCalledWith('/admin/support', { scroll: false });
  });

  it('pages on the server and keeps filters in page links', async () => {
    routeFetch({ 'GET /admin/support/requests': json(200, supportPage([req(1)], { OPEN: 30 })) });
    renderList({ page: 1, status: 'OPEN' });
    await screen.findByText('Subject 1');
    expect(screen.getByRole('link', { name: 'Next' })).toHaveAttribute('href', '/admin/support?page=2&status=OPEN');
  });

  it('a slow response for an older search never replaces the newer one', async () => {
    let releaseOld!: () => void;
    routeFetch({
      'GET /admin/support/requests': (_b, url) =>
        url.searchParams.get('search') === 'old'
          ? new Promise<Response>((resolve) => {
              releaseOld = () => resolve(json(200, supportPage([req(1)], { OPEN: 1 })));
            })
          : json(200, supportPage([req(2)], { OPEN: 1 })),
    });
    const { rerenderWith } = renderList({ page: 1, search: 'old' });
    await waitFor(() => expect(releaseOld).toBeTypeOf('function'));
    rerenderWith({ page: 1, search: 'new' });
    await screen.findByText('Subject 2');
    releaseOld();
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText('Subject 1')).not.toBeInTheDocument();
  });

  it('Refresh only reads; a failed refresh keeps the last results with a notice', async () => {
    let n = 0;
    const api = routeFetch({
      'GET /admin/support/requests': () => (++n === 2 ? json(500, { message: 'Internal server error' }) : json(200, supportPage([req(1)], { OPEN: 1 }))),
    });
    renderList();
    await screen.findByText('Subject 1');
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Couldn’t refresh/);
    expect(screen.getByText('Subject 1')).toBeInTheDocument();
    expect(api.calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('a failed first load is an error with Try again, not zero counts', async () => {
    routeFetch({ 'GET /admin/support/requests': json(500, { message: 'Internal server error' }) });
    renderList();
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Request summary' })).not.toBeInTheDocument();
  });

  it('keyboard: Tab reaches View request', async () => {
    routeFetch({ 'GET /admin/support/requests': json(200, supportPage([req(1)], { OPEN: 1 })) });
    renderList();
    const link = await screen.findByRole('link', { name: 'View request: Subject 1' });
    for (let i = 0; i < 40 && document.activeElement !== link; i += 1) await userEvent.tab();
    expect(link).toHaveFocus();
  });
});
