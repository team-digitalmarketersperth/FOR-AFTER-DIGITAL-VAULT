import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import { API, newAccount, registerViaApi, smsCodeFromLog } from './helpers';

// Phase 10: a mobile-only Trusted Contact (no email, so no invitation) signs in
// by SMS code against a real local API whose SMS provider is the development
// console (SMS_VERIFY_PROVIDER=console): no real SMS, no Twilio. The code is
// read from the API output in E2E_BACKEND_LOG. The real-Twilio check is manual.
const LOG = process.env.E2E_BACKEND_LOG;
const RUN = Date.now();

test.skip(!LOG, 'Set E2E_BACKEND_LOG to the output of an API with SMS_VERIFY_PROVIDER=console.');

test('a mobile-only Trusted Contact signs in by SMS and sees only the relationship', async ({ page, browser }) => {
  // Fictional AU mobile, unique per run.
  const mobile = `+614${String(RUN).slice(-8)}`;
  const account = newAccount();
  await registerViaApi(page.request, account);
  const { email, password } = account;
  expect((await page.request.post(`${API}/auth/login`, { data: { email, password } })).status()).toBe(200);
  const contact = await (
    await page.request.post(`${API}/trusted-contacts`, {
      data: { firstName: 'Maya', relationship: 'Cousin', mobile: `${mobile.slice(0, 3)} ${mobile.slice(3)}` },
    })
  ).json();
  expect(contact).toMatchObject({ email: null, mobile });
  // Private content the contact must never see.
  const recipient = await (await page.request.post(`${API}/recipients`, { data: { firstName: 'Sofia' } })).json();
  expect(
    (
      await page.request.post(`${API}/messages`, {
        data: { title: 'A private letter', textContent: 'Not for contacts.', recipientIds: [recipient.id] },
      })
    ).status(),
  ).toBe(201);

  const tc = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const tcPage = await tc.newPage();
  await tcPage.goto('/trusted-contact/sign-in');
  await tcPage.getByRole('button', { name: 'Mobile' }).click();
  await expect(tcPage.getByText(/send a private 6-digit verification code by SMS/)).toBeVisible();
  await expect(tcPage.getByText(/agree to receive a verification code by SMS/)).toBeVisible();
  await tcPage.getByLabel('Country code').selectOption('+61');
  await tcPage.getByLabel('Mobile number').fill(`0${mobile.slice(3)}`);
  const from = fs.statSync(LOG!).size;
  await tcPage.getByRole('button', { name: 'Text me a code' }).click();
  await expect(tcPage.getByText('Check your phone')).toBeVisible();
  await expect(tcPage.getByText(`+61 ••• ••• ${mobile.slice(-3)}`)).toBeVisible();
  const code = await smsCodeFromLog(LOG!, mobile, from);

  await tcPage.getByLabel('6-digit code').fill(code === '000000' ? '111111' : '000000');
  await tcPage.getByRole('button', { name: 'Sign in' }).click();
  await expect(tcPage.getByText('The code is invalid or has expired. Request a new code.')).toBeVisible();
  expect((await tcPage.request.get(`${API}/trusted-contact/accounts`)).status()).toBe(401);

  await tcPage.getByLabel('6-digit code').fill(code);
  await tcPage.getByRole('button', { name: 'Sign in' }).click();
  await expect(tcPage).toHaveURL(/\/trusted-contact\/accounts$/);
  await expect(tcPage.getByText(`${account.firstName} ${account.lastName}`)).toBeVisible();
  await expect(tcPage.getByText('A private letter')).toHaveCount(0);
  const cookie = (await tc.cookies()).find((c) => c.name === 'for_after_trusted_contact_session');
  expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Lax' });

  // Allowed: the account's death-verification status. Forbidden: content and other portals.
  expect((await tcPage.request.get(`${API}/trusted-contact/accounts/${contact.id}/death-verification`)).status()).toBe(200);
  for (const path of ['/messages', '/recipients', '/recipient/messages', '/auth/me']) {
    expect((await tcPage.request.get(`${API}${path}`)).status(), path).toBe(401);
  }

  // Removing the contact ends access at once.
  expect((await page.request.delete(`${API}/trusted-contacts/${contact.id}`)).status()).toBe(204);
  expect(await (await tcPage.request.get(`${API}/trusted-contact/accounts`)).json()).toEqual([]);

  await tcPage.getByRole('button', { name: 'Sign out' }).click();
  await expect(tcPage).toHaveURL(/\/trusted-contact\/sign-in$/);
  await tc.close();
});

test('phone width: the Trusted Contact Email/Mobile tabs and number field fit', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 740 }, storageState: { cookies: [], origins: [] } });
  const page = await ctx.newPage();
  await page.goto('/trusted-contact/sign-in');
  await page.getByRole('button', { name: 'Mobile' }).click();
  await expect(page.getByLabel('Mobile number')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await page.screenshot({ path: 'test-results/trusted-contact-sms-mobile.png', fullPage: true });
  await ctx.close();
});
