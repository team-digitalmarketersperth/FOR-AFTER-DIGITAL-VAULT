import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import { API, emailFromLog, newAccount, signIn } from './helpers';

// Phase 04: email verification and password reset through the real UI and API.
// The links exist only in emails, so this needs an API whose EMAIL_PROVIDER is
// `console` and whose output is teed into E2E_BACKEND_LOG. E2E_EMAIL_API points
// at it (e.g. a second instance on :4001, same database and Redis); every API
// call of this spec goes there, so a Brevo-configured API on :4000 never sends
// to these fictional addresses.
const LOG = process.env.E2E_BACKEND_LOG;
const EMAIL_API = process.env.E2E_EMAIL_API;

const PAGES = {
  'verify-email': '/verify-email',
  'reset-password': '/reset-password',
  'change-email': '/settings/verify-email-change',
};

const linkFrom = async (kind: keyof typeof PAGES, email: string, from: number) => {
  const line = await emailFromLog(LOG!, kind, email, from);
  const token = line.match(/token=([A-Za-z0-9_-]{43})/)![1];
  return `${PAGES[kind]}?token=${token}`;
};

const useEmailApi = (page: Page) =>
  page.route(`${API}/**`, (route) =>
    route.continue({ url: route.request().url().replace(new URL(API).origin, EMAIL_API!) }),
  );

test.describe.configure({ mode: 'serial' });
test.skip(!LOG || !EMAIL_API, 'Set E2E_BACKEND_LOG and E2E_EMAIL_API (an API with EMAIL_PROVIDER=console).');

const account = newAccount();
const newPassword = 'a brand new local passphrase';
let verifyLink: string;

test.beforeEach(({ page }) => useEmailApi(page));

test('register → verification instruction → the emailed link verifies the email', async ({ page }) => {
  const from = fs.statSync(LOG!).size;
  await page.goto('/register');
  await page.getByLabel('First name').fill(account.firstName);
  await page.getByLabel('Last name').fill(account.lastName);
  await page.getByLabel('Email').fill(account.email);
  await page.getByLabel('Password', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/login\?registered=1/);
  await expect(page.getByText(/emailing you a link to verify your address/)).toBeVisible();

  verifyLink = await linkFrom('verify-email', account.email, from);
  await page.goto(verifyLink);
  await expect(page.getByText('Your email is verified')).toBeVisible();
});

test('a used verification link offers a new one (same answer, then a cooldown)', async ({ page }) => {
  await page.goto(verifyLink);
  await expect(page.getByText("This link can't be used")).toBeVisible();
  await page.getByLabel('Email').fill(account.email);
  await page.getByRole('button', { name: 'Send a new verification link' }).click();
  await expect(page.getByText('If that account still needs verifying, we have sent a new link.')).toBeVisible();
  await expect(page.getByRole('button', { name: /Send again in \d+s/ })).toBeDisabled();
});

test('forgot password: the same confirmation for unknown and known emails', async ({ page }) => {
  for (const email of [`nobody-${Date.now()}@example.com`, account.email]) {
    await page.goto('/forgot-password');
    await page.getByLabel('Email').fill(email);
    await page.getByRole('button', { name: 'Send reset link' }).click();
    await expect(page.getByText(/If an account exists for this email, we've sent password reset instructions/)).toBeVisible();
  }
});

test('reset link → new password → old password refused, new one signs in; the link is single-use', async ({ page }) => {
  const from = fs.statSync(LOG!).size;
  await page.goto('/forgot-password');
  await page.getByLabel('Email').fill(account.email);
  await page.getByRole('button', { name: 'Send reset link' }).click();
  const resetLink = await linkFrom('reset-password', account.email, from);

  await page.goto(resetLink);
  await page.getByLabel('New password', { exact: true }).fill(newPassword);
  await page.getByLabel('Confirm new password').fill(newPassword);
  await page.getByRole('button', { name: 'Set new password' }).click();
  await expect(page.getByText('Your password has been reset')).toBeVisible();

  // Single use (checked signed out: the auth pages send a signed-in Customer to the dashboard).
  await page.goto(resetLink);
  await page.getByLabel('New password', { exact: true }).fill('yet another local passphrase');
  await page.getByLabel('Confirm new password').fill('yet another local passphrase');
  await page.getByRole('button', { name: 'Set new password' }).click();
  await expect(page.getByText("This link can't be used")).toBeVisible();

  await page.goto('/login');
  await signIn(page, account);
  await expect(page.getByText('Invalid email or password.')).toBeVisible();
  await signIn(page, { ...account, password: newPassword });
  await expect(page).toHaveURL(/\/dashboard/);
});

test('Phase 08: change email → link to the NEW address → signed out → sign in with the new address', async ({ page }) => {
  await page.goto('/login');
  await signIn(page, { ...account, password: newPassword });
  await expect(page).toHaveURL(/\/dashboard/);

  const newEmail = account.email.replace('@', '-new@');
  const from = fs.statSync(LOG!).size;
  await page.goto('/settings');
  await expect(page.getByText(account.email).first()).toBeVisible();
  await page.getByRole('button', { name: 'Change email' }).click();
  const dialog = page.getByRole('dialog', { name: 'Change email' });
  await dialog.getByLabel('New email').fill(newEmail);
  await dialog.getByLabel('Current password', { exact: true }).fill(newPassword);
  await dialog.getByRole('button', { name: 'Send verification' }).click();
  await expect(page.getByRole('dialog', { name: 'Verification email sent' })).toBeVisible();
  await page.getByRole('button', { name: 'Done' }).click();

  const link = await linkFrom('change-email', newEmail, from);
  await page.goto(link);
  await expect(page.getByText('Email address updated')).toBeVisible();
  // This browser's session ended with the change.
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/login/);

  await signIn(page, { ...account, email: newEmail, password: newPassword });
  await expect(page).toHaveURL(/\/dashboard/);
  await page.goto('/settings');
  await expect(page.getByText(newEmail).first()).toBeVisible();
});

