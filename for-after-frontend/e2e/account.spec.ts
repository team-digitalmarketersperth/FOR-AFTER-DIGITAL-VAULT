import { expect, test } from '@playwright/test';
import { API, newAccount, registerViaApi, signIn } from './helpers';

// Step 22 (FE-9) against the real API: profile update and password change.
// One fictional account. Uses 1 register + 4 logins of the 5/min limit, so run
// it on its own or wait a minute after other specs.
test('account settings: name persists everywhere; password change keeps this session and ends others', async ({
  page,
  browser,
}) => {
  const account = newAccount();
  const newPassword = 'a different local e2e passphrase';
  await registerViaApi(page.request, account);

  // "Another device": its own browser context, signed in before the change.
  const otherDevice = await browser.newContext();
  expect(
    (await otherDevice.request.post(`${API}/auth/login`, { data: { email: account.email, password: account.password } })).status(),
  ).toBe(200);
  expect((await otherDevice.request.get(`${API}/auth/me`)).status()).toBe(200);

  await page.goto('/login');
  await signIn(page, account);
  await expect(page).toHaveURL(/\/dashboard$/);

  // Account menu → Account settings.
  await page.getByRole('button', { name: /^Account:/ }).click();
  await page.getByRole('menuitem', { name: 'Account settings' }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole('heading', { level: 1, name: /Account settings/ })).toBeVisible();

  // Pre-filled from the API; email is read-only text, not a field.
  const profile = page.getByRole('region', { name: 'Personal details' });
  const summary = page.getByRole('complementary', { name: 'Account summary' });
  await expect(profile.getByLabel('First name')).toHaveValue(account.firstName);
  await expect(profile.getByLabel('Last name')).toHaveValue(account.lastName);
  await expect(profile.getByText(account.email)).toBeVisible();
  await expect(summary.getByText('Active', { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: /email/i })).toHaveCount(0);
  await expect(profile.getByRole('button', { name: 'Save changes' })).toBeDisabled();

  // Save a new name (Unicode, trimmed by the API).
  await profile.getByLabel('First name').fill('  Zoë ');
  await profile.getByLabel('Last name').fill('Ó Briain');
  const saved = page.waitForResponse((r) => r.url() === `${API}/users/me` && r.request().method() === 'PATCH');
  await profile.getByRole('button', { name: 'Save changes' }).click();
  expect((await saved).status()).toBe(200);
  await expect(page.getByText('Changes saved')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Account: Zoë Ó Briain' })).toBeVisible();
  await expect(summary.getByText('Zoë Ó Briain')).toBeVisible();
  await expect(profile.getByRole('button', { name: 'Save changes' })).toBeDisabled();

  // Persisted on the server: survives a reload, and the dashboard greets the new name.
  await page.reload();
  await expect(profile.getByLabel('First name')).toHaveValue('Zoë');
  await expect(profile.getByLabel('Last name')).toHaveValue('Ó Briain');
  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { name: 'Welcome back, Zoë.' })).toBeVisible();
  await page.goto('/settings');

  // Wrong current password: safe message, dialog stays open, still signed in.
  await page.getByRole('region', { name: 'Security' }).getByRole('button', { name: 'Change password' }).click();
  const security = page.getByRole('dialog', { name: 'Change password' });
  await security.getByLabel('Current password').fill('not my password at all');
  await security.getByLabel('New password', { exact: true }).fill(newPassword);
  await security.getByLabel('Confirm new password').fill(newPassword);
  await security.getByRole('button', { name: 'Update password' }).click();
  await expect(security.getByText('Your current password is incorrect.')).toBeVisible();
  await expect(page).toHaveURL(/\/settings$/);

  // Correct current password.
  await security.getByLabel('Current password').fill(account.password);
  const changed = page.waitForResponse((r) => r.url() === `${API}/auth/change-password`);
  await security.getByRole('button', { name: 'Update password' }).click();
  expect((await changed).status()).toBe(200);
  await expect(page.getByText('Password updated. Other devices have been signed out.')).toBeVisible();
  await expect(security).toBeHidden();

  // This browser keeps its session (new id); the other device is signed out.
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: /Account settings/ })).toBeVisible();
  expect((await page.request.get(`${API}/auth/me`)).status()).toBe(200);
  expect((await otherDevice.request.get(`${API}/auth/me`)).status()).toBe(401);
  await otherDevice.close();

  // Sign out; the old password is refused, the new one works.
  await page.getByRole('button', { name: /^Account:/ }).click();
  await page.getByRole('menuitem', { name: 'Log out' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await signIn(page, account);
  await expect(page.getByText('Invalid email or password.')).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
  await signIn(page, { ...account, password: newPassword });
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole('heading', { name: 'Welcome back, Zoë.' })).toBeVisible();
});

test('account APIs refuse a request without a Customer session', async ({ request }) => {
  expect((await request.patch(`${API}/users/me`, { data: { firstName: 'X' } })).status()).toBe(401);
  expect(
    (await request.post(`${API}/auth/change-password`, { data: { currentPassword: 'x', newPassword: 'y'.repeat(12) } })).status(),
  ).toBe(401);
});

test('/settings without a session redirects to /login', async ({ page }) => {
  await page.goto('/settings');
  await expect(page).toHaveURL(/\/login$/);
});
