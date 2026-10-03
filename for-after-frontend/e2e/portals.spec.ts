import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import fs from 'node:fs';
import { API } from './helpers';

// Step 19: Recipient and Trusted Contact portals, Customer safety banner.
// Customer B (vault.setup.ts) owns the fictional test data here.
//
// OTP codes exist only in the API's console in development ([DEV ONLY] ...).
// The OTP flows run when E2E_BACKEND_LOG points at a file the backend's output
// is teed into, e.g. `npm run start:dev | tee backend.log`; the test harness
// reads the code from it, as a developer would. The UI never sees it.
const LOG = process.env.E2E_BACKEND_LOG;
const RUN = Date.now();

test.use({ storageState: 'e2e/.auth/b.json' });

/** The next code logged for this (masked) email after `from` bytes. */
async function codeFromLog(label: 'Recipient' | 'Trusted Contact', email: string, from: number) {
  const masked = email.replace(/^(.)[^@]*@/, '$1***@');
  const pattern = new RegExp(`\\[DEV ONLY\\] ${label} OTP for ${masked.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: (\\d{6})`);
  for (let i = 0; i < 40; i++) {
    const text = fs.readFileSync(LOG!, 'utf8').slice(from);
    const match = text.match(pattern);
    if (match) return match[1];
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`No ${label} OTP for ${masked} in ${LOG}`);
}

// Optional: when the API on :4000 runs in a terminal you can't tee, start a second
// instance on the same database and Redis with its output in E2E_BACKEND_LOG and
// set E2E_OTP_API to its origin (e.g. http://localhost:4001). Only the code request
// goes there; challenges and sessions live in the shared Redis.
const OTP_API = process.env.E2E_OTP_API;

async function signInWithCode(page: Page, portal: 'recipient' | 'trusted-contact', email: string) {
  if (OTP_API) {
    await page.route('**/*-auth/request-otp', (route) =>
      route.continue({ url: route.request().url().replace(new URL(API).origin, OTP_API) }),
    );
  }
  const from = fs.statSync(LOG!).size;
  await page.goto(`/${portal}/sign-in`);
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Send me a code' }).click();
  await expect(page.getByLabel('6-digit code')).toBeVisible();
  const code = await codeFromLog(portal === 'recipient' ? 'Recipient' : 'Trusted Contact', email, from);
  await page.getByLabel('6-digit code').fill(code);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

const status = async (request: APIRequestContext, path: string) => (await request.get(`${API}${path}`)).status();

test('a Customer session alone opens neither portal', async ({ page }) => {
  expect(await status(page.request, '/auth/me')).toBe(200);
  for (const path of ['/recipient-auth/me', '/recipient/messages', '/trusted-contact-auth/me', '/trusted-contact/accounts']) {
    expect(await status(page.request, path), path).toBe(401);
  }
  await page.goto('/recipient/messages');
  await expect(page).toHaveURL(/\/recipient\/sign-in$/);
  await page.goto('/trusted-contact/accounts');
  await expect(page).toHaveURL(/\/trusted-contact\/sign-in$/);
});

test('sign-in never reveals whether an email has access', async ({ page }) => {
  await page.goto('/recipient/sign-in');
  await expect(page.getByRole('heading', { name: /Messages shared with you/ })).toBeVisible();
  await page.getByLabel('Email').fill(`nobody-${RUN}@example.com`);
  await page.getByRole('button', { name: 'Send me a code' }).click();
  await expect(page.getByText('If released content is available for this email, a verification code has been sent.')).toBeVisible();
  await expect(page.getByLabel('6-digit code')).toBeVisible();
});

test.describe('with the dev OTP log', () => {
  test.skip(!LOG, 'Set E2E_BACKEND_LOG to the backend output file to run the OTP flows.');

  test('Trusted Contact: sign in → accounts → death report → status; Customer confirms alive', async ({ page, browser }) => {
    const email = `david@tc-${RUN}.example.com`;
    const created = await page.request.post(`${API}/trusted-contacts`, { data: { firstName: 'David', relationship: 'Brother', email } });
    expect(created.status()).toBe(201);
    const tc = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const tcPage = await tc.newPage();

    await signInWithCode(tcPage, 'trusted-contact', email);
    await expect(tcPage).toHaveURL(/\/trusted-contact\/accounts$/);
    await expect(tcPage.getByText(/a report never releases any messages/)).toBeVisible();
    await tcPage.getByRole('link', { name: /Bruno/ }).click();
    await expect(tcPage.getByRole('heading', { name: 'No report submitted' })).toBeVisible();
    await tcPage.getByRole('link', { name: 'Submit a death report' }).click();

    // Fictional test data only.
    await tcPage.getByLabel(/^Note for the For After team/).fill('E2E test report. Fictional.');
    await tcPage.getByRole('button', { name: 'Submit report' }).click();
    await expect(tcPage.getByText('Please confirm you understand before submitting.')).toBeVisible();
    await tcPage.getByRole('checkbox').check();
    await tcPage.getByRole('button', { name: 'Submit report' }).click();
    await expect(tcPage.getByText('Your report has been submitted for verification')).toBeVisible();
    await expect(tcPage.getByText('You submitted a report for this account.')).toBeVisible();
    await expect(tcPage.getByRole('link', { name: 'Submit a death report' })).toHaveCount(0);

    // The Trusted Contact cookie opens nothing else.
    expect(await status(tcPage.request, '/recipient/messages')).toBe(401);
    expect(await status(tcPage.request, '/messages')).toBe(401);

    // The account holder sees the calm banner and closes the case.
    await page.goto('/dashboard');
    const banner = page.getByRole('region', { name: /received a report about your account/ });
    await expect(banner).toBeVisible();
    await banner.getByRole('button', { name: "I'm still alive" }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Yes, close the report' }).click();
    await expect(banner).toHaveCount(0);
    expect((await (await page.request.get(`${API}/death-verification/me`)).json()).status).toBe('CANCELLED');

    await tcPage.reload();
    await expect(tcPage.getByRole('heading', { name: 'Case closed' })).toBeVisible();
    await tcPage.getByRole('button', { name: 'Sign out' }).click();
    await expect(tcPage).toHaveURL(/\/trusted-contact\/sign-in$/);
    expect(await status(tcPage.request, '/trusted-contact/accounts')).toBe(401);
    await tc.close();
  });

  test('Recipient: only released, granted messages; read; sign out', async ({ page, browser }) => {
    test.setTimeout(6 * 60_000); // waits for a real FIXED_DATE release
    const email = `sofia@rc-${RUN}.example.com`;
    const recipient = await (await page.request.post(`${API}/recipients`, { data: { firstName: 'Sofia', email } })).json();
    const make = async (title: string) =>
      (await page.request.post(`${API}/messages`, { data: { title, textContent: `Dear Sofia,\n\n${title}.`, recipientIds: [recipient.id] } })).json();
    const released = await make('Released letter');
    const scheduled = await make('Scheduled letter');
    await make('Draft letter');
    const soon = new Date(Date.now() + 70_000).toISOString();
    expect((await page.request.post(`${API}/messages/${released.id}/schedule`, { data: { triggerType: 'FIXED_DATE', scheduledFor: soon } })).status()).toBe(201);
    expect((await page.request.post(`${API}/messages/${scheduled.id}/schedule`, { data: { triggerType: 'ON_DEATH' } })).status()).toBe(201);
    await expect
      .poll(async () => (await (await page.request.get(`${API}/messages/${released.id}`)).json()).status, { timeout: 4 * 60_000, intervals: [5_000] })
      .toBe('RELEASED');

    const rc = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const rcPage = await rc.newPage();
    await signInWithCode(rcPage, 'recipient', email);
    await expect(rcPage).toHaveURL(/\/recipient\/messages$/);
    await expect(rcPage.getByRole('link', { name: /Released letter/ })).toBeVisible();
    await expect(rcPage.getByText('Scheduled letter')).toHaveCount(0);
    await expect(rcPage.getByText('Draft letter')).toHaveCount(0);
    expect(await status(rcPage.request, `/recipient/messages/${scheduled.id}`)).toBe(404);

    await rcPage.getByRole('link', { name: /Released letter/ }).click();
    await expect(rcPage.getByText('Released letter.')).toBeVisible();
    await rcPage.reload(); // session is the cookie + Redis, not page state
    await expect(rcPage.getByText('Released letter.')).toBeVisible();

    expect(await status(rcPage.request, '/trusted-contact/accounts')).toBe(401);
    expect(await status(rcPage.request, '/messages')).toBe(401);

    await rcPage.getByRole('button', { name: 'Sign out' }).click();
    await expect(rcPage).toHaveURL(/\/recipient\/sign-in$/);
    expect(await status(rcPage.request, '/recipient/messages')).toBe(401);
    await rc.close();
  });
});
