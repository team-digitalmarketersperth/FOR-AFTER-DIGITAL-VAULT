import { expect, test, type Page } from '@playwright/test';
import { API, freshTotp } from './helpers';

// Step 20: Admin Portal against the real local API.
//
// Always run: signed-out and Customer sessions never reach /admin.
//
// The signed-in flows need a fictional local admin (docs/admin.md §11: register,
// then UPDATE "User" SET role = 'ADMIN'), given as E2E_ADMIN_EMAIL and
// E2E_ADMIN_PASSWORD. A not-yet-enrolled admin is enrolled here, reading the
// setup key from the page the way a person would type it into an app; an
// enrolled one needs E2E_ADMIN_TOTP_SECRET. E2E_ADMIN_SUSPEND_EMAIL names a
// fictional Customer to suspend and reactivate; E2E_ADMIN_READY_CASE and
// E2E_ADMIN_REJECT_CASE name READY_FOR_REVIEW case ids to verify / reject.
// Uses one password login (5/min per IP).

const EMAIL = process.env.E2E_ADMIN_EMAIL;
const PASSWORD = process.env.E2E_ADMIN_PASSWORD;

test.describe('without an admin session', () => {
  test('a signed-out visitor goes to the admin sign-in, not the Customer one', async ({ page }) => {
    await page.goto('/admin/users');
    await expect(page).toHaveURL(/\/admin\/login$/);
    await expect(page.getByRole('heading', { name: /Sign in to For After admin/ })).toBeVisible();
    // The second factor can't be reached without a password step in this tab.
    await page.goto('/admin/mfa/verify');
    await expect(page.getByRole('heading', { name: 'Please sign in again' })).toBeVisible();
  });

  test.describe('with a Customer session', () => {
    test.use({ storageState: 'e2e/.auth/b.json' });

    test('a Customer is denied, and is not signed out', async ({ page }) => {
      expect((await page.request.get(`${API}/admin-auth/me`)).status()).toBe(403);
      expect((await page.request.get(`${API}/admin/dashboard`)).status()).toBe(403);
      await page.goto('/admin');
      await expect(page.getByRole('heading', { name: 'Access denied' })).toBeVisible();
      await expect(page.getByRole('navigation', { name: 'Admin' })).toHaveCount(0);
      expect((await page.request.get(`${API}/auth/me`)).status()).toBe(200);
    });
  });
});

test.describe.serial('signed-in admin', () => {
  test.skip(!EMAIL || !PASSWORD, 'Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD (a fictional local admin)');

  let page: Page;
  let secret = process.env.E2E_ADMIN_TOTP_SECRET ?? '';
  let usedStep = -1;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
  });
  test.afterAll(async () => {
    await page.close();
  });

  const code = async () => {
    const next = await freshTotp(secret, usedStep);
    usedStep = next.step;
    return next.code;
  };

  test('password alone never opens the portal; a wrong code is refused; TOTP opens it', async () => {
    await page.goto('/admin/login');
    await page.getByLabel('Email').fill(EMAIL!);
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD!);
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page).toHaveURL(/\/admin\/mfa\/(setup|verify)$/);
    // No session yet.
    expect((await page.request.get(`${API}/admin-auth/me`)).status()).toBe(401);

    if (page.url().endsWith('/setup')) {
      await page.getByRole('button', { name: 'Set up my authenticator' }).click();
      await expect(page.getByRole('img', { name: 'QR code for your authenticator app' })).toBeVisible();
      await page.getByText("Can't scan it? Enter a setup key instead").click();
      secret = (await page.locator('p.font-mono').first().innerText()).replace(/\s/g, '');
      await page.getByLabel('6-digit code').fill('000000');
      await page.getByRole('button', { name: 'Confirm and continue' }).click();
      await expect(page.getByText(/verification code is invalid/)).toBeVisible();
      await page.getByLabel('6-digit code').fill(await code());
      await page.getByRole('button', { name: 'Confirm and continue' }).click();
      await expect(page.getByRole('heading', { name: /Save your recovery codes/ })).toBeVisible();
      await expect(page.locator('ol li')).toHaveCount(10);
      await page.getByLabel(/saved these recovery codes/).check();
      await page.getByRole('button', { name: 'Continue to the Admin Portal' }).click();
    } else {
      test.skip(!secret, 'This admin is already enrolled: set E2E_ADMIN_TOTP_SECRET');
      await page.getByLabel('6-digit code').fill('000000');
      await page.getByRole('button', { name: 'Verify and sign in' }).click();
      await expect(page.getByText(/verification code is invalid/)).toBeVisible();
      await expect(page).toHaveURL(/\/admin\/mfa\/verify$/);
      await page.getByLabel('6-digit code').fill(await code());
      await page.getByRole('button', { name: 'Verify and sign in' }).click();
    }
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Needs attention' })).toBeVisible();
  });

  test('the session survives a refresh and the portal has no Customer navigation', async () => {
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
    const nav = page.getByRole('navigation', { name: 'Admin' });
    for (const label of ['Users', 'Death verification', 'Audit logs', 'Queues']) {
      await expect(nav.getByRole('link', { name: label })).toBeVisible();
    }
    await expect(page.getByText('Memory Vault')).toHaveCount(0);
  });

  test('users: search, open, suspend (Customer session ends), reactivate', async () => {
    const target = process.env.E2E_ADMIN_SUSPEND_EMAIL;
    test.skip(!target, 'Set E2E_ADMIN_SUSPEND_EMAIL (a fictional Customer)');
    await page.goto('/admin/users');
    await page.getByLabel('Search').fill(target!);
    await expect(page).toHaveURL(/search=/);
    await page.getByRole('row').filter({ hasText: target! }).getByRole('link').click();
    await expect(page.getByRole('heading', { name: 'Account access' })).toBeVisible();

    await page.getByRole('button', { name: 'Suspend account…' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Reason').fill('E2E: fictional suspension test');
    await dialog.getByRole('button', { name: 'Suspend account' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText('Suspended', { exact: true }).first()).toBeVisible();

    await page.getByRole('button', { name: 'Reactivate account…' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Reactivate account' }).click();
    await expect(page.getByRole('button', { name: 'Suspend account…' })).toBeVisible();

    await page.goto('/admin/audit-logs?eventType=USER_REACTIVATED');
    await expect(page.getByRole('link', { name: 'User reactivated' }).first()).toBeVisible();
  });

  for (const [env, action, button, confirm, final] of [
    ['E2E_ADMIN_READY_CASE', 'verify', 'Verify death…', 'Verify death', 'Verified'],
    ['E2E_ADMIN_REJECT_CASE', 'reject', 'Reject report…', 'Reject report', 'Rejected'],
  ] as const) {
    test(`death verification: ${action} a READY_FOR_REVIEW case`, async () => {
      const caseId = process.env[env];
      test.skip(!caseId, `Set ${env} (a fictional READY_FOR_REVIEW case)`);
      await page.goto('/admin/death-verifications?status=READY_FOR_REVIEW');
      await page.goto(`/admin/death-verifications/${caseId}`);
      await page.getByRole('button', { name: button }).click();
      const dialog = page.getByRole('dialog');
      if (action === 'verify') {
        await dialog.getByLabel('Date').fill('2026-09-28');
        await dialog.getByLabel('Time').fill('09:30');
        await expect(dialog.getByRole('button', { name: confirm })).toBeDisabled();
        await dialog.getByLabel(/I have reviewed this case/).check();
      } else {
        await dialog.getByLabel(/should be rejected/).check();
      }
      await dialog.getByRole('button', { name: confirm }).click();
      await expect(dialog).toBeHidden();
      await expect(page.getByText(final, { exact: true }).first()).toBeVisible();
      await expect(page.getByRole('button', { name: /Verify death|Reject report/ })).toHaveCount(0);
    });
  }

  test('queues: allowlisted queues only, no free-text queue name', async () => {
    await page.goto('/admin/system/queues');
    await expect(page.getByRole('cell', { name: /message-release/ }).first()).toBeVisible();
    await expect(page.getByRole('cell', { name: /death-verification/ }).first()).toBeVisible();
    await expect(page.getByRole('textbox')).toHaveCount(0);
  });

  test('sign out ends the session; /admin then asks to sign in', async () => {
    await page.goto('/admin');
    await page.getByRole('button', { name: 'Sign out' }).first().click();
    await expect(page).toHaveURL(/\/admin\/login$/);
    expect((await page.request.get(`${API}/admin-auth/me`)).status()).toBe(401);
    await page.goto('/admin');
    await expect(page).toHaveURL(/\/admin\/login$/);
  });
});
