import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { describe, expect, it, vi } from 'vitest';
import { CustomerGate } from '@/components/auth/auth-gates';
import { queryKeys } from '@/lib/query/query-client';
import { customer, json, renderWithClient, routeFetch, router } from '@/test/utils';
import { AccountSettings } from './account-settings';

vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/settings' }));
vi.mock('sonner', () => ({ toast: { success: vi.fn() } }));

const NO_CASE = json(200, { status: null, safeguardEndsAt: null, canConfirmAlive: false });

// The real page: gate (GET /auth/me) → shell with the account menu → settings.
const renderPage = async (routes: Parameters<typeof routeFetch>[0] = {}) => {
  const api = routeFetch({ 'GET /auth/me': json(200, customer), 'GET /death-verification/me': NO_CASE, ...routes });
  const view = renderWithClient(
    <CustomerGate>
      <AccountSettings />
    </CustomerGate>,
  );
  await screen.findByRole('region', { name: 'Security' });
  await screen.findByRole('region', { name: 'Personal details' });
  return { api, ...view };
};

const profile = () => within(screen.getByRole('region', { name: 'Personal details' }));
const summary = () => within(screen.getByRole('complementary', { name: 'Account summary' }));
// The password form lives in a dialog opened from the Security section.
const security = () => within(screen.getByRole('dialog', { name: 'Change password' }));
const openPasswordDialog = async () => {
  await userEvent.click(
    within(screen.getByRole('region', { name: 'Security' })).getByRole('button', { name: 'Change password' }),
  );
  return screen.findByRole('dialog', { name: 'Change password' });
};

async function fillPasswords(current: string, next: string, confirm = next) {
  await openPasswordDialog();
  if (current) await userEvent.type(security().getByLabelText('Current password'), current);
  if (next) await userEvent.type(security().getByLabelText('New password'), next);
  if (confirm) await userEvent.type(security().getByLabelText('Confirm new password'), confirm);
}

describe('Account settings: profile', () => {
  it('loads the real profile into the form, with email read-only', async () => {
    await renderPage();
    expect(await screen.findByRole('heading', { level: 1, name: /Account settings/ })).toBeInTheDocument();
    expect(profile().getByLabelText('First name')).toHaveValue('Ada');
    expect(profile().getByLabelText('Last name')).toHaveValue('Lovelace');
    // Email is text, not a field, and there is no edit control for it.
    expect(profile().getByText('ada@example.com')).toBeInTheDocument();
    expect(profile().queryByRole('textbox', { name: /email/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /edit/i })).not.toBeInTheDocument();
    expect(profile().getByRole('button', { name: 'Save changes' })).toBeDisabled();
  });

  it('summarises only real account data: monogram, name, email, status, member since', async () => {
    await renderPage();
    expect(summary().getByText('AL')).toBeInTheDocument();
    expect(summary().getByText('Ada Lovelace')).toBeInTheDocument();
    expect(summary().getByText('ada@example.com')).toBeInTheDocument();
    expect(summary().getByText('Account').nextElementSibling).toHaveTextContent(/^Active$/);
    expect(summary().getByText('Member since').nextElementSibling).toHaveTextContent('September 2026');
    expect(summary().queryByText('ACTIVE')).not.toBeInTheDocument();
  });

  it('validates before calling the API', async () => {
    const { api } = await renderPage();
    const first = await profile().findByLabelText('First name');
    await userEvent.clear(first);
    await userEvent.type(first, '   ');
    await userEvent.type(profile().getByLabelText('Last name'), 'x'.repeat(100));
    await userEvent.click(profile().getByRole('button', { name: 'Save changes' }));
    expect(await profile().findByText('Enter your first name.')).toBeInTheDocument();
    expect(profile().getByText('Last name must be 100 characters or fewer.')).toBeInTheDocument();
    expect(first).toHaveAttribute('aria-invalid', 'true');
    expect(api.called('PATCH', '/users/me')).toHaveLength(0);
  });

  it('saves only the name, once, and updates the header and account menu', async () => {
    let release!: () => void;
    const saved = { ...customer, firstName: 'Augusta', lastName: 'King' };
    const { api, queryClient } = await renderPage({
      'PATCH /users/me': () => json(200, saved),
    });
    // Hold the response to check the pending state.
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fetchMock = vi.mocked(fetch);
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => {
      if (init?.method === 'PATCH') await gate;
      return original(input, init);
    });

    const first = await profile().findByLabelText('First name');
    await userEvent.clear(first);
    await userEvent.type(first, ' Augusta ');
    await userEvent.clear(profile().getByLabelText('Last name'));
    await userEvent.type(profile().getByLabelText('Last name'), 'King');
    const save = profile().getByRole('button', { name: 'Save changes' });
    expect(save).toBeEnabled();
    await userEvent.click(save);

    const pending = await profile().findByRole('button', { name: 'Saving…' });
    expect(pending).toBeDisabled();
    await userEvent.click(pending);
    release();

    await waitFor(() => expect(screen.getByRole('button', { name: 'Account: Augusta King' })).toBeInTheDocument());
    expect(api.called('PATCH', '/users/me')).toHaveLength(1);
    expect(api.called('PATCH', '/users/me')[0]).toMatchObject({
      credentials: 'include',
      body: { firstName: 'Augusta', lastName: 'King' },
    });
    expect(queryClient.getQueryData(queryKeys.me)).toEqual(saved);
    expect(summary().getByText('Augusta King')).toBeInTheDocument();
    expect(summary().getByText('AK')).toBeInTheDocument();
    expect(toast.success).toHaveBeenCalledWith('Changes saved');
    // Saved values are the new baseline, so there's nothing left to save.
    expect(profile().getByRole('button', { name: 'Save changes' })).toBeDisabled();
  });

  it('keeps typed values and shows a safe error when saving fails', async () => {
    await renderPage({ 'PATCH /users/me': json(500, { message: 'stack trace here' }) });
    const first = await profile().findByLabelText('First name');
    await userEvent.clear(first);
    await userEvent.type(first, 'Augusta');
    await userEvent.click(profile().getByRole('button', { name: 'Save changes' }));
    expect(await profile().findByText('Something went wrong on our side. Please try again.')).toBeInTheDocument();
    expect(screen.queryByText(/stack trace/)).not.toBeInTheDocument();
    expect(first).toHaveValue('Augusta');
    // The header still shows what the server has.
    expect(screen.getByRole('button', { name: 'Account: Ada Lovelace' })).toBeInTheDocument();
  });

  it('a network failure is not a sign-out: values kept, connection message shown', async () => {
    await renderPage({ 'PATCH /users/me': () => Promise.reject(new TypeError('Failed to fetch')) as never });
    const first = await profile().findByLabelText('First name');
    await userEvent.clear(first);
    await userEvent.type(first, 'Augusta');
    await userEvent.click(profile().getByRole('button', { name: 'Save changes' }));
    expect(await profile().findByText("We couldn't connect to For After. Please try again.")).toBeInTheDocument();
    expect(first).toHaveValue('Augusta');
    expect(router.replace).not.toHaveBeenCalledWith('/login');
  });

  it('a 401 while saving ends the Customer session and returns to /login', async () => {
    const { queryClient } = await renderPage({ 'PATCH /users/me': json(401, { message: 'Unauthorized' }) });
    const first = await profile().findByLabelText('First name');
    await userEvent.type(first, 'x');
    await userEvent.click(profile().getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/login'));
    expect(queryClient.getQueryData(queryKeys.me)).toBeNull();
  });
});

describe('Account settings: password', () => {
  it('keeps the page calm: the password form opens in an accessible dialog, Escape closes and clears it', async () => {
    await renderPage();
    expect(screen.queryByLabelText('Current password')).not.toBeInTheDocument();
    const dialog = await openPasswordDialog();
    expect(dialog).toHaveAccessibleDescription(/Choose a strong password you don.t use elsewhere/);
    expect(security().getByLabelText('Current password')).toHaveFocus();
    await userEvent.type(security().getByLabelText('Current password'), 'typed secret');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await openPasswordDialog();
    expect(security().getByLabelText('Current password')).toHaveValue('');
  });

  it('Cancel closes the dialog without calling the API', async () => {
    const { api } = await renderPage();
    await fillPasswords('StrongPassword123!', 'A brand new passphrase');
    await userEvent.click(security().getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(api.called('POST', '/auth/change-password')).toHaveLength(0);
  });

  it('uses password-manager friendly fields, never prefilled', async () => {
    await renderPage();
    await openPasswordDialog();
    const current = security().getByLabelText('Current password');
    const next = security().getByLabelText('New password');
    const confirm = security().getByLabelText('Confirm new password');
    expect(current).toHaveAttribute('autocomplete', 'current-password');
    expect(current).toHaveAttribute('type', 'password');
    expect(next).toHaveAttribute('autocomplete', 'new-password');
    expect(confirm).toHaveAttribute('autocomplete', 'new-password');
    for (const field of [current, next, confirm]) expect(field).toHaveValue('');
    expect(next).toHaveAccessibleDescription(/At least 12 characters/);
    expect(security().getAllByRole('button', { name: 'Show password' })).toHaveLength(3);
  });

  it('requires the current password, the registration length rule and a matching confirmation', async () => {
    const { api } = await renderPage();
    await fillPasswords('', 'short', 'different');
    await userEvent.click(security().getByRole('button', { name: 'Update password' }));
    expect(await security().findByText('Enter your current password.')).toBeInTheDocument();
    expect(security().getByText('Password must be at least 12 characters.')).toBeInTheDocument();
    expect(security().getByText("The new passwords don't match.")).toBeInTheDocument();
    expect(api.called('POST', '/auth/change-password')).toHaveLength(0);
  });

  it('refuses reusing the current password before calling the API', async () => {
    const { api } = await renderPage();
    await fillPasswords('StrongPassword123!', 'StrongPassword123!');
    await userEvent.click(security().getByRole('button', { name: 'Update password' }));
    expect(await security().findByText('Choose a password that is different from your current one.')).toBeInTheDocument();
    expect(api.called('POST', '/auth/change-password')).toHaveLength(0);
  });

  it('sends only the two API fields once, then closes with a quiet confirmation', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { api } = await renderPage({
      'POST /auth/change-password': json(200, { success: true }),
    });
    const fetchMock = vi.mocked(fetch);
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => {
      if (init?.method === 'POST') await gate;
      return original(input, init);
    });
    await fillPasswords('StrongPassword123!', 'A brand new passphrase');
    await userEvent.click(security().getByRole('button', { name: 'Update password' }));

    const pending = await security().findByRole('button', { name: 'Updating…' });
    expect(pending).toBeDisabled();
    expect(security().getByLabelText('Current password')).toBeDisabled();
    expect(security().getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await userEvent.click(pending);
    // Escape can't close it mid-request.
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: 'Change password' })).toBeInTheDocument();
    release();

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(toast.success).toHaveBeenCalledWith('Password updated. Other devices have been signed out.');
    expect(api.called('POST', '/auth/change-password')).toEqual([
      expect.objectContaining({
        credentials: 'include',
        body: { currentPassword: 'StrongPassword123!', newPassword: 'A brand new passphrase' },
      }),
    ]);
    await openPasswordDialog();
    for (const label of ['Current password', 'New password', 'Confirm new password']) {
      expect(security().getByLabelText(label)).toHaveValue('');
    }
    // The current session stays: no sign-out.
    expect(router.replace).not.toHaveBeenCalledWith('/login');
  });

  it('a wrong current password shows the API message, clears only that field, and keeps the session', async () => {
    await renderPage({
      'POST /auth/change-password': json(400, { message: 'Your current password is incorrect.' }),
    });
    await fillPasswords('not-my-password', 'A brand new passphrase');
    await userEvent.click(security().getByRole('button', { name: 'Update password' }));
    expect(await security().findByText('Your current password is incorrect.')).toBeInTheDocument();
    expect(security().getByLabelText('Current password')).toHaveValue('');
    expect(security().getByLabelText('New password')).toHaveValue('A brand new passphrase');
    expect(screen.getByRole('dialog', { name: 'Change password' })).toBeInTheDocument();
    expect(toast.success).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalledWith('/login');
  });

  it('a 429 shows the fixed rate-limit copy and is not retried', async () => {
    const { api } = await renderPage({ 'POST /auth/change-password': json(429, { message: 'ThrottlerException' }) });
    await fillPasswords('StrongPassword123!', 'A brand new passphrase');
    await userEvent.click(security().getByRole('button', { name: 'Update password' }));
    expect(await security().findByText('Too many attempts. Please try again shortly.')).toBeInTheDocument();
    expect(api.called('POST', '/auth/change-password')).toHaveLength(1);
  });

  it('an expired session (401) returns to /login', async () => {
    await renderPage({ 'POST /auth/change-password': json(401, { message: 'Unauthorized' }) });
    await fillPasswords('StrongPassword123!', 'A brand new passphrase');
    await userEvent.click(security().getByRole('button', { name: 'Update password' }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/login'));
  });
});

describe('Account settings: change email (Phase 08)', () => {
  const emailDialog = () => within(screen.getByRole('dialog', { name: /Change email|Verification email sent/ }));
  const openEmailDialog = async () => {
    await userEvent.click(profile().getByRole('button', { name: 'Change email' }));
    return screen.findByRole('dialog', { name: 'Change email' });
  };
  const fillEmail = async (newEmail: string, password: string) => {
    await openEmailDialog();
    if (newEmail) await userEvent.type(emailDialog().getByLabelText('New email'), newEmail);
    if (password) await userEvent.type(emailDialog().getByLabelText('Current password'), password);
    await userEvent.click(emailDialog().getByRole('button', { name: 'Send verification' }));
  };

  it('the email stays read-only text; the change opens a separate dialog', async () => {
    await renderPage();
    expect(profile().queryByRole('textbox', { name: /email/i })).not.toBeInTheDocument();
    await openEmailDialog();
    expect(emailDialog().getByLabelText('New email')).toHaveValue('');
  });

  it('validates before calling the API', async () => {
    const { api } = await renderPage();
    await fillEmail('not-an-email', '');
    expect(await emailDialog().findByText('Enter a valid email address.')).toBeInTheDocument();
    expect(emailDialog().getByText('Enter your current password.')).toBeInTheDocument();
    expect(api.called('POST', '/auth/change-email')).toHaveLength(0);
  });

  it('sends the two fields, shows the masked pending address, and never touches the profile form', async () => {
    const { api } = await renderPage({
      'POST /auth/change-email': json(202, { pendingEmail: 'n***@example.com' }),
      'POST /auth/change-email/resend': json(202, { pendingEmail: 'n***@example.com' }),
    });
    await fillEmail('new@example.com', 'StrongPassword123!');
    expect(await screen.findByRole('dialog', { name: 'Verification email sent' })).toBeInTheDocument();
    expect(emailDialog().getByText('n***@example.com')).toBeInTheDocument();
    expect(api.called('POST', '/auth/change-email')).toEqual([
      expect.objectContaining({ body: { newEmail: 'new@example.com', currentPassword: 'StrongPassword123!' } }),
    ]);
    // The dialog's submit must not reach the profile form around it.
    expect(api.called('PATCH', '/users/me')).toHaveLength(0);
    await userEvent.click(emailDialog().getByRole('button', { name: 'Resend link' }));
    expect(await emailDialog().findByText('A new link is on its way.')).toBeInTheDocument();
    expect(api.called('POST', '/auth/change-email/resend')).toHaveLength(1);
    await userEvent.click(emailDialog().getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // Nothing changed yet: the page still shows the current address.
    expect(profile().getByText('ada@example.com')).toBeInTheDocument();
  });

  it('a wrong password shows the API message and clears only the password', async () => {
    await renderPage({
      'POST /auth/change-email': json(400, { message: 'Your current password is incorrect.' }),
    });
    await fillEmail('new@example.com', 'not-my-password');
    expect(await emailDialog().findByText('Your current password is incorrect.')).toBeInTheDocument();
    expect(emailDialog().getByLabelText('Current password')).toHaveValue('');
    expect(emailDialog().getByLabelText('New email')).toHaveValue('new@example.com');
    expect(router.replace).not.toHaveBeenCalledWith('/login');
  });

  it('an address in use shows the API conflict message', async () => {
    await renderPage({
      'POST /auth/change-email': json(409, { message: 'An account with this email already exists.' }),
    });
    await fillEmail('taken@example.com', 'StrongPassword123!');
    expect(await emailDialog().findByText('An account with this email already exists.')).toBeInTheDocument();
  });

  it('cancelling a pending request closes the dialog', async () => {
    const { api } = await renderPage({
      'POST /auth/change-email': json(202, { pendingEmail: 'n***@example.com' }),
      'POST /auth/change-email/cancel': json(200, { success: true }),
    });
    await fillEmail('new@example.com', 'StrongPassword123!');
    await userEvent.click(await emailDialog().findByRole('button', { name: 'Cancel request' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(api.called('POST', '/auth/change-email/cancel')).toHaveLength(1);
  });
});

describe('Account menu', () => {
  it('links to Account settings', async () => {
    await renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Account: Ada Lovelace' }));
    expect(await screen.findByRole('menuitem', { name: 'Account settings' })).toHaveAttribute('href', '/settings');
  });
});
