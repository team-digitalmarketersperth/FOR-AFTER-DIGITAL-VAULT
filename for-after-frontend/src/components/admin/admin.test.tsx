import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { AdminMe, AdminUserDetail, AuditLog, DeathCaseDetail } from '@/lib/api/admin';
import { adminKeys, makeQueryClient, queryKeys, resetPrivateCache } from '@/lib/query/query-client';
import { customer, json, routeFetch, router } from '@/test/utils';
import { AdminLoginForm, MfaSetup, MfaVerify } from './admin-auth';
import { AdminGate } from './admin-shell';
import { AuditDetail, AuditList } from './audit-logs';
import { CaseDetail, CaseList } from './death-verifications';
import { AdminOverview } from './overview';
import { Queues } from './queues';
import { UserDetail, UserList } from './users';

vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/admin' }));

const CHALLENGE = 'c'.repeat(43);
const INVALID_MFA = 'The verification code is invalid or has expired. Sign in again if this continues.';
const ADMIN: AdminMe = {
  id: '00000000-0000-4000-8000-0000000000a1',
  email: 'admin@example.test',
  firstName: 'Ada',
  lastName: 'Admin',
  role: 'ADMIN',
  mfaEnabled: true,
  mfaVerified: true,
  mfaVerifiedAt: '2026-10-01T00:00:00.000Z',
};
const challenge = (mfaSetupRequired: boolean) => ({
  mfaRequired: true,
  mfaSetupRequired,
  challengeId: CHALLENGE,
  expiresInSeconds: 300,
});

/** The app's real QueryClient, optionally seeded (challenge, signed-in admin, …). */
function renderAdmin(ui: ReactElement, seed: [readonly unknown[], unknown][] = []) {
  const queryClient = makeQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  for (const [key, value] of seed) queryClient.setQueryData(key, value);
  return { queryClient, ...render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>) };
}
const signedIn = (me: AdminMe = ADMIN): [readonly unknown[], unknown] => [adminKeys.me, me];

async function signInWithPassword() {
  await userEvent.type(screen.getByLabelText('Email'), 'admin@example.test');
  await userEvent.type(screen.getByLabelText('Password'), 'a long admin passphrase');
  await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
}

// ─── Sign-in ────────────────────────────────────────────────────────────────

describe('Admin password step', () => {
  it.each([
    [false, '/admin/mfa/verify'],
    [true, '/admin/mfa/setup'],
  ])('a correct password only opens the second factor (setup required: %s)', async (setup, next) => {
    const api = routeFetch({ 'POST /auth/login': json(200, challenge(setup)) });
    const { queryClient } = renderAdmin(<AdminLoginForm />);
    await signInWithPassword();
    await waitFor(() => expect(router.push).toHaveBeenCalledWith(next));
    expect(router.replace).not.toHaveBeenCalledWith('/admin');
    // In memory only, and no admin session is assumed.
    expect(queryClient.getQueryData(adminKeys.challenge)).toMatchObject({ challengeId: CHALLENGE });
    expect(queryClient.getQueryData(adminKeys.me)).toBeUndefined();
    expect(api.calls.map((c) => c.path)).toEqual(['/auth/login']);
  });

  it('ends a Customer session started from the admin form and says why', async () => {
    const api = routeFetch({
      'POST /auth/login': json(200, { id: 'u1', role: 'CUSTOMER' }),
      'POST /auth/logout': json(200, { success: true }),
    });
    const { queryClient } = renderAdmin(<AdminLoginForm />);
    queryClient.setQueryData(queryKeys.me, customer);
    await signInWithPassword();
    expect(await screen.findByText('Not an administrator account')).toBeInTheDocument();
    expect(api.called('POST', '/auth/logout')).toHaveLength(1);
    // That Customer session is gone, so the Customer cache follows.
    expect(queryClient.getQueryData(queryKeys.me)).toBeNull();
    expect(router.push).not.toHaveBeenCalled();
  });

  it.each([
    [401, { message: 'Invalid email or password.' }, 'Invalid email or password.'],
    [429, { message: 'ThrottlerException: Too Many Requests' }, 'Too many attempts. Please try again shortly.'],
  ])('shows a safe message for %i and clears the password', async (status, body, message) => {
    routeFetch({ 'POST /auth/login': json(status, body) });
    renderAdmin(<AdminLoginForm />);
    await signInWithPassword();
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toHaveValue('');
  });

  it('explains an expired session once', () => {
    routeFetch({});
    renderAdmin(<AdminLoginForm />, [[adminKeys.expired, true]]);
    expect(screen.getByText('Your admin session expired. Please sign in again.')).toBeInTheDocument();
  });
});

describe('Admin TOTP verification', () => {
  const seed = (setup = false): [readonly unknown[], unknown][] => [
    [adminKeys.challenge, { ...challenge(setup), email: 'admin@example.test' }],
  ];

  it('without a challenge in memory (e.g. after refresh) asks to sign in again', () => {
    routeFetch({});
    renderAdmin(<MfaVerify />);
    expect(screen.getByRole('heading', { name: 'Please sign in again' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to sign in' })).toHaveAttribute('href', '/admin/login');
  });

  it('a valid code + /admin-auth/me opens the portal', async () => {
    const api = routeFetch({
      'POST /admin-auth/totp/verify': json(200, ADMIN),
      'GET /admin-auth/me': json(200, ADMIN),
    });
    const { queryClient } = renderAdmin(<MfaVerify />, seed());
    const code = screen.getByLabelText('6-digit code');
    expect(code).toHaveAttribute('autocomplete', 'one-time-code');
    expect(code).toHaveAttribute('inputmode', 'numeric');
    await userEvent.click(code);
    await userEvent.paste('123 456');
    await userEvent.click(screen.getByRole('button', { name: 'Verify and sign in' }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/admin'));
    expect(api.called('POST', '/admin-auth/totp/verify')[0].body).toEqual({ challengeId: CHALLENGE, code: '123456' });
    expect(queryClient.getQueryData(adminKeys.me)).toEqual(ADMIN);
    expect(queryClient.getQueryData(adminKeys.challenge)).toBeUndefined();
  });

  it.each([
    ['wrong or expired', 401, { message: INVALID_MFA }, INVALID_MFA],
    ['rate limited', 429, { message: 'Too many requests. Please try again later.' }, 'Too many attempts. Please try again shortly.'],
  ])('a %s code never enters the portal', async (_name, status, body, message) => {
    const api = routeFetch({ 'POST /admin-auth/totp/verify': json(status, body) });
    renderAdmin(<MfaVerify />, seed());
    await userEvent.type(screen.getByLabelText('6-digit code'), '000000');
    await userEvent.click(screen.getByRole('button', { name: 'Verify and sign in' }));
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getByLabelText('6-digit code')).toHaveValue('');
    expect(router.replace).not.toHaveBeenCalled();
    expect(api.called('GET', '/admin-auth/me')).toHaveLength(0);
  });

  it('checks the code shape before sending', async () => {
    const api = routeFetch({});
    renderAdmin(<MfaVerify />, seed());
    await userEvent.type(screen.getByLabelText('6-digit code'), '12a3');
    await userEvent.click(screen.getByRole('button', { name: 'Verify and sign in' }));
    expect(screen.getByText('Enter the 6 digits shown in your authenticator app.')).toBeInTheDocument();
    expect(api.calls).toHaveLength(0);
  });

  it('accepts a recovery code on its own route', async () => {
    const api = routeFetch({
      'POST /admin-auth/recovery/verify': json(200, { ...ADMIN, remainingRecoveryCodes: 9 }),
      'GET /admin-auth/me': json(200, ADMIN),
    });
    renderAdmin(<MfaVerify />, seed());
    await userEvent.click(screen.getByRole('button', { name: /Use a recovery code/ }));
    await userEvent.type(screen.getByLabelText('Recovery code'), 'ABCD-EFGH-JKLM-NPQR');
    await userEvent.click(screen.getByRole('button', { name: 'Verify and sign in' }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/admin'));
    expect(api.called('POST', '/admin-auth/recovery/verify')[0].body).toEqual({
      challengeId: CHALLENGE,
      recoveryCode: 'ABCD-EFGH-JKLM-NPQR',
    });
  });
});

describe('First-time TOTP enrollment', () => {
  const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
  const CODES = Array.from({ length: 10 }, (_, i) => `AAAA-BBBB-CCCC-${String(i).padStart(4, '0')}`);

  it('setup → QR + manual key → code → recovery codes once → portal, storing nothing', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const log = vi.spyOn(console, 'log');
    const api = routeFetch({
      'POST /admin-auth/totp/setup': json(200, {
        secret: SECRET,
        otpauthUri: `otpauth://totp/For%20After:admin%40example.test?secret=${SECRET}&issuer=For%20After`,
      }),
      'POST /admin-auth/totp/confirm': json(200, { ...ADMIN, recoveryCodes: CODES }),
      'GET /admin-auth/me': json(200, ADMIN),
    });
    renderAdmin(<MfaSetup />, [[adminKeys.challenge, { ...challenge(true), email: 'admin@example.test' }]]);

    await userEvent.click(screen.getByRole('button', { name: 'Set up my authenticator' }));
    expect(await screen.findByRole('img', { name: 'QR code for your authenticator app' })).toBeInTheDocument();
    expect(screen.getByText('JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP')).toBeInTheDocument();
    expect(api.called('POST', '/admin-auth/totp/setup')).toHaveLength(1);

    await userEvent.type(screen.getByLabelText('6-digit code'), '654321');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm and continue' }));
    expect(await screen.findByText(CODES[0])).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(10);
    // The secret is gone once enrolled; the portal waits for the acknowledgement.
    expect(screen.queryByText(/JBSW Y3DP/)).not.toBeInTheDocument();
    const go = screen.getByRole('button', { name: 'Continue to the Admin Portal' });
    expect(go).toBeDisabled();
    expect(api.called('GET', '/admin-auth/me')).toHaveLength(0);

    await userEvent.click(screen.getByLabelText(/saved these recovery codes/));
    await userEvent.click(go);
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/admin'));
    expect(api.called('POST', '/admin-auth/totp/confirm')[0].body).toEqual({ challengeId: CHALLENGE, code: '654321' });
    expect(setItem).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('a wrong first code keeps the setup on screen with a safe message', async () => {
    routeFetch({
      'POST /admin-auth/totp/setup': json(200, { secret: SECRET, otpauthUri: `otpauth://totp/x?secret=${SECRET}` }),
      'POST /admin-auth/totp/confirm': json(401, { message: INVALID_MFA }),
    });
    renderAdmin(<MfaSetup />, [[adminKeys.challenge, { ...challenge(true), email: 'a@example.test' }]]);
    await userEvent.click(screen.getByRole('button', { name: 'Set up my authenticator' }));
    await userEvent.type(await screen.findByLabelText('6-digit code'), '000000');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm and continue' }));
    expect(await screen.findByText(INVALID_MFA)).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'QR code for your authenticator app' })).toBeInTheDocument();
    expect(router.replace).not.toHaveBeenCalled();
  });
});

// ─── Gate, session, logout ──────────────────────────────────────────────────

describe('Admin gate', () => {
  it('401 → the admin sign-in, never the Customer /login', async () => {
    const api = routeFetch({ 'GET /admin-auth/me': json(401, {}) });
    renderAdmin(<AdminGate>secret admin page</AdminGate>);
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/admin/login'));
    expect(router.replace).not.toHaveBeenCalledWith('/login');
    expect(screen.queryByText('secret admin page')).not.toBeInTheDocument();
    expect(api.calls.some((c) => c.path === '/auth/me')).toBe(false);
  });

  it('403 (a Customer session) → access denied, without signing them out', async () => {
    const api = routeFetch({ 'GET /admin-auth/me': json(403, { message: 'Forbidden resource' }) });
    renderAdmin(<AdminGate>secret admin page</AdminGate>);
    expect(await screen.findByRole('heading', { name: 'Access denied' })).toBeInTheDocument();
    expect(screen.queryByText('secret admin page')).not.toBeInTheDocument();
    expect(api.called('POST', '/auth/logout')).toHaveLength(0);
  });

  it('an admin sees operational navigation only', async () => {
    routeFetch({ 'GET /admin-auth/me': json(200, ADMIN) });
    renderAdmin(<AdminGate>admin page</AdminGate>);
    expect(await screen.findByText('admin page')).toBeInTheDocument();
    const nav = screen.getAllByRole('navigation', { name: 'Admin' })[0];
    for (const label of ['Overview', 'Users', 'Death verification', 'Audit logs', 'Queues']) {
      expect(within(nav).getByRole('link', { name: label })).toBeInTheDocument();
    }
    for (const label of ['People I Love', 'Trusted Contacts', 'Messages', 'Memory Vault', 'My Story', 'My Wishes', 'Billing']) {
      expect(screen.queryByText(label)).not.toBeInTheDocument();
    }
    expect(screen.getByText(/admin@example.test/)).toBeInTheDocument();
    expect(screen.getAllByText(/Admin$/).length).toBeGreaterThan(0);
  });

  it('a server-ended session (idle timeout) clears admin data and returns to sign-in with a reason', async () => {
    routeFetch({
      'GET /admin-auth/me': json(200, ADMIN),
      'GET /admin/dashboard': json(401, {}),
    });
    const { queryClient } = renderAdmin(
      <AdminGate>
        <AdminOverview />
      </AdminGate>,
    );
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/admin/login'));
    expect(queryClient.getQueryData(adminKeys.me)).toBeNull();
    expect(queryClient.getQueryData(adminKeys.expired)).toBe(true);
    expect(queryClient.getQueryData(adminKeys.dashboard)).toBeUndefined();
  });

  it('sign out ends only the admin session, clears admin data and goes to the admin sign-in', async () => {
    const api = routeFetch({
      'GET /admin-auth/me': json(200, ADMIN),
      'POST /admin-auth/logout': json(200, { success: true }),
    });
    const { queryClient } = renderAdmin(<AdminGate>admin page</AdminGate>, [
      [adminKeys.user('x'), { id: 'x' }],
      [['trusted-contact', 'me'], { email: 'tc@example.test' }],
      [queryKeys.me, customer],
      [queryKeys.recipients, []],
    ]);
    await screen.findByText('admin page');
    await userEvent.click(screen.getAllByRole('button', { name: 'Sign out' })[0]);
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/admin/login'));
    expect(api.called('POST', '/admin-auth/logout')).toHaveLength(1);
    // The Customer session (separate cookie) is never signed out from here.
    expect(api.called('POST', '/auth/logout')).toHaveLength(0);
    expect(queryClient.getQueryData(adminKeys.user('x'))).toBeUndefined();
    expect(queryClient.getQueryData(adminKeys.expired)).toBeUndefined();
    // Other principals' sessions and data are not this sign-out's business.
    expect(queryClient.getQueryData(['trusted-contact', 'me'])).toEqual({ email: 'tc@example.test' });
    expect(queryClient.getQueryData(queryKeys.me)).toEqual(customer);
    expect(queryClient.getQueryData(queryKeys.recipients)).toEqual([]);
  });

  it('a Customer sign-out in the same tab leaves the admin session and data alone', async () => {
    const queryClient = makeQueryClient();
    queryClient.setQueryData(adminKeys.me, ADMIN);
    queryClient.setQueryData(adminKeys.user('x'), { id: 'x' });
    queryClient.setQueryData(queryKeys.recipients, []);
    await resetPrivateCache(queryClient, null);
    expect(queryClient.getQueryData(queryKeys.me)).toBeNull();
    expect(queryClient.getQueryData(queryKeys.recipients)).toBeUndefined();
    expect(queryClient.getQueryData(adminKeys.me)).toEqual(ADMIN);
    expect(queryClient.getQueryData(adminKeys.user('x'))).toEqual({ id: 'x' });
  });
});

// ─── Overview ───────────────────────────────────────────────────────────────

describe('Admin overview', () => {
  it('shows only the API’s numbers, attention first, and an unavailable queue count as such', async () => {
    routeFetch({
      'GET /admin/dashboard': json(200, {
        users: { total: 13, active: 11, suspended: 1, passed: 1, deleted: 0 },
        deathVerification: { pending: 0, safeguardActive: 1, readyForReview: 2 },
        queues: { failed: null },
      }),
    });
    renderAdmin(<AdminOverview />);
    const attention = (await screen.findByRole('heading', { name: 'Needs attention' })).closest('section')!;
    expect(within(attention).getByRole('link', { name: /2.*ready for review/i })).toHaveAttribute(
      'href',
      '/admin/death-verifications?status=READY_FOR_REVIEW',
    );
    expect(within(attention).getByText('Queue data is unavailable right now.')).toBeInTheDocument();
    expect(screen.queryByText(/revenue|subscription|growth/i)).not.toBeInTheDocument();
  });
});

// ─── Users ──────────────────────────────────────────────────────────────────

const page = <T,>(items: T[], p = { page: 1, limit: 25, total: items.length, pages: 1 }) => ({ items, pagination: p });
const USER = {
  id: '00000000-0000-4000-8000-000000000c01',
  email: 'clara@example.com',
  firstName: 'Clara',
  lastName: 'Customer',
  role: 'CUSTOMER' as const,
  status: 'ACTIVE' as const,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-02T00:00:00.000Z',
};
const detail = (over: Partial<AdminUserDetail> = {}): AdminUserDetail => ({
  ...USER,
  emailVerifiedAt: null,
  mfaEnabled: false,
  passedAt: null,
  deletedAt: null,
  counts: { recipientCount: 3, trustedContactCount: 1, messageCount: 5, releasedMessageCount: 0, memoryVaultCount: 2 },
  deathVerification: null,
  ...over,
});

describe('Users list', () => {
  it('pages, searches and filters on the server through the URL', async () => {
    const api = routeFetch({
      'GET /admin/users': json(200, page([USER], { page: 1, limit: 25, total: 60, pages: 3 })),
    });
    renderAdmin(<UserList filters={{ page: 1, status: 'ACTIVE' }} />);
    expect(await screen.findByRole('link', { name: 'Clara Customer' })).toHaveAttribute('href', `/admin/users/${USER.id}`);
    expect(api.calls[0].path).toBe('/admin/users');
    expect(screen.getByText('Page 1 of 3 · 60 results')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Next' })).toHaveAttribute('href', '/admin/users?page=2&status=ACTIVE');

    await userEvent.selectOptions(screen.getByLabelText('Role'), 'ADMIN');
    expect(router.replace).toHaveBeenLastCalledWith('/admin/users?status=ACTIVE&role=ADMIN', { scroll: false });

    await userEvent.type(screen.getByLabelText('Search'), 'clara');
    await waitFor(() =>
      expect(router.replace).toHaveBeenLastCalledWith('/admin/users?status=ACTIVE&search=clara', { scroll: false }),
    );
  });

  it('says when nothing matches', async () => {
    routeFetch({ 'GET /admin/users': json(200, page([])) });
    renderAdmin(<UserList filters={{ page: 1, search: 'nobody' }} />);
    expect(await screen.findByText('No users match these filters')).toBeInTheDocument();
  });
});

describe('User detail', () => {
  const seedMe = (me: AdminMe = ADMIN) => [signedIn(me)];

  it('shows metadata and counts only, and suspends with a required reason', async () => {
    const api = routeFetch({
      [`GET /admin/users/${USER.id}`]: json(200, detail()),
      [`POST /admin/users/${USER.id}/suspend`]: json(200, { ...USER, status: 'SUSPENDED' }),
    });
    const { queryClient } = renderAdmin(<UserDetail id={USER.id} />, seedMe());
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    expect(await screen.findByRole('heading', { name: 'Clara Customer' })).toBeInTheDocument();
    expect(screen.getByText('Memory Vault items')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Suspend account…' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/stored content is/)).toHaveTextContent('Their stored content is not deleted');
    const confirm = within(dialog).getByRole('button', { name: 'Suspend account' });
    expect(confirm).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText('Reason'), '  Reported abuse  ');
    await userEvent.click(confirm);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(api.called('POST', `/admin/users/${USER.id}/suspend`)[0].body).toEqual({ reason: 'Reported abuse' });
    const keys = invalidate.mock.calls.map(([f]) => f?.queryKey);
    expect(keys).toEqual(expect.arrayContaining([adminKeys.users, adminKeys.dashboard, adminKeys.auditLogs]));
  });

  it('offers reactivation for a suspended Customer', async () => {
    const api = routeFetch({
      [`GET /admin/users/${USER.id}`]: json(200, detail({ status: 'SUSPENDED' })),
      [`POST /admin/users/${USER.id}/reactivate`]: json(200, USER),
    });
    renderAdmin(<UserDetail id={USER.id} />, seedMe());
    await userEvent.click(await screen.findByRole('button', { name: 'Reactivate account…' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Reactivate account' }));
    await waitFor(() => expect(api.called('POST', `/admin/users/${USER.id}/reactivate`)).toHaveLength(1));
    expect(api.called('POST', `/admin/users/${USER.id}/reactivate`)[0].body).toEqual({});
  });

  it('never offers to reactivate a PASSED account', async () => {
    routeFetch({ [`GET /admin/users/${USER.id}`]: json(200, detail({ status: 'PASSED', passedAt: '2026-09-20T00:00:00Z' })) });
    renderAdmin(<UserDetail id={USER.id} />, seedMe());
    expect(await screen.findByText(/death has been verified/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Reactivate|Suspend/ })).not.toBeInTheDocument();
  });

  it('shows the API’s 409 if the account changed meanwhile', async () => {
    routeFetch({
      [`GET /admin/users/${USER.id}`]: json(200, detail({ status: 'SUSPENDED' })),
      [`POST /admin/users/${USER.id}/reactivate`]: json(409, {
        message: 'This account holder has a verified death. Their status cannot be changed here.',
      }),
    });
    renderAdmin(<UserDetail id={USER.id} />, seedMe());
    await userEvent.click(await screen.findByRole('button', { name: 'Reactivate account…' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Reactivate account' }));
    expect(await screen.findByText(/verified death/)).toBeInTheDocument();
  });

  it.each([
    ['an ADMIN looking at another admin', ADMIN, { role: 'ADMIN' as const, id: '00000000-0000-4000-8000-0000000000b2' }, /Only a super admin/],
    ['anyone looking at a SUPER_ADMIN', { ...ADMIN, role: 'SUPER_ADMIN' as const }, { role: 'SUPER_ADMIN' as const }, /Super admin accounts/],
    ['an admin looking at themselves', ADMIN, { id: ADMIN.id, role: 'ADMIN' as const }, /your own account/],
  ])('offers no status change to %s', async (_n, me, over, note) => {
    routeFetch({ [`GET /admin/users/${USER.id}`]: json(200, detail(over)) });
    renderAdmin(<UserDetail id={USER.id} />, seedMe(me));
    expect(await screen.findByText(note)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Suspend|Reactivate/ })).not.toBeInTheDocument();
  });
});

// ─── Death verification ─────────────────────────────────────────────────────

const CASE_ID = '00000000-0000-4000-8000-00000000ca5e';
const deathCase = (over: Partial<DeathCaseDetail> = {}): DeathCaseDetail => ({
  caseId: CASE_ID,
  status: 'READY_FOR_REVIEW',
  openedAt: '2026-09-10T00:00:00.000Z',
  resolvedAt: null,
  safetyNoticeSentAt: '2026-09-10T00:01:00.000Z',
  safetyNoticeLastAttemptAt: '2026-09-10T00:01:00.000Z',
  safetyNoticeAttemptCount: 1,
  safeguardStartedAt: '2026-09-10T00:01:00.000Z',
  safeguardEndsAt: '2026-09-24T00:01:00.000Z',
  verifiedAt: null,
  verifiedDeathAt: null,
  verifiedByUserId: null,
  rejectedAt: null,
  rejectedByUserId: null,
  cancelledAt: null,
  adminDecisionNote: null,
  deathTriggersActivatedAt: null,
  accountHolder: { userId: USER.id, email: USER.email, displayName: 'Clara Customer', accountStatus: 'ACTIVE' },
  reportCount: 1,
  reports: [
    {
      id: 'r1',
      reportedByTrustedContactId: 't1',
      reporterFirstNameSnapshot: 'Tom',
      reporterLastNameSnapshot: 'Trusted',
      reporterEmailNormalized: 'tom@example.com',
      reporterMobileNormalized: null,
      reportedDateOfDeath: '2026-09-08',
      note: 'She passed peacefully.',
      createdAt: '2026-09-10T00:00:00.000Z',
    },
  ],
  auditEvents: [
    { eventType: 'REPORT_RECEIVED', actorType: 'TRUSTED_CONTACT', actorUserId: null, actorTrustedContactId: 't1', createdAt: '2026-09-10T00:00:00.000Z' },
    { eventType: 'SAFETY_NOTICE_SENT', actorType: 'SYSTEM', actorUserId: null, actorTrustedContactId: null, createdAt: '2026-09-10T00:01:00.000Z' },
  ],
  activations: [],
  ...over,
});

describe('Death verification list', () => {
  it('makes READY_FOR_REVIEW easy to reach and filters through the URL', async () => {
    routeFetch({ 'GET /admin/death-verifications': json(200, page([])) });
    renderAdmin(<CaseList filters={{ page: 1, status: 'READY_FOR_REVIEW' }} />);
    expect(await screen.findByText('No cases ready for review')).toBeInTheDocument();
    const chips = screen.getByRole('navigation', { name: 'Filter by status' });
    expect(within(chips).getAllByRole('link')[1]).toHaveTextContent('Ready for review');
    expect(within(chips).getByRole('link', { name: 'Ready for review' })).toHaveAttribute('aria-current', 'true');
    expect(within(chips).getByRole('link', { name: 'Cancelled' })).toHaveAttribute(
      'href',
      '/admin/death-verifications?status=CANCELLED',
    );
  });
});

describe('Death verification case', () => {
  it('shows reports and the real timeline, never decision controls during the safeguard', async () => {
    routeFetch({ [`GET /admin/death-verifications/${CASE_ID}`]: json(200, deathCase({ status: 'SAFEGUARD_ACTIVE' })) });
    renderAdmin(<CaseDetail id={CASE_ID} />);
    expect(await screen.findByText('She passed peacefully.')).toBeInTheDocument();
    expect(screen.getByText('Safety notice sent to the account holder')).toBeInTheDocument();
    expect(screen.getByText(/Review isn.t available yet/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Verify|Reject/ })).not.toBeInTheDocument();
  });

  it.each(['VERIFIED', 'REJECTED', 'CANCELLED'] as const)('%s is read-only', async (status) => {
    routeFetch({ [`GET /admin/death-verifications/${CASE_ID}`]: json(200, deathCase({ status })) });
    renderAdmin(<CaseDetail id={CASE_ID} />);
    await screen.findByText('She passed peacefully.');
    expect(screen.queryByRole('button', { name: /Verify|Reject|Reopen|Force/ })).not.toBeInTheDocument();
  });

  it('verify needs an explicit, non-future time of death and a ticked confirmation', async () => {
    const api = routeFetch({
      [`GET /admin/death-verifications/${CASE_ID}`]: json(200, deathCase()),
      [`POST /admin/death-verifications/${CASE_ID}/verify`]: json(200, deathCase({ status: 'VERIFIED' })),
    });
    renderAdmin(<CaseDetail id={CASE_ID} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Verify death…' }));
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Verify death' });
    // Not pre-filled from the trusted contact's reported date.
    expect(within(dialog).getByLabelText('Date')).toHaveValue('');
    expect(within(dialog).getByText(/for reference only/)).toBeInTheDocument();

    await userEvent.type(within(dialog).getByLabelText('Date'), '2999-01-01');
    await userEvent.type(within(dialog).getByLabelText('Time'), '10:30');
    await userEvent.click(within(dialog).getByLabelText(/confirm the death of Clara Customer/));
    expect(within(dialog).getByText('The time of death can’t be in the future.'.replace('’', "'"))).toBeInTheDocument();
    expect(confirm).toBeDisabled();

    await userEvent.clear(within(dialog).getByLabelText('Date'));
    await userEvent.type(within(dialog).getByLabelText('Date'), '2026-09-08');
    expect(confirm).toBeEnabled();
    await userEvent.click(confirm);
    await waitFor(() => expect(api.called('POST', `/admin/death-verifications/${CASE_ID}/verify`)).toHaveLength(1));
    const body = api.called('POST', `/admin/death-verifications/${CASE_ID}/verify`)[0].body as Record<string, unknown>;
    expect(body).toMatchObject({ confirmVerification: true, decisionNote: null });
    expect(body.verifiedDeathAt).toMatch(/^2026-09-08T10:30:00[+-]\d{2}:\d{2}$/);
    // The frontend never releases anything itself.
    expect(api.calls.every((c) => !/release|messages/.test(c.path))).toBe(true);
  });

  it('reject sends the confirmation and optional note', async () => {
    const api = routeFetch({
      [`GET /admin/death-verifications/${CASE_ID}`]: json(200, deathCase()),
      [`POST /admin/death-verifications/${CASE_ID}/reject`]: json(200, deathCase({ status: 'REJECTED' })),
    });
    renderAdmin(<CaseDetail id={CASE_ID} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Reject report…' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText(/Decision note/), 'Duplicate report');
    await userEvent.click(within(dialog).getByLabelText(/should be rejected/));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reject report' }));
    await waitFor(() => expect(api.called('POST', `/admin/death-verifications/${CASE_ID}/reject`)).toHaveLength(1));
    expect(api.called('POST', `/admin/death-verifications/${CASE_ID}/reject`)[0].body).toEqual({
      confirmRejection: true,
      decisionNote: 'Duplicate report',
    });
  });

  it('a stale case (account holder confirmed alive) → 409, refetch, no more decision controls', async () => {
    let status: DeathCaseDetail['status'] = 'READY_FOR_REVIEW';
    routeFetch({
      [`GET /admin/death-verifications/${CASE_ID}`]: () => json(200, deathCase({ status })),
      [`POST /admin/death-verifications/${CASE_ID}/reject`]: () => {
        status = 'CANCELLED';
        return json(409, { message: 'This case was cancelled by the account holder.' });
      },
    });
    renderAdmin(<CaseDetail id={CASE_ID} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Reject report…' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByLabelText(/should be rejected/));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reject report' }));
    expect(await screen.findByText('This case changed while you were reviewing it')).toBeInTheDocument();
    expect(await screen.findByText(/confirmed they.re alive/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Verify death|Reject report/ })).not.toBeInTheDocument();
  });
});

// ─── Audit ──────────────────────────────────────────────────────────────────

const AUDIT: AuditLog = {
  id: '00000000-0000-4000-8000-00000000a0d1',
  eventType: 'USER_SUSPENDED',
  actorType: 'ADMIN',
  actorUserId: ADMIN.id,
  subjectType: 'User',
  subjectId: USER.id,
  ipPrefix: '203.0.113.0/24',
  userAgent: 'Test browser',
  metadata: { previousStatus: 'ACTIVE', newStatus: 'SUSPENDED', reason: 'Reported abuse' },
  createdAt: '2026-10-01T01:00:00.000Z',
};

describe('Audit logs', () => {
  it('lists events with a concise summary and applies filters through the URL', async () => {
    const api = routeFetch({ 'GET /admin/audit-logs': json(200, page([AUDIT])) });
    renderAdmin(<AuditList filters={{ page: 1, from: '2026-09-01' }} />);
    expect(await screen.findByRole('link', { name: 'User suspended' })).toHaveAttribute('href', `/admin/audit-logs/${AUDIT.id}`);
    expect(screen.getByText('active → suspended')).toBeInTheDocument();
    // A calendar day becomes the start of that day, with this browser's offset.
    expect(api.calls[0]).toBeDefined();
    expect(screen.queryByRole('button', { name: /Edit|Delete/ })).not.toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Actor user ID'), 'not-a-uuid');
    await userEvent.click(screen.getByRole('button', { name: 'Apply filters' }));
    expect(screen.getByText('Enter a full user ID.')).toBeInTheDocument();
    expect(router.replace).not.toHaveBeenCalled();

    await userEvent.clear(screen.getByLabelText('Actor user ID'));
    await userEvent.selectOptions(screen.getByLabelText('Event'), 'USER_SUSPENDED');
    await userEvent.click(screen.getByRole('button', { name: 'Apply filters' }));
    expect(router.replace).toHaveBeenCalledWith('/admin/audit-logs?from=2026-09-01&eventType=USER_SUSPENDED', {
      scroll: false,
    });
  });

  it('sends the date range as ISO instants with an offset', async () => {
    const seen: URL[] = [];
    routeFetch({ 'GET /admin/audit-logs': (_b, url) => (seen.push(url), json(200, page([]))) });
    renderAdmin(<AuditList filters={{ page: 1, from: '2026-09-01', to: '2026-09-30' }} />);
    expect(await screen.findByText('No audit events match these filters')).toBeInTheDocument();
    expect(seen[0].searchParams.get('from')).toMatch(/^2026-09-01T00:00:00[+-]\d{2}:\d{2}$/);
    expect(seen[0].searchParams.get('to')).toMatch(/^2026-09-30T23:59:59\.999[+-]\d{2}:\d{2}$/);
  });

  it('detail shows sanitized metadata and never secret-looking keys', async () => {
    routeFetch({
      [`GET /admin/audit-logs/${AUDIT.id}`]: json(200, {
        ...AUDIT,
        metadata: { ...AUDIT.metadata, recoveryCode: 'LEAK-LEAK-LEAK-LEAK', sessionId: 's3cr3t' },
      }),
    });
    renderAdmin(<AuditDetail id={AUDIT.id} />);
    expect(await screen.findByText('Reported abuse')).toBeInTheDocument();
    expect(screen.getByText('Previous status')).toBeInTheDocument();
    expect(screen.getByText('203.0.113.0/24')).toBeInTheDocument();
    expect(screen.queryByText(/LEAK|s3cr3t/)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: USER.id })).toHaveAttribute('href', `/admin/users/${USER.id}`);
  });
});

// ─── Queues ─────────────────────────────────────────────────────────────────

const QUEUES = [
  { name: 'message-release', waiting: 0, active: 0, delayed: 2, prioritized: 0, failed: 1, completed: 40 },
  { name: 'death-verification', waiting: 0, active: 0, delayed: 1, prioritized: 0, failed: 0, completed: 3 },
];
const JOB = {
  jobId: 'message-release-00000000-0000-4000-8000-00000000e55a',
  queue: 'message-release',
  name: 'release',
  attemptsMade: 5,
  maxAttempts: 5,
  failedReasonSanitized: 'connect ECONNREFUSED [url]',
  createdAt: '2026-09-30T00:00:00.000Z',
  failedAt: '2026-09-30T00:05:00.000Z',
  payload: { messageId: '00000000-0000-4000-8000-00000000e55a' },
};

describe('Queues', () => {
  it('summarises the allowlisted queues and shows failed jobs of the one with failures', async () => {
    const api = routeFetch({
      'GET /admin/system/queues': json(200, QUEUES),
      'GET /admin/system/queues/message-release/failed': json(200, page([JOB])),
    });
    renderAdmin(<Queues filters={{ page: 1, queue: 'not-a-real-queue' }} />);
    expect(await screen.findByText('connect ECONNREFUSED [url]')).toBeInTheDocument();
    expect(screen.getByText('5 of 5')).toBeInTheDocument();
    // An unknown ?queue= is never sent to the API.
    expect(api.calls.some((c) => c.path.includes('not-a-real-queue'))).toBe(false);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('retry asks first, never says "release", and shows a 409', async () => {
    const api = routeFetch({
      'GET /admin/system/queues': json(200, QUEUES),
      'GET /admin/system/queues/message-release/failed': json(200, page([JOB])),
      [`POST /admin/system/queues/message-release/jobs/${JOB.jobId}/retry`]: json(409, {
        message: 'Only failed jobs can be retried.',
      }),
    });
    renderAdmin(<Queues filters={{ page: 1 }} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Retry this job?' })).toBeInTheDocument();
    expect(within(dialog).queryByText(/force release/i)).not.toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Retry job' }));
    expect(await within(dialog).findByText('Only failed jobs can be retried.')).toBeInTheDocument();
    expect(api.called('POST', `/admin/system/queues/message-release/jobs/${JOB.jobId}/retry`)).toHaveLength(1);
  });

  it('an email-delivery job shows only its notification id (Step 24)', async () => {
    const id = '00000000-0000-4000-8000-0000000e4a11';
    const emailJob = {
      ...JOB,
      jobId: `release-notification-${id}`,
      queue: 'email-delivery',
      name: 'message-released',
      attemptsMade: 5,
      failedReasonSanitized: 'email_send_failed: rate_limit_exceeded',
      payload: { notificationId: id },
    };
    routeFetch({
      'GET /admin/system/queues': json(200, [
        ...QUEUES.map((q) => ({ ...q, failed: 0 })),
        { name: 'email-delivery', waiting: 0, active: 0, delayed: 0, prioritized: 0, failed: 1, completed: 9 },
      ]),
      'GET /admin/system/queues/email-delivery/failed': json(200, page([emailJob])),
    });
    renderAdmin(<Queues filters={{ page: 1 }} />);
    expect(await screen.findByText('email_send_failed: rate_limit_exceeded')).toBeInTheDocument();
    expect(screen.getByText('Email 00000000…')).toHaveAttribute('title', id);
    expect(screen.queryByText(/@/)).not.toBeInTheDocument();
  });

  it('retry success refreshes the queue data', async () => {
    const api = routeFetch({
      'GET /admin/system/queues': json(200, QUEUES),
      'GET /admin/system/queues/message-release/failed': json(200, page([JOB])),
      [`POST /admin/system/queues/message-release/jobs/${JOB.jobId}/retry`]: json(200, {
        queue: 'message-release',
        jobId: JOB.jobId,
        state: 'waiting',
      }),
    });
    renderAdmin(<Queues filters={{ page: 1 }} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Retry job' }));
    await waitFor(() => expect(api.called('GET', '/admin/system/queues')).toHaveLength(2));
    await act(async () => {});
  });
});
