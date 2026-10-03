import { expect, test, type Page } from '@playwright/test';
import { API, freshTotp, newAccount, registerViaApi, type Account } from './helpers';

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
// E2E_ADMIN_FAILED_JOB names a failed message-release job to retry (backend
// scripts/dev-failed-job-fixture.mjs makes a fictional one).
// The signed-in admin works in a browser profile where a fictional Customer is
// signed in too (separate cookies). Uses 3 password logins (5/min per IP).

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

    test('a Customer session never reaches the Admin Portal, and is not signed out', async ({ page }) => {
      // The Customer cookie is never read on admin routes: no admin session.
      expect((await page.request.get(`${API}/admin-auth/me`)).status()).toBe(401);
      expect((await page.request.get(`${API}/admin/dashboard`)).status()).toBe(401);
      await page.goto('/admin');
      await expect(page).toHaveURL(/\/admin\/login$/);
      await expect(page.getByRole('navigation', { name: 'Admin' })).toHaveCount(0);
      expect((await page.request.get(`${API}/auth/me`)).status()).toBe(200);
    });
  });
});

test.describe.serial('signed-in admin', () => {
  test.skip(!EMAIL || !PASSWORD, 'Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD (a fictional local admin)');

  let page: Page;
  let customerTab: Page;
  let customer: Account;
  let secret = process.env.E2E_ADMIN_TOTP_SECRET ?? '';
  let usedStep = -1;
  const customerLogin = async () =>
    expect(
      (await page.request.post(`${API}/auth/login`, { data: { email: customer.email, password: customer.password } })).status(),
    ).toBe(200);

  // One browser profile: a Customer signs in first, the admin then signs in in
  // another tab. Both sessions must survive each other.
  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext();
    page = await context.newPage();
    customer = newAccount();
    await registerViaApi(context.request, customer);
    await customerLogin();
  });
  test.afterAll(async () => {
    await page.context().close();
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

  test('Customer and admin stay signed in side by side; a Customer logout leaves the admin', async () => {
    const names = (await page.context().cookies()).map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(['for_after_session', 'for_after_admin_session']));
    customerTab = await page.context().newPage();
    await customerTab.goto('/dashboard');
    await expect(customerTab.getByRole('heading', { name: `Welcome back, ${customer.firstName}.` })).toBeVisible();
    // No "This area is for Customer accounts": the admin sign-in replaced nothing.
    await expect(customerTab.getByText('This area is for Customer accounts')).toHaveCount(0);
    await customerTab.reload();
    await expect(customerTab.getByRole('heading', { name: `Welcome back, ${customer.firstName}.` })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();

    await customerTab.getByRole('button', { name: /^Account:/ }).click();
    await customerTab.getByRole('menuitem', { name: 'Log out' }).click();
    await expect(customerTab).toHaveURL(/\/login$/);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
    expect((await page.request.get(`${API}/admin-auth/me`)).status()).toBe(200);
    // Back in as the Customer for the admin sign-out test below.
    await customerLogin();
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

  test('failed jobs: retry re-queues one through the normal worker (never a forced release)', async () => {
    const jobId = process.env.E2E_ADMIN_FAILED_JOB;
    test.skip(!jobId, 'Set E2E_ADMIN_FAILED_JOB (backend: node scripts/dev-failed-job-fixture.mjs)');
    await page.goto('/admin/system/queues');
    const table = page.getByRole('table', { name: /Failed jobs in message-release/ });
    const row = table.getByRole('row').filter({ hasText: jobId! });
    await expect(row).toContainText('1 of 1');
    await row.getByRole('button', { name: 'Retry' }).click();
    const dialog = page.getByRole('dialog', { name: 'Retry this job?' });
    await expect(dialog).toContainText('force a release');
    await dialog.getByRole('button', { name: 'Retry job' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText('Job queued to run again')).toBeVisible();
    await expect(table.getByRole('row').filter({ hasText: jobId! })).toHaveCount(0);
    // The API agrees: no longer failed, and retrying again is refused.
    const failed = await (await page.request.get(`${API}/admin/system/queues/message-release/failed?limit=100`)).json();
    expect(JSON.stringify(failed)).not.toContain(jobId);
    expect((await page.request.post(`${API}/admin/system/queues/message-release/jobs/${jobId}/retry`)).status()).toBe(409);
    await page.goto('/admin/audit-logs?eventType=FAILED_JOB_RETRIED');
    await expect(page.getByRole('link', { name: 'Failed job retried' }).first()).toBeVisible();
  });

  test('sign out ends only the admin session; /admin then asks to sign in', async () => {
    await page.goto('/admin');
    await page.getByRole('button', { name: 'Sign out' }).first().click();
    await expect(page).toHaveURL(/\/admin\/login$/);
    expect((await page.request.get(`${API}/admin-auth/me`)).status()).toBe(401);
    await page.goto('/admin');
    await expect(page).toHaveURL(/\/admin\/login$/);
    // The Customer in the other tab is still signed in.
    expect((await page.request.get(`${API}/auth/me`)).status()).toBe(200);
    await customerTab.reload();
    await expect(customerTab.getByRole('heading', { name: `Welcome back, ${customer.firstName}.` })).toBeVisible();
  });
});
