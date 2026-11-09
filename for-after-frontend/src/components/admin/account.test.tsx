import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminMe, OwnAdminAccount } from '@/lib/api/admin';
import { makeQueryClient } from '@/lib/query/query-client';
import { json, routeFetch, router } from '@/test/utils';
import { AdminAccountSettings } from './account';
import { AdminGate } from './admin-shell';

vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/admin/account' }));

// Fictional admin; fetch is mocked, nothing is sent anywhere.
const ME: AdminMe = {
  id: '00000000-0000-4000-8000-0000000000a1',
  email: 'ada.admin.with.a.rather.long.address@example.test',
  firstName: 'Ada',
  lastName: 'Admin',
  role: 'ADMIN',
  mfaEnabled: true,
  mfaVerified: true,
  mfaVerifiedAt: '2026-11-03T00:00:00.000Z',
};
const T = '2026-11-03T03:00:00.000Z';
const account = (over: Partial<OwnAdminAccount['profile']> = {}, sec: Partial<OwnAdminAccount['security']> = {}): OwnAdminAccount => ({
  profile: { firstName: 'Ada', lastName: 'Admin', email: ME.email, emailVerified: true, role: 'ADMIN', ...over },
  security: { twoFactorEnabled: true, twoFactorEnabledAt: T, recoveryCodesRemaining: 9, passwordChangedAt: null, ...sec },
  session: { signedInAt: T, twoFactorAt: T, idleTimeoutMinutes: 30, expiresAt: '2026-11-10T03:00:00.000Z' },
  recentSignIns: [{ at: T, network: '203.0.113.0/24', device: 'Mozilla/5.0 <script>alert(1)</script>' }],
});

function renderAdmin(ui: ReactElement) {
  const queryClient = makeQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  return { queryClient, ...render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>) };
}
const routes = (over: Record<string, Response | ((b: unknown) => Response)> = {}) =>
  routeFetch({ 'GET /admin-auth/me': json(200, ME), 'GET /admin/account': json(200, account()), ...over });
const page = () => renderAdmin(<AdminGate><AdminAccountSettings /></AdminGate>);

describe('Admin account menu (top right)', () => {
  beforeEach(() => window.history.replaceState(null, '', '/admin/account'));

  it('shows avatar, name, email and chevron; opens with identity, role and Account settings; keyboard and Escape work; no sidebar entry; sign-out placements unchanged', async () => {
    routes();
    renderAdmin(<AdminGate>admin page</AdminGate>);
    await screen.findByText('admin page');
    const trigger = screen.getByRole('button', { name: 'Account menu for Ada Admin' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(within(trigger).getByText('Ada Admin')).toBeInTheDocument();
    expect(within(trigger).getByText(ME.email)).toBeInTheDocument();
    // Keyboard: Enter opens, focus moves into the menu, Escape closes and returns focus.
    trigger.focus();
    await userEvent.keyboard('{Enter}');
    const menu = await screen.findByRole('menu');
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(within(menu).getByText('Admin', { selector: 'p' })).toBeInTheDocument();
    const item = within(menu).getByRole('menuitem', { name: 'Account settings' });
    expect(item).toHaveAttribute('href', '/admin/account');
    expect(within(menu).queryByRole('menuitem', { name: /sign out/i })).toBeNull(); // no new sign-out placement
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(trigger).toHaveFocus();
    // The sidebar has no Account settings link; Sign out is still there.
    const nav = screen.getAllByRole('navigation', { name: 'Admin' })[0]!;
    expect(within(nav).queryByRole('link', { name: /account settings/i })).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Sign out' }).length).toBeGreaterThan(0);
  });
});

describe('Admin account settings', () => {
  beforeEach(() => window.history.replaceState(null, '', '/admin/account'));

  it('profile: real details, read-only email with its actual state; saving sends only names, then the header shows the new name', async () => {
    const api = routes({ 'PATCH /admin/account/profile': (b) => json(200, b) });
    page();
    expect(await screen.findByRole('heading', { level: 1, name: 'Account settings' })).toBeInTheDocument();
    expect(await screen.findByRole('tab', { name: 'Profile' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByLabelText('Email address')).toHaveAttribute('readonly');
    expect(screen.getByText('Verified')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /change email/i })).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull(); // no role selector, no timezone control
    expect(screen.getByText('Enabled')).toBeInTheDocument();
    const save = screen.getByRole('button', { name: 'Save changes' });
    expect(save).toBeDisabled();
    const first = screen.getByLabelText('First name');
    await userEvent.clear(first);
    await userEvent.type(first, 'Augusta');
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    await userEvent.click(save);
    await waitFor(() => expect(api.called('PATCH', '/admin/account/profile')).toHaveLength(1));
    expect(api.called('PATCH', '/admin/account/profile')[0]!.body).toEqual({ firstName: 'Augusta', lastName: 'Admin' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Account menu for Augusta Admin' })).toBeInTheDocument());
    expect(screen.queryByText('Unsaved changes')).toBeNull();
  });

  it('validation and server errors keep typed values and never claim success', async () => {
    const api = routes({ 'PATCH /admin/account/profile': json(500, { message: 'x' }) });
    page();
    const first = await screen.findByLabelText('First name');
    await userEvent.clear(first);
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(api.called('PATCH', '/admin/account/profile')).toHaveLength(0);
    expect(first).toHaveFocus();
    expect(first).toHaveAttribute('aria-invalid', 'true');
    await userEvent.type(first, 'Grace');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText(/Something went wrong on our side/)).toBeInTheDocument();
    expect(first).toHaveValue('Grace');
    expect(screen.queryByText('Your details were saved.')).toBeNull();
    expect(screen.getByRole('button', { name: 'Account menu for Ada Admin' })).toBeInTheDocument(); // header unchanged
  });

  it('unverified email: says so, and only sends the existing verification link (to the account’s own address) on request', async () => {
    const api = routes({ 'GET /admin/account': json(200, account({ emailVerified: false })), 'POST /admin/account/verification': json(202, { sent: true }) });
    page();
    expect(await screen.findByText('Not verified')).toBeInTheDocument();
    expect(screen.queryByText('Verified')).toBeNull();
    expect(api.called('POST', '/admin/account/verification')).toHaveLength(0); // never automatic
    await userEvent.click(screen.getByRole('button', { name: 'Send verification link' }));
    expect(await screen.findByText(/We sent a verification link to/)).toBeInTheDocument();
    expect(api.called('POST', '/admin/account/verification')[0]!.body).toEqual({});
  });

  it('tabs: arrow keys move between sections; typed values survive switching; the URL holds only the section', async () => {
    routes();
    page();
    const first = await screen.findByLabelText('First name');
    await userEvent.clear(first);
    await userEvent.type(first, 'Kept');
    const profileTab = screen.getByRole('tab', { name: 'Profile' });
    profileTab.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Security' })).toHaveFocus();
    expect(screen.getByRole('tab', { name: 'Security' })).toHaveAttribute('aria-selected', 'true');
    expect(window.location.search).toBe('?section=security');
    expect(screen.queryByLabelText('First name')).toBeNull(); // only the active section
    await userEvent.keyboard('{ArrowLeft}');
    expect(screen.getByLabelText('First name')).toHaveValue('Kept');
  });

  it('security: real two-factor state, no off switch or reset; password change goes to the admin endpoint with only two fields', async () => {
    const api = routes({ 'POST /admin/account/password': json(200, { success: true }) });
    page();
    await userEvent.click(await screen.findByRole('tab', { name: 'Security' }));
    expect(screen.getByText(/required for every administrator and can.t be turned off/)).toBeInTheDocument();
    expect(screen.getByText('9')).toBeInTheDocument(); // unused recovery codes
    expect(screen.queryByRole('button', { name: /disable|turn off|reset two-factor|remove/i })).toBeNull();
    expect(screen.queryByRole('switch')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Change password' }));
    const dialog = await screen.findByRole('dialog', { name: 'Change password' });
    await userEvent.type(within(dialog).getByLabelText('Current password'), 'old admin passphrase');
    await userEvent.type(within(dialog).getByLabelText('New password'), 'a brand new admin passphrase');
    await userEvent.type(within(dialog).getByLabelText('Confirm new password'), 'a brand new admin passphrase');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Update password' }));
    await waitFor(() => expect(api.called('POST', '/admin/account/password')).toHaveLength(1));
    expect(api.called('POST', '/admin/account/password')[0]!.body).toEqual({ currentPassword: 'old admin passphrase', newPassword: 'a brand new admin passphrase' });
    expect(api.called('POST', '/auth/change-password')).toHaveLength(0); // never the Customer route
  });

  it('sessions: this session from real data, an honest note instead of a fake list, sign-ins shown as plain text', async () => {
    routes();
    page();
    await userEvent.click(await screen.findByRole('tab', { name: 'Sessions' }));
    expect(screen.getByText('This session')).toBeInTheDocument();
    expect(screen.getByText('30 minutes without activity')).toBeInTheDocument();
    expect(screen.getByText(/can.t be listed here/)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Sign out' }).length).toBeGreaterThan(0); // the shell's existing Sign out only
    expect(screen.queryByRole('button', { name: /sign out other/i })).toBeNull();
    expect(screen.getByText(/Mozilla\/5\.0 <script>alert\(1\)<\/script>/)).toBeInTheDocument(); // text, not markup
    expect(document.querySelector('script')).toBeNull();
    expect(screen.getByText('Network 203.0.113.0/24')).toBeInTheDocument();
  });

  it('a SUPER_ADMIN gets the same personal settings (not more); a failed load is an error, never fake reassurance', async () => {
    routeFetch({ 'GET /admin-auth/me': json(200, { ...ME, role: 'SUPER_ADMIN' }), 'GET /admin/account': json(500, { message: 'x' }) });
    page();
    expect(await screen.findByRole('button', { name: /try again/i })).toBeInTheDocument();
    expect(screen.queryByText('Enabled')).toBeNull();
    expect(screen.queryByText('Verified')).toBeNull();
  });
});
