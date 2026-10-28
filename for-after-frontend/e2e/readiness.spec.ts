import { expect, test, type Page } from '@playwright/test';
import { db } from './death-helpers';
import { API, emailFromLog, newAccount, registerViaApi } from './helpers';
import fs from 'node:fs';

// Dashboard readiness, local only: a new Customer sets up their space step by
// step and the journey reflects the real state after each change. Same
// isolated setup as the death specs (console email, so the Trusted Contact
// invitation is printed, never sent). Fictional data; the user is deleted after.
const LOG = process.env.E2E_BACKEND_LOG;
test.skip(!LOG, 'Set E2E_BACKEND_LOG (isolated console-email API) to run the readiness flow.');

const dashboard = async (page: Page, score: number) => {
  await page.goto('/dashboard');
  await expect(page.getByText(`${score}% ready`, { exact: true })).toBeVisible();
};

test('readiness grows with real setup: 0 → 20 → 40 → 60 → 80 → 100', async ({ page }) => {
  const customer = newAccount();
  try {
    await registerViaApi(page.request, customer);
    expect(
      (await page.request.post(`${API}/auth/login`, { data: { email: customer.email, password: customer.password } })).status(),
    ).toBe(200);
    const post = async (path: string, data: object) => {
      const res = await page.request.post(`${API}${path}`, { data });
      expect(res.ok(), `${path} → ${res.status()}`).toBe(true);
      return res.json();
    };

    await dashboard(page, 0);
    await expect(page.getByRole('progressbar', { name: 'Setup progress' })).toHaveAttribute('aria-valuenow', '0');
    await expect(page.getByText('No messages yet')).toBeVisible();
    // A next step leads to its real page.
    await page.getByRole('link', { name: 'Add someone you love' }).click();
    await expect(page).toHaveURL(/\/people$/);

    const recipient = await post('/recipients', { firstName: 'Sofia' });
    await dashboard(page, 20);
    await expect(page.getByText('1 person added')).toBeVisible();

    // Ready only once the invitation is accepted (2026-10-14).
    const tcEmail = `e2e-rd-tc-${Date.now()}@example.com`;
    const from = fs.statSync(LOG!).size;
    await post('/trusted-contacts', { firstName: 'David', email: tcEmail });
    await dashboard(page, 20);
    await expect(page.getByText('Waiting for your contact to accept')).toBeVisible();
    const token = (await emailFromLog(LOG!, 'trusted-contact-invitation', tcEmail, from)).match(/token=([A-Za-z0-9_-]{43})/)![1];
    expect((await page.request.post(`${API}/trusted-contact/invitation/accept`, { data: { token } })).ok()).toBe(true);
    await dashboard(page, 40);
    await expect(page.getByText('1 contact ready')).toBeVisible();

    const message = await post('/messages', { title: 'For Sofia', textContent: 'Fictional words.', recipientIds: [recipient.id] });
    await dashboard(page, 60);
    await expect(page.getByText('1 message needs scheduling')).toBeVisible();

    await post(`/messages/${message.id}/schedule`, {
      triggerType: 'FIXED_DATE',
      scheduledFor: new Date(Date.now() + 365 * 86_400_000).toISOString(),
    });
    await dashboard(page, 80);
    await expect(page.getByText('Your message has its timing')).toBeVisible();

    expect(
      (await page.request.put(`${API}/my-wishes/prompts/ceremony.style/response`, { data: { textContent: 'Something quiet.' } })).ok(),
    ).toBe(true);
    await dashboard(page, 100);
    await expect(page.getByText('Complete', { exact: true })).toHaveCount(5);
    await expect(page.getByText('Your essentials are in place')).toBeVisible();
  } finally {
    await db(`DELETE FROM "User" WHERE email = $1`, [customer.email]);
  }
});
