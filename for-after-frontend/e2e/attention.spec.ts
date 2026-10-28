import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { db } from './death-helpers';
import { API, emailFromLog, newAccount, registerViaApi } from './helpers';

// Dashboard "Needs your attention", local only, against the isolated
// console-email API (the Trusted Contact invitation is printed, never sent)
// started with STORAGE_LIMIT_BYTES=1000, so one synthetic 950-byte READY row
// makes storage 95% full without touching ImageKit. Fictional data; the
// Customer is deleted afterwards.
const LOG = process.env.E2E_BACKEND_LOG;
test.skip(
  !LOG || process.env.E2E_STORAGE_LIMIT_BYTES !== '1000',
  'Set E2E_BACKEND_LOG and E2E_STORAGE_LIMIT_BYTES=1000 (isolated console-email API with STORAGE_LIMIT_BYTES=1000).',
);

const section = (page: Page) => page.getByRole('region', { name: 'Needs your attention' });
const rows = (page: Page) => section(page).getByRole('listitem');

test('four real items; scheduling and an accepted invitation make theirs disappear', async ({ page }) => {
  const customer = newAccount();
  try {
    await registerViaApi(page.request, customer);
    expect(
      (await page.request.post(`${API}/auth/login`, { data: { email: customer.email, password: customer.password } })).status(),
    ).toBe(200);
    const send = async (method: 'post' | 'patch', path: string, data: object) => {
      const res = await page.request[method](`${API}${path}`, { data });
      expect(res.ok(), `${path} → ${res.status()}`).toBe(true);
      return res.json();
    };

    await page.goto('/dashboard');
    await expect(section(page).getByText('Everything looks in order')).toBeVisible();

    // A scheduled birthday message for Sarah, whose birthday is then cleared.
    const sarah = await send('post', '/recipients', { firstName: 'Sarah', birthday: '1990-05-05' });
    const birthday = await send('post', '/messages', { title: 'Happy birthday', textContent: 'Fictional.', recipientIds: [sarah.id] });
    await send('post', `/messages/${birthday.id}/schedule`, { triggerType: 'BIRTHDAY', timezone: 'Australia/Perth', localTime: '09:00' });
    await send('patch', `/recipients/${sarah.id}`, { birthday: null });
    // Two messages without timing.
    const drafts = [];
    for (const title of ['For Sarah', 'Another note'])
      drafts.push(await send('post', '/messages', { title, textContent: 'Fictional.', recipientIds: [sarah.id] }));
    // A Trusted Contact who has not accepted yet.
    const tcEmail = `e2e-at-tc-${Date.now()}@example.com`;
    const from = fs.statSync(LOG!).size;
    await send('post', '/trusted-contacts', { firstName: 'James', email: tcEmail });
    // 950 of 1000 bytes.
    const [{ id: ownerUserId }] = await db<{ id: string }>(`SELECT id FROM "User" WHERE email = $1`, [customer.email]);
    await db(
      `INSERT INTO "MediaAsset" (id, "ownerUserId", "messageId", kind, status, "storageKey", "originalFileName", "mimeType", "sizeBytes", "updatedAt")
       VALUES ($1, $2, $3, 'PHOTO', 'READY', $4, 'synthetic.jpg', 'image/jpeg', 950, now())`,
      [randomUUID(), ownerUserId, birthday.id, `test/attention/${randomUUID()}.jpg`],
    );

    await page.goto('/dashboard');
    await expect(rows(page)).toHaveCount(4);
    await expect(rows(page)).toHaveText([
      /Storage is 95% full.*Manage storage/,
      /James hasn’t accepted the invitation yet.*Review contacts/,
      /2 messages need timing.*Review messages/,
      /Sarah is missing a birthday.*Needed for 1 scheduled birthday message\..*Add birthday/,
    ]);
    await expect(section(page).getByRole('link', { name: /Sarah is missing a birthday/ })).toHaveAttribute(
      'href',
      `/people/${sarah.id}/edit`,
    );

    // Schedule one message: the count updates on the next visit.
    await send('post', `/messages/${drafts[0].id}/schedule`, {
      triggerType: 'FIXED_DATE',
      scheduledFor: new Date(Date.now() + 365 * 86_400_000).toISOString(),
    });
    await page.goto('/dashboard');
    await expect(section(page).getByText('1 message needs timing')).toBeVisible();

    // James accepts (token from the console email): his item disappears.
    const token = (await emailFromLog(LOG!, 'trusted-contact-invitation', tcEmail, from)).match(/token=([A-Za-z0-9_-]{43})/)![1];
    expect((await page.request.post(`${API}/trusted-contact/invitation/accept`, { data: { token } })).ok()).toBe(true);
    await page.goto('/dashboard');
    await expect(rows(page)).toHaveCount(3);
    await expect(section(page).getByText(/James/)).toHaveCount(0);

    // The birthday row leads to the edit page.
    await section(page).getByRole('link', { name: /Sarah is missing a birthday/ }).click();
    await expect(page).toHaveURL(new RegExp(`/people/${sarah.id}/edit$`));
  } finally {
    await db(`DELETE FROM "User" WHERE email = $1`, [customer.email]);
  }
});

test('phone width: rows stack, no horizontal scroll', async ({ page }) => {
  const customer = newAccount();
  try {
    await registerViaApi(page.request, customer);
    await page.request.post(`${API}/auth/login`, { data: { email: customer.email, password: customer.password } });
    const person = await (await page.request.post(`${API}/recipients`, { data: { firstName: 'Mia' } })).json();
    await page.request.post(`${API}/messages`, { data: { title: 'Untimed', textContent: 'Fictional.', recipientIds: [person.id] } });
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto('/dashboard');
    await expect(section(page).getByText('1 message needs timing')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  } finally {
    await db(`DELETE FROM "User" WHERE email = $1`, [customer.email]);
  }
});
