import { expect, test } from '@playwright/test';
import { db } from './death-helpers';
import { API, newAccount, registerViaApi } from './helpers';

// Delivery timeline, local only: a synthetic Customer schedules real messages
// through the API and the timeline reads them back. Isolated console-email API
// with no worker, so nothing is released while the test runs. Deleted after.
const LOG = process.env.E2E_BACKEND_LOG;
test.skip(!LOG, 'Set E2E_BACKEND_LOG (isolated console-email API) to run the timeline flow.');

test('dated deliveries in order, per-Recipient birthday, death-triggered ones without dates', async ({ page }) => {
  const customer = newAccount();
  const PRIVATE = 'Private fictional words';
  const nextYear = new Date().getFullYear() + 1;
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
    const mum = await post('/recipients', { firstName: 'Mum', email: `e2e-dt-mum-${Date.now()}@example.com` });
    const sarah = await post('/recipients', { firstName: 'Sarah', birthday: '1990-03-14' });
    const message = async (title: string, recipientIds: string[], schedule: object) => {
      const m = await post('/messages', { title, textContent: PRIVATE, recipientIds });
      await post(`/messages/${m.id}/schedule`, schedule);
      return m.id as string;
    };
    const christmas = await message('Christmas message', [mum.id], { triggerType: 'FIXED_DATE', scheduledFor: `${nextYear}-12-24T09:00:00+08:00` });
    await message('Birthday message', [sarah.id], { triggerType: 'BIRTHDAY', timezone: 'Australia/Perth', localTime: '09:00' });
    await message('Letter to family', [mum.id, sarah.id], { triggerType: 'ON_DEATH' });
    await message('Annual remembrance', [mum.id], { triggerType: 'ANNUAL_AFTER_DEATH', timezone: 'Australia/Perth', localTime: '09:00' });

    await page.goto('/messages/timeline');
    const coming = page.getByRole('region', { name: 'Coming up' }).getByRole('listitem');
    await expect(coming).toHaveCount(2);
    // The next birthday (14 Mar) comes before Christmas next year.
    await expect(coming.nth(0)).toContainText('Birthday message to Sarah');
    await expect(coming.nth(0)).toContainText('14 Mar');
    await expect(coming.nth(1)).toContainText('Christmas message to Mum');
    await expect(coming.nth(1)).toContainText(`24 Dec ${nextYear}`);

    const conditional = page.getByRole('region', { name: 'When the time comes' }).getByRole('listitem');
    await expect(conditional).toHaveCount(2);
    await expect(conditional.nth(0)).toContainText('After my passing');
    await expect(conditional.nth(0)).toContainText('Letter to family to Mum and Sarah');
    await expect(conditional.nth(1)).toContainText('Every year after my passing');
    // No calendar date is invented for a death-triggered delivery.
    for (const text of await conditional.allInnerTexts()) expect(text).not.toMatch(/\b20\d\d\b/);

    // The timeline itself carries no content or contact details (the header's
    // own account menu shows the signed-in Customer's email, which is theirs).
    await expect(page.getByText(PRIVATE)).toHaveCount(0);
    for (const name of ['Coming up', 'When the time comes']) {
      expect(await page.getByRole('region', { name }).innerText()).not.toMatch(/@|example\.com/);
    }

    await coming.nth(1).getByRole('link', { name: /View message/ }).click();
    await expect(page).toHaveURL(new RegExp(`/messages/${christmas}$`));

    // Dashboard preview: dated first, the conditional one keeps a place.
    await page.goto('/dashboard');
    const preview = page.getByRole('region', { name: 'Coming up' }).getByRole('listitem');
    await expect(preview.nth(0)).toContainText('Birthday message to Sarah');
    await expect(preview.nth(2)).toContainText('After my passing');
    await page.getByRole('link', { name: /View delivery timeline/ }).click();
    await expect(page).toHaveURL(/\/messages\/timeline$/);
  } finally {
    await db(`DELETE FROM "User" WHERE email = $1`, [customer.email]);
  }
});
