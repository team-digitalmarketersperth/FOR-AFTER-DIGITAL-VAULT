import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AdminAccountDetail } from '@/lib/api/admin';
import { ResetPasswordForm } from '@/components/auth/account-links';
import { json, renderWithClient, routeFetch, router } from '@/test/utils';
import { AdminAccessDetail, AdminAccessList, CreateAdminPage } from './admin-access';

vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/admin/access' }));

const ID = '22222222-2222-4222-8222-222222222222';
const T = '2026-10-31T02:00:00.000Z';
const me = (role: 'ADMIN' | 'SUPER_ADMIN') => ({ id: 'me', email: 'me@example.test', firstName: 'Me', lastName: null, role, mfaEnabled: true, mfaVerified: true, mfaVerifiedAt: T });
const emptyList = json(200, { items: [], pagination: { page: 1, limit: 25, total: 0, pages: 0 } });
const pending: AdminAccountDetail = {
  id: ID,
  email: 'new.admin@example.test',
  firstName: 'New',
  lastName: 'Admin',
  role: 'ADMIN',
  status: 'ACTIVE',
  createdAt: T,
  mfaEnrolled: false,
  lastSignInAt: null,
  invitationPending: true,
  mfaEnrolledAt: null,
  permissions: { adminPortal: true, manageCustomerAccounts: true, manageAdminAccounts: false, manageSuperAdminAccounts: false, changeRoles: false },
  viewerCanManage: true,
  history: [],
};

describe('Create admin', () => {
  it('the header button is for SUPER_ADMIN only', async () => {
    routeFetch({ 'GET /admin-auth/me': json(200, me('ADMIN')), 'GET /admin/access/admins': emptyList });
    const { unmount } = renderWithClient(<AdminAccessList filters={{ page: 1 }} />);
    await screen.findByText('No administrator accounts');
    expect(screen.queryByRole('link', { name: 'Create admin' })).not.toBeInTheDocument();
    unmount();
    routeFetch({ 'GET /admin-auth/me': json(200, me('SUPER_ADMIN')), 'GET /admin/access/admins': emptyList });
    renderWithClient(<AdminAccessList filters={{ page: 1 }} />);
    expect(await screen.findByRole('link', { name: 'Create admin' })).toHaveAttribute('href', '/admin/access/new');
  });

  it('validates, sends names + email only (no role), once; says the email was accepted by the provider, not delivered', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { called } = routeFetch({
      'GET /admin-auth/me': json(200, me('SUPER_ADMIN')),
      'POST /admin/access/admins': (() => gate.then(() => json(201, { id: ID, invitation: 'sent' }))) as unknown as () => Response,
    });
    renderWithClient(<CreateAdminPage />);
    const submit = await screen.findByRole('button', { name: 'Create admin and send invitation' });
    await userEvent.click(submit);
    expect(screen.getByText('Enter a first name.')).toBeInTheDocument();
    expect(screen.getByText('Enter a valid email address.')).toBeInTheDocument();
    expect(called('POST', '/admin/access/admins')).toHaveLength(0);

    await userEvent.type(screen.getByLabelText('First name'), ' New ');
    await userEvent.type(screen.getByLabelText('Last name'), 'Admin');
    await userEvent.type(screen.getByLabelText('Email'), 'new.admin@example.test');
    await userEvent.dblClick(submit);
    expect(called('POST', '/admin/access/admins')).toHaveLength(1);
    expect(called('POST', '/admin/access/admins')[0]!.body).toEqual({ firstName: 'New', lastName: 'Admin', email: 'new.admin@example.test' });
    release();
    expect(await screen.findByText(/accepted by the email provider/)).toBeInTheDocument();
    expect(screen.queryByText(/delivered/i)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View admin' })).toHaveAttribute('href', `/admin/access/${ID}`);
  });

  it('server refusals keep the form: duplicate email, or a sign-in that is too old', async () => {
    let n = 0;
    routeFetch({
      'GET /admin-auth/me': json(200, me('SUPER_ADMIN')),
      'POST /admin/access/admins': () =>
        n++ === 0
          ? json(409, { message: 'An account with this email already exists.' })
          : json(403, { message: 'For your security, sign in again (with two-factor) to create an admin.' }),
    });
    renderWithClient(<CreateAdminPage />);
    await userEvent.type(await screen.findByLabelText('First name'), 'New');
    await userEvent.type(screen.getByLabelText('Last name'), 'Admin');
    await userEvent.type(screen.getByLabelText('Email'), 'lisa@example.test');
    await userEvent.click(screen.getByRole('button', { name: 'Create admin and send invitation' }));
    expect(await screen.findByText('An account with this email already exists.')).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveValue('lisa@example.test');
    await userEvent.click(screen.getByRole('button', { name: 'Create admin and send invitation' }));
    expect(await screen.findByText(/sign in again \(with two-factor\)/)).toBeInTheDocument();
  });

  it('a failed invitation email is reported honestly; resend is on the admin page for a pending invitation', async () => {
    routeFetch({
      'GET /admin-auth/me': json(200, me('SUPER_ADMIN')),
      [`GET /admin/access/admins/${ID}`]: json(200, pending),
      [`POST /admin/access/admins/${ID}/invitation`]: json(200, { id: ID, invitation: 'not_sent' }),
    });
    renderWithClient(<AdminAccessDetail id={ID} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Resend invitation' }));
    expect(await screen.findByText(/could not be sent/)).toBeInTheDocument();
  });

  it('invitation link page: sets the password with the normal rule, then points to admin sign-in; bad links say so', async () => {
    const { called } = routeFetch({ 'POST /auth/admin-invitation/accept': json(200, { success: true }) });
    const token = 'A'.repeat(43);
    const { unmount } = renderWithClient(<ResetPasswordForm admin token={token} />);
    await userEvent.type(screen.getByLabelText('New password'), 'AnotherStrong123!');
    await userEvent.type(screen.getByLabelText('Confirm new password'), 'AnotherStrong123!');
    await userEvent.click(screen.getByRole('button', { name: 'Set password' }));
    expect(await screen.findByText('Your password is set')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to admin sign-in' })).toHaveAttribute('href', '/admin/login');
    expect(called('POST', '/auth/admin-invitation/accept')[0]!.body).toEqual({ token, newPassword: 'AnotherStrong123!' });
    unmount();
    renderWithClient(<ResetPasswordForm admin />);
    await waitFor(() => expect(screen.getByText(/invitation link can.t be used/)).toBeInTheDocument());
  });
});
