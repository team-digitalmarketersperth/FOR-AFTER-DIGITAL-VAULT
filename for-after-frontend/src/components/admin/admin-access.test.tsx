import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AdminAccount, AdminAccountDetail } from '@/lib/api/admin';
import { json, renderWithClient, routeFetch, router } from '@/test/utils';
import { AdminAccessDetail, AdminAccessList } from './admin-access';

vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/admin/access' }));

const ID = '22222222-2222-4222-8222-222222222222';
const ROOT = '33333333-3333-4333-8333-333333333333';
const T = '2026-10-31T02:00:00.000Z';
const account = (over: Partial<AdminAccount> = {}): AdminAccount => ({
  id: ID,
  email: 'ben.test@example.test',
  firstName: 'Ben',
  lastName: 'Test',
  role: 'ADMIN',
  status: 'ACTIVE',
  createdAt: T,
  mfaEnrolled: true,
  lastSignInAt: T,
  invitationPending: false,
  ...over,
});
const detail = (over: Partial<AdminAccountDetail> = {}): AdminAccountDetail => ({
  ...account(),
  mfaEnrolledAt: T,
  permissions: { adminPortal: true, manageCustomerAccounts: true, manageAdminAccounts: false, manageSuperAdminAccounts: false, changeRoles: false },
  viewerCanManage: false,
  history: [
    { reference: '44444444-4444-4444-8444-444444444444', eventType: 'USER_SUSPENDED', actorType: 'SUPER_ADMIN', actorUserId: ROOT, previousStatus: 'ACTIVE', newStatus: 'SUSPENDED', recordedAt: T },
  ],
  ...over,
});

describe('Admin access', () => {
  it('list: role, account status and two-factor enrolment kept apart; unknown sign-in stays unknown; view only', async () => {
    routeFetch({
      'GET /admin/access/admins': json(200, {
        items: [account(), account({ id: ROOT, email: 'fresh@example.test', firstName: 'Fresh', role: 'SUPER_ADMIN', status: 'SUSPENDED', mfaEnrolled: false, lastSignInAt: null })],
        pagination: { page: 1, limit: 25, total: 2, pages: 1 },
      }),
    });
    renderWithClient(<AdminAccessList filters={{ page: 1 }} />);
    const table = await screen.findByRole('table', { name: 'Administrators' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(within(rows[0]!).getByRole('link', { name: /Ben Test/ })).toHaveAttribute('href', `/admin/access/${ID}`);
    expect(within(rows[0]!).getByText('Two-factor enrolled')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Two-factor not enrolled')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('None recorded')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Suspended')).toBeInTheDocument();
    // View only: no mutation controls anywhere.
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Apply filters']);
    expect(document.body.textContent).not.toMatch(/promote|demote|reset two-factor|recovery code|secret/i);
  });

  it('detail: server permissions in plain words, history with status change, no controls when not permitted', async () => {
    routeFetch({ [`GET /admin/access/admins/${ID}`]: json(200, detail()) });
    renderWithClient(<AdminAccessDetail id={ID} />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Ben Test' })).toBeInTheDocument();
    const row = (text: string) => screen.getByText(text, { exact: false, selector: 'li > span' }).textContent;
    expect(row('Suspend and reactivate customer accounts')).toBe('Allowed: Suspend and reactivate customer accounts');
    expect(row('Suspend and reactivate admin accounts')).toBe('Not allowed: Suspend and reactivate admin accounts');
    expect(row('Change anyone’s role')).toBe('Not allowed: Change anyone’s role');
    expect(screen.getByText('Active → Suspended')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'User suspended' })).toHaveAttribute('href', '/admin/audit-logs/44444444-4444-4444-8444-444444444444');
    expect(screen.getByText('You can’t change this account’s access.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Suspend or reactivate/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText(/applies to the whole account/)).toBeInTheDocument();
  });

  it('detail: a permitted viewer is sent to the existing Users page (no new mutation here)', async () => {
    routeFetch({ [`GET /admin/access/admins/${ID}`]: json(200, detail({ viewerCanManage: true, mfaEnrolled: false, mfaEnrolledAt: null, lastSignInAt: null, history: [] })) });
    renderWithClient(<AdminAccessDetail id={ID} />);
    expect(await screen.findByRole('link', { name: 'Suspend or reactivate on the user page' })).toHaveAttribute('href', `/admin/users/${ID}`);
    expect(screen.getByText('Not enrolled')).toBeInTheDocument();
    expect(screen.getByText('None recorded')).toBeInTheDocument();
    expect(screen.getByText(/No suspensions, reactivations or two-factor setups recorded/)).toBeInTheDocument();
  });

  it('not found and errors are said plainly', async () => {
    routeFetch({ [`GET /admin/access/admins/${ID}`]: json(404, { message: 'Administrator not found.' }) });
    renderWithClient(<AdminAccessDetail id={ID} />);
    expect(await screen.findByText('We couldn’t find this administrator')).toBeInTheDocument();
  });

  it('filters go through the URL', async () => {
    routeFetch({ 'GET /admin/access/admins': json(200, { items: [account()], pagination: { page: 1, limit: 25, total: 1, pages: 1 } }) });
    renderWithClient(<AdminAccessList filters={{ page: 1 }} />);
    await screen.findByRole('table', { name: 'Administrators' });
    router.replace.mockClear();
    await userEvent.selectOptions(screen.getByLabelText('Two-factor'), 'not_enrolled');
    await userEvent.click(screen.getByRole('button', { name: 'Apply filters' }));
    expect(router.replace).toHaveBeenCalledWith(expect.stringMatching(/mfa=not_enrolled/), expect.anything());
  });
});
