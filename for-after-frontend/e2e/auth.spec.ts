import { expect, test } from '@playwright/test';
import { API, newAccount, registerViaApi, signIn } from './helpers';

test('register → login → session survives refresh and tabs → logout', async ({ page, context }) => {
  const account = newAccount();

  // Register: the backend creates no session, so the app sends us to sign in.
  await page.goto('/register');
  await page.getByLabel('First name').fill(account.firstName);
  await page.getByLabel('Last name').fill(account.lastName);
  await page.getByLabel('Email').fill(account.email);
  await page.getByLabel('Password', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/login\?registered=1$/);
  await expect(page.getByText('Your account has been created')).toBeVisible();

  // Login → /auth/me-backed dashboard.
  await signIn(page, account);
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole('heading', { name: `Welcome back, ${account.firstName}.` })).toBeVisible();
  await expect(page.getByText(account.email)).toBeVisible();

  // The session is the HttpOnly cookie + Redis, not React state.
  await page.reload();
  await expect(page.getByRole('heading', { name: `Welcome back, ${account.firstName}.` })).toBeVisible();
  const cookie = (await context.cookies()).find((c) => c.name === 'for_after_session');
  expect(cookie?.httpOnly).toBe(true);
  expect(await page.evaluate(() => document.cookie)).not.toContain('for_after_session');
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).toBe('{}');

  // A second tab shares the session.
  const tabB = await context.newPage();
  await tabB.goto('/dashboard');
  await expect(tabB.getByRole('heading', { name: `Welcome back, ${account.firstName}.` })).toBeVisible();

  // Logout calls the backend and lands on /login.
  const logout = page.waitForResponse((r) => r.url() === `${API}/auth/logout` && r.status() === 200);
  await page.getByRole('button', { name: /^Account:/ }).click();
  await page.getByRole('menuitem', { name: 'Log out' }).click();
  await logout;
  await expect(page).toHaveURL(/\/login$/);
  expect((await page.request.get(`${API}/auth/me`)).status()).toBe(401);

  // The dashboard is gone in both tabs.
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/login$/);
  await tabB.reload();
  await expect(tabB).toHaveURL(/\/login$/);
});

test('/dashboard without a session redirects to /login', async ({ page }) => {
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  await expect(page.getByText('Your spaces')).toHaveCount(0);
});

test('wrong password stays on /login with a safe error and no session', async ({ page, request }) => {
  const account = newAccount();
  await registerViaApi(request, account);

  await page.goto('/login');
  // Keyboard only: labels, focus order and Enter-to-submit.
  await page.getByLabel('Email').focus();
  await page.keyboard.type(account.email);
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Password', { exact: true })).toBeFocused();
  await page.keyboard.type('not the right password');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Show password' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Password', { exact: true })).toHaveAttribute('type', 'text');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeFocused();
  await page.keyboard.press('Enter');

  await expect(page.getByRole('alert').filter({ hasText: 'Invalid email or password.' })).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
  expect((await page.request.get(`${API}/auth/me`)).status()).toBe(401);
});

test('/dev-login signs in through the real API in development', async ({ page, request }) => {
  const account = newAccount();
  await registerViaApi(request, account);

  await page.goto('/dev-login');
  await expect(page.getByText('Development only')).toBeVisible();
  const login = page.waitForResponse((r) => r.url() === `${API}/auth/login`);
  await signIn(page, account);
  expect((await login).status()).toBe(200);
  await expect(page).toHaveURL(/\/dashboard$/);

  // Signed-in Customers are sent away from the sign-in pages.
  await page.goto('/login');
  await expect(page).toHaveURL(/\/dashboard$/);

  // Responsive shell, still signed in from above.
  for (const width of [375, 768]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeHidden();
    await page.getByRole('button', { name: 'Open navigation' }).click();
    const drawer = page.getByRole('dialog');
    await expect(drawer.getByRole('link', { name: 'Dashboard' })).toBeVisible();
    await expect(drawer.getByText('Messages')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
    await expect(page.getByRole('button', { name: /^Account:/ })).toBeVisible();
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open navigation' })).toBeHidden();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);
});
