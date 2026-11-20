import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminUser, BillingSummary, UserFilters, UserPage, UserSummary } from '@/lib/api/admin';
import { makeQueryClient } from '@/lib/query/query-client';
import { json, routeFetch, router } from '@/test/utils';
import { UserList } from './users';

vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/admin/users' }));

// Fictional fixtures only.
const user = (n: number, over: Partial<AdminUser> = {}): AdminUser => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  email: `person${n}@example.test`,
  firstName: `First${n}`,
  lastName: `Last${n}`,
  role: 'CUSTOMER',
  status: 'ACTIVE',
  emailVerifiedAt: '2026-10-01T00:00:00.000Z',
  createdAt: '2026-10-05T00:00:00.000Z',
  updatedAt: '2026-10-05T00:00:00.000Z',
  ...over,
});
const billing = (state: BillingSummary['state'], id: string): BillingSummary => ({
  accountId: id,
  email: 'x@example.test',
  firstName: null,
  lastName: null,
  accountCreatedAt: '2026-10-05T00:00:00.000Z',
  state,
  hasAccess: true,
  trialStartedAt: null,
  trialEndsAt: null,
  plan: null,
  subscriptionStatus: null,
  subscriptionReference: null,
  cancelAtPeriodEnd: false,
  currentPeriodEnd: null,
  lastSyncedAt: null,
});
const summary = (over: Partial<UserSummary> = {}): UserSummary => ({
  generatedAt: '2026-11-09T02:05:00.000Z',
  total: 60,
  active: 55,
  emailVerified: 45,
  customers: 50,
  ...over,
});
const userPage = (items: AdminUser[], s: Partial<UserSummary> = {}, p?: Partial<UserPage['pagination']>): UserPage => {
  const sum = summary(s);
  return {
    items,
    pagination: { page: 1, limit: 25, total: sum.total, pages: Math.max(1, Math.ceil(sum.total / 25)), ...p },
    summary: sum,
  };
};

function renderList(filters: UserFilters = { page: 1 }) {
  const queryClient = makeQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  const ui = (f: UserFilters): ReactElement => (
    <QueryClientProvider client={queryClient}>
      <UserList filters={f} />
    </QueryClientProvider>
  );
  const r = render(ui(filters));
  return { ...r, rerenderWith: (f: UserFilters) => r.rerender(ui(f)) };
}

const bar = (name: string) => screen.getByRole('progressbar', { name });
const card = (label: string) =>
  within(screen.getByRole('region', { name: /^Summary of the selected/ })).getByText(label).parentElement!;

beforeEach(() => vi.clearAllMocks());

describe('Users page', () => {
  it('cards and tracker use the server totals for the whole selection, not the rows on this page', async () => {
    routeFetch({ 'GET /admin/users': json(200, userPage([user(1)])) });
    renderList();
    expect(await screen.findByRole('heading', { level: 1, name: 'Users' })).toBeInTheDocument();
    expect(screen.getByText('Account metadata only. Private customer content is never shown.')).toBeInTheDocument();
    await screen.findByText('First1 Last1');
    expect(within(card('Total users')).getByText('60')).toBeInTheDocument();
    expect(within(card('Active accounts')).getByText('55')).toBeInTheDocument();
    expect(within(card('Email verified')).getByText('45')).toBeInTheDocument();
    expect(bar('Email verification')).toHaveAttribute('aria-valuenow', '75');
    expect(bar('Email verification')).toHaveAttribute('aria-valuetext', '45 of 60 verified (75%)');
    expect(bar('Account status')).toHaveAttribute('aria-valuenow', '92');
    expect(screen.getByText('55 of 60 active')).toBeInTheDocument();
    expect(screen.getByText('Verification, account status and billing are tracked independently.')).toBeInTheDocument();
    // Needs review filters the table to unverified accounts (60 − 45).
    expect(screen.getByRole('link', { name: /15 emails unverified/ })).toHaveAttribute('href', '/admin/users?verification=unverified');
    expect(screen.getByText(/^Last updated /)).toBeInTheDocument();
  });

  it('an ADMIN viewer gets no billing numbers and no Plan column: absent, never shown as zero', async () => {
    routeFetch({ 'GET /admin/users': json(200, userPage([user(1)])) });
    renderList();
    await screen.findByText('First1 Last1');
    expect(screen.queryByText('No billing record')).not.toBeInTheDocument();
    expect(screen.queryByRole('progressbar', { name: 'Billing records' })).not.toBeInTheDocument();
    expect(screen.getByText('Billing records are visible to super admins only.')).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Plan' })).not.toBeInTheDocument();
  });

  it('SUPER_ADMIN, customers: billing card, tracker and Plan from the resolver; unavailable is not "No billing record"', async () => {
    const rows = [
      user(1, { billing: billing('trial_active', 'a') }),
      user(2, { billing: billing('no_billing_record', 'b') }),
      user(3, { billing: billing('payment_issue', 'c') }),
      user(4, { billing: billing('cancellation_scheduled', 'd') }),
      user(5, { billing: null }),
    ];
    routeFetch({ 'GET /admin/users': json(200, userPage(rows, { total: 50, customers: 50, customersWithBillingRecord: 20 })) });
    renderList({ page: 1, role: 'CUSTOMER' });
    await screen.findByText('First1 Last1');
    expect(within(card('Total customers')).getByText('50')).toBeInTheDocument();
    expect(within(card('No billing record')).getByText('30')).toBeInTheDocument();
    expect(bar('Billing records')).toHaveAttribute('aria-valuenow', '40');
    expect(screen.getByText('20 of 50 recorded')).toBeInTheDocument();
    expect(screen.getByText('30 without billing records')).toBeInTheDocument();
    expect(screen.getByText('No billing record does not mean unpaid.')).toBeInTheDocument();
    const plan = (n: number) => within(screen.getByText(`First${n} Last${n}`).closest('tr')!);
    expect(plan(1).getByText('Free trial')).toBeInTheDocument();
    expect(plan(2).getByText('No billing record')).toBeInTheDocument();
    expect(plan(3).getByText('Payment issue')).toBeInTheDocument();
    expect(plan(4).getByText('Cancels at period end')).toBeInTheDocument();
    expect(plan(5).getByText('Unavailable')).toBeInTheDocument();
    expect(plan(5).queryByText('No billing record')).not.toBeInTheDocument();
    // A role filter already says who everyone is.
    expect(plan(1).queryByText('Customer')).not.toBeInTheDocument();
  });

  it('non-customer role selection: labels adapt and customer billing metrics are hidden', async () => {
    const admin = user(7, { role: 'ADMIN', billing: null });
    routeFetch({
      'GET /admin/users': json(200, userPage([admin], { total: 3, active: 3, emailVerified: 3, customers: 0, customersWithBillingRecord: 0 })),
    });
    renderList({ page: 1, role: 'ADMIN' });
    await screen.findByText('First7 Last7');
    expect(within(card('Total admins')).getByText('3')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'All admins' })).toBeInTheDocument();
    expect(screen.queryByText('No billing record')).not.toBeInTheDocument();
    expect(screen.queryByRole('progressbar', { name: 'Billing records' })).not.toBeInTheDocument();
    expect(screen.queryByText('Billing records are visible to super admins only.')).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Plan' })).not.toBeInTheDocument();
    expect(screen.getByText('Every email address is verified')).toBeInTheDocument();
  });

  it('mixed roles: each row names its role; admins show no plan; states are never shown as Active', async () => {
    routeFetch({
      'GET /admin/users': json(
        200,
        userPage(
          [
            user(1, { status: 'SUSPENDED', emailVerifiedAt: null, billing: billing('no_billing_record', 'a') }),
            user(2, { role: 'SUPER_ADMIN', status: 'ACTIVE', billing: null }),
            user(3, { status: 'PASSED', billing: billing('access_ended', 'c') }),
            user(4, { status: 'DELETED', billing: billing('no_billing_record', 'd') }),
          ],
          { customersWithBillingRecord: 10 },
        ),
      ),
    });
    renderList();
    await screen.findByText('First1 Last1');
    const row = (n: number) => within(screen.getByText(`First${n} Last${n}`).closest('tr')!);
    expect(row(1).getByText('Suspended')).toBeInTheDocument();
    expect(row(1).getByText('Unverified')).toBeInTheDocument();
    expect(row(1).getByText('Customer')).toBeInTheDocument();
    expect(row(2).getByText('Super admin')).toBeInTheDocument();
    expect(row(2).getByText('Not applicable')).toBeInTheDocument();
    expect(row(3).getByText('Passed')).toBeInTheDocument();
    expect(row(4).getByText('Deleted')).toBeInTheDocument();
    for (const n of [1, 3, 4]) expect(row(n).queryByText('Active')).not.toBeInTheDocument();
  });

  it('zero accounts: empty bars without dividing by zero, and "No users yet"', async () => {
    routeFetch({
      'GET /admin/users': json(200, userPage([], { total: 0, active: 0, emailVerified: 0, customers: 0, customersWithBillingRecord: 0 })),
    });
    renderList();
    expect(await screen.findByText('No users yet')).toBeInTheDocument();
    for (const name of ['Email verification', 'Account status', 'Billing records']) {
      expect(bar(name)).toHaveAttribute('aria-valuenow', '0');
      expect(bar(name).getAttribute('aria-valuetext')).not.toMatch(/NaN/);
    }
    expect(screen.getAllByText('No users')).toHaveLength(2);
    expect(screen.getByText('No customers')).toBeInTheDocument();
    expect(screen.getByText('No unverified email addresses')).toBeInTheDocument();
    expect(screen.getByText('No customers in this selection')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/NaN|Infinity/);
  });

  it('all verified and all with billing records: calm notes instead of review items', async () => {
    routeFetch({
      'GET /admin/users': json(200, userPage([user(1)], { total: 4, active: 2, emailVerified: 4, customers: 4, customersWithBillingRecord: 4 })),
    });
    renderList();
    await screen.findByText('First1 Last1');
    expect(bar('Email verification')).toHaveAttribute('aria-valuenow', '100');
    expect(bar('Account status')).toHaveAttribute('aria-valuenow', '50');
    expect(screen.getByText('Every email address is verified')).toBeInTheDocument();
    expect(screen.getByText('Every customer has a billing record')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /unverified/ })).not.toBeInTheDocument();
  });

  it('filters, search and pages live in the URL; chips and Clear filters remove them', async () => {
    const api = routeFetch({ 'GET /admin/users': json(200, userPage([user(1)], {}, { page: 1, pages: 3 })) });
    renderList({ page: 1, status: 'ACTIVE', verification: 'unverified' });
    await screen.findByText('First1 Last1');
    expect(api.calls[0].path).toBe('/admin/users');
    expect(screen.getByRole('link', { name: 'Next' })).toHaveAttribute('href', '/admin/users?page=2&status=ACTIVE&verification=unverified');
    expect(screen.getByRole('navigation', { name: 'Pagination' })).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText('Role'), 'ADMIN');
    expect(router.replace).toHaveBeenLastCalledWith('/admin/users?status=ACTIVE&verification=unverified&role=ADMIN', { scroll: false });
    await userEvent.selectOptions(screen.getByLabelText('Verification'), 'verified');
    expect(router.replace).toHaveBeenLastCalledWith('/admin/users?status=ACTIVE&verification=verified', { scroll: false });

    await userEvent.type(screen.getByLabelText('Search name or email'), 'first');
    await waitFor(() =>
      expect(router.replace).toHaveBeenLastCalledWith('/admin/users?status=ACTIVE&verification=unverified&search=first', { scroll: false }),
    );
    // Debounced: one navigation for the whole word.
    expect(router.replace.mock.calls.filter(([href]) => String(href).includes('search='))).toHaveLength(1);

    await userEvent.click(screen.getByRole('button', { name: /Status: Active/ }));
    expect(router.replace).toHaveBeenLastCalledWith('/admin/users?verification=unverified', { scroll: false });
    await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(router.replace).toHaveBeenLastCalledWith('/admin/users', { scroll: false });
  });

  it('no matches under filters offers Clear filters', async () => {
    routeFetch({ 'GET /admin/users': json(200, userPage([], { total: 0, active: 0, emailVerified: 0, customers: 0 })) });
    renderList({ page: 1, search: 'nobody' });
    expect(await screen.findByText('No users match these filters')).toBeInTheDocument();
    const clear = screen.getAllByRole('button', { name: 'Clear filters' });
    await userEvent.click(clear[clear.length - 1]);
    expect(router.replace).toHaveBeenLastCalledWith('/admin/users', { scroll: false });
  });

  it('a slow response for an older search never replaces the newer one', async () => {
    let releaseOld!: () => void;
    routeFetch({
      'GET /admin/users': (_b, url) => {
        if (url.searchParams.get('search') === 'old') {
          return new Promise<Response>((resolve) => {
            releaseOld = () => resolve(json(200, userPage([user(1)], { total: 1 })));
          });
        }
        return json(200, userPage([user(2)], { total: 1 }));
      },
    });
    const { rerenderWith } = renderList({ page: 1, search: 'old' });
    await waitFor(() => expect(releaseOld).toBeTypeOf('function'));
    rerenderWith({ page: 1, search: 'new' });
    await screen.findByText('First2 Last2');
    releaseOld();
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByText('First2 Last2')).toBeInTheDocument();
    expect(screen.queryByText('First1 Last1')).not.toBeInTheDocument();
  });

  it('Refresh reads again (disabled meanwhile); a failed refresh keeps the last results and says so', async () => {
    let n = 0;
    const api = routeFetch({
      'GET /admin/users': () => {
        n += 1;
        if (n === 2) return json(200, userPage([user(1)], { generatedAt: '2026-11-09T03:30:00.000Z' }));
        if (n === 3) return json(500, { message: 'Internal server error' });
        return json(200, userPage([user(1)]));
      },
    });
    renderList();
    await screen.findByText('First1 Last1');
    const first = screen.getByText(/^Last updated /).textContent;
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(screen.getByText(/^Last updated /).textContent).not.toBe(first));
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled();
    const second = screen.getByText(/^Last updated /).textContent;

    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Couldn’t refresh/);
    expect(screen.getByText('First1 Last1')).toBeInTheDocument();
    expect(screen.getByText(/^Last updated /).textContent).toBe(second);
    expect(api.calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('a failed first load shows an error with Try again', async () => {
    routeFetch({ 'GET /admin/users': json(500, { message: 'Internal server error' }) });
    renderList();
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('View account opens the existing detail route and is reachable by keyboard', async () => {
    const u = user(1, { firstName: null, lastName: null });
    routeFetch({ 'GET /admin/users': json(200, userPage([u], { total: 1, emailVerified: 1, active: 1 })) });
    renderList();
    const link = await screen.findByRole('link', { name: `View account: ${u.email}` });
    expect(link).toHaveAttribute('href', `/admin/users/${u.id}`);
    expect(screen.getByText('No name')).toBeInTheDocument();
    expect(within(link.closest('tr')!).getByText('P')).toBeInTheDocument(); // initial from the email
    for (let i = 0; i < 20 && document.activeElement !== link; i += 1) await userEvent.tab();
    expect(link).toHaveFocus();
  });
});
