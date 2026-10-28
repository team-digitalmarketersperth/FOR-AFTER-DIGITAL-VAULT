import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import { API, newAccount, registerViaApi, smsCodeFromLog } from './helpers';

// Recipient SMS sign-in against a real local API whose SMS provider is the
// development console (SMS_VERIFY_PROVIDER=console): no real SMS, no Twilio.
// The code is read from the API output in E2E_BACKEND_LOG, as a developer
// would; the UI never sees it. Needs a release worker on the same queues.
// The real-Twilio check is manual (docs/recipient-portal.md §3b).
const LOG = process.env.E2E_BACKEND_LOG;
const RUN = Date.now();

test.skip(!LOG, 'Set E2E_BACKEND_LOG to the output of an API with SMS_VERIFY_PROVIDER=console.');

test('Recipient signs in by SMS code and reads a message released to their mobile', async ({ page, browser }) => {
  test.setTimeout(6 * 60_000); // waits for a real FIXED_DATE release
  // Fictional AU mobile, unique per run.
  const mobile = `+614${String(RUN).slice(-8)}`;
  // Phase 18: the sender's name is what the Recipient sees.
  const account = { ...newAccount(), firstName: 'Lisa', lastName: 'Bridgett' };
  await registerViaApi(page.request, account);
  const { email, password } = account;
  expect((await page.request.post(`${API}/auth/login`, { data: { email, password } })).status()).toBe(200);
  const recipient = await (
    await page.request.post(`${API}/recipients`, { data: { firstName: 'Max', mobile: `${mobile.slice(0, 3)} ${mobile.slice(3)}` } })
  ).json();
  expect(recipient.mobile).toBe(mobile);
  const message = await (
    await page.request.post(`${API}/messages`, {
      data: { title: 'A letter by text', textContent: 'Dear Max,\n\nThis came by text.', recipientIds: [recipient.id] },
    })
  ).json();
  // Never released: must stay invisible to the SMS session.
  const draft = await (
    await page.request.post(`${API}/messages`, {
      data: { title: 'A draft by text', textContent: 'Not yet.', recipientIds: [recipient.id] },
    })
  ).json();
  const soon = new Date(Date.now() + 70_000).toISOString();
  expect(
    (await page.request.post(`${API}/messages/${message.id}/schedule`, { data: { triggerType: 'FIXED_DATE', scheduledFor: soon } })).status(),
  ).toBe(201);
  await expect
    .poll(async () => (await (await page.request.get(`${API}/messages/${message.id}`)).json()).status, {
      timeout: 4 * 60_000,
      intervals: [5_000],
    })
    .toBe('RELEASED');

  const rc = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const rcPage = await rc.newPage();
  await rcPage.goto('/recipient/sign-in');
  await rcPage.getByRole('button', { name: 'Mobile' }).click();
  await expect(rcPage.getByText(/agree to receive a verification code by SMS/)).toBeVisible();
  await rcPage.getByLabel('Country code').selectOption('+61');
  // National format: the leading 0 is dropped.
  await rcPage.getByLabel('Mobile number').fill(`0${mobile.slice(3)}`);
  const from = fs.statSync(LOG!).size;
  await rcPage.getByRole('button', { name: 'Text me a code' }).click();
  await expect(rcPage.getByText('Check your phone')).toBeVisible();
  await expect(rcPage.getByText(`+61 ••• ••• ${mobile.slice(-3)}`)).toBeVisible();
  const code = await smsCodeFromLog(LOG!, mobile, from);

  // A wrong code first: generic error, no session.
  await rcPage.getByLabel('6-digit code').fill(code === '000000' ? '111111' : '000000');
  await rcPage.getByRole('button', { name: 'Sign in' }).click();
  await expect(rcPage.getByText('The code is invalid or has expired. Request a new code.')).toBeVisible();
  expect((await rcPage.request.get(`${API}/recipient/messages`)).status()).toBe(401);

  await rcPage.getByLabel('6-digit code').fill(code);
  await rcPage.getByRole('button', { name: 'Sign in' }).click();
  await expect(rcPage).toHaveURL(/\/recipient\/messages$/);
  await expect(rcPage.getByRole('link', { name: /A letter by text/ })).toBeVisible();
  await expect(rcPage.getByText('A draft by text')).toHaveCount(0);
  expect((await rcPage.request.get(`${API}/recipient/messages/${draft.id}`)).status()).toBe(404);
  const cookies = await rc.cookies();
  expect(cookies.find((c) => c.name === 'for_after_recipient_session')).toMatchObject({ httpOnly: true, sameSite: 'Lax' });

  // Phase 18: the letter says who it is from, and a later rename never rewrites it.
  await rcPage.getByRole('link', { name: /A letter by text/ }).click();
  const header = rcPage.locator('article header');
  await expect(header.getByText('Lisa Bridgett')).toBeVisible();
  await expect(header).toContainText('From Lisa Bridgett');
  await expect(rcPage.getByText(account.email)).toHaveCount(0);
  expect((await page.request.patch(`${API}/users/me`, { data: { firstName: 'Elisabeth', lastName: 'B.' } })).status()).toBe(200);
  await rcPage.reload();
  await expect(header).toContainText('From Lisa Bridgett');
  await expect(rcPage.getByText('Elisabeth')).toHaveCount(0);
  await rcPage.getByRole('link', { name: 'Back to messages' }).click();

  // The same code again (Verify would have consumed it) gets nowhere.
  expect(
    (await rcPage.request.post(`${API}/recipient-auth/verify-sms-otp`, { data: { mobile, code } })).status(),
  ).toBe(401);

  await rcPage.getByRole('button', { name: 'Sign out' }).click();
  await expect(rcPage).toHaveURL(/\/recipient\/sign-in$/);
  expect((await rcPage.request.get(`${API}/recipient/messages`)).status()).toBe(401);
  await rc.close();
});

test('mobile layout: the Email/Mobile switch and number field fit a phone screen', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 740 }, storageState: { cookies: [], origins: [] } });
  const page = await ctx.newPage();
  await page.goto('/recipient/sign-in');
  await page.getByRole('button', { name: 'Mobile' }).click();
  await expect(page.getByLabel('Mobile number')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await page.screenshot({ path: 'test-results/recipient-sms-mobile.png', fullPage: true });
  await ctx.close();
});
