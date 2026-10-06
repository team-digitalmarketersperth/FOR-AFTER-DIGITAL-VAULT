import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import { API, emailFromLog, newAccount, registerViaApi, signIn } from './helpers';

// Phase 10 against the real API: email invitations, the two-contact maximum
// and a new death report after a closed case. Emails are read from the API's
// console output (EMAIL_PROVIDER=console, teed to E2E_BACKEND_LOG), as in
// portals.spec. Fictional data only; never Twilio or a real inbox.
const LOG = process.env.E2E_BACKEND_LOG;
const RUN = Date.now();

test.describe.configure({ mode: 'serial' });
test.skip(!LOG, 'Set E2E_BACKEND_LOG to the backend output file to run the Phase 10 flows.');

const logSize = () => fs.statSync(LOG!).size;
const DAVID = `david@tc-${RUN}.example.com`;

let customer: Page;
let tc: Page;

test.beforeAll(async ({ browser }) => {
  const account = { ...newAccount(), firstName: 'Clara', lastName: 'Phase' };
  const ctx = await browser.newContext();
  customer = await ctx.newPage();
  await registerViaApi(ctx.request, account);
  await customer.goto('/login');
  await signIn(customer, account);
  await expect(customer).toHaveURL(/\/dashboard$/);
  tc = await (await browser.newContext()).newPage();
});

test('A: add with email → invitation emailed → accept → still email-OTP sign-in → limited portal', async () => {
  const from = logSize();
  await customer.goto('/trusted-contacts/new');
  await customer.getByLabel('First name').fill('David');
  await customer.getByLabel(/^Email/).fill(DAVID);
  await customer.getByRole('button', { name: 'Add trusted contact' }).click();
  await expect(customer.getByText('David was added and we’ve emailed them an invitation')).toBeVisible();
  await expect(customer.getByRole('link', { name: /David/ })).toContainText('Invitation pending');

  const mail = await emailFromLog(LOG!, 'trusted-contact-invitation', DAVID, from);
  expect(mail).toContain('Clara Phase');
  const link = mail.match(/https?:\/\/\S+\/trusted-contact\/invitation\?token=[A-Za-z0-9_-]{43}/)![0];

  await tc.goto(new URL(link).pathname + new URL(link).search);
  await expect(tc.getByRole('heading', { name: /trusted contact for Clara Phase/ })).toBeVisible();
  await expect(tc.getByText(/not be given access to their private preserved messages/)).toBeVisible();
  await tc.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(tc.getByRole('heading', { name: 'You’ve accepted the invitation' })).toBeVisible();

  // Accepting signed no one in: the portal still needs the email code.
  expect((await tc.request.get(`${API}/trusted-contact/accounts`)).status()).toBe(401);
  await customer.reload();
  await expect(customer.getByRole('link', { name: /David/ })).toContainText('Invitation accepted');

  const codeFrom = logSize();
  await tc.getByRole('link', { name: 'Go to trusted contact sign-in' }).click();
  await tc.getByLabel('Email').fill(DAVID);
  await tc.getByRole('button', { name: 'Send me a code' }).click();
  const code = (await emailFromLog(LOG!, 'trusted-contact-otp', DAVID, codeFrom)).match(/Your sign-in code is (\d{6})/)![1];
  await tc.getByLabel('6-digit code').fill(code);
  await tc.getByRole('button', { name: 'Sign in' }).click();
  await expect(tc).toHaveURL(/\/trusted-contact\/accounts$/);
  await expect(tc.getByRole('link', { name: /Clara Phase/ })).toBeVisible();
  for (const path of ['/messages', '/recipients', '/memory-vault', '/trusted-contacts']) {
    expect((await tc.request.get(`${API}${path}`)).status()).toBe(401);
  }
});

test('B: two contacts → add blocked in the UI and by the API → remove one → add again', async () => {
  await customer.goto('/trusted-contacts/new');
  await customer.getByLabel('First name').fill('Mo');
  await customer.getByLabel(/^Mobile/).fill('+61 400 000 222');
  await customer.getByRole('button', { name: 'Add trusted contact' }).click();
  await expect(customer).toHaveURL(/\/trusted-contacts$/);
  // Mobile only: no invitation is possible (SMS is deferred), and none is claimed.
  await expect(customer.getByRole('link', { name: /Mo/ })).toContainText('No invitation');

  await expect(customer.getByRole('note')).toContainText('You can nominate up to 2 trusted contacts.');
  await expect(customer.getByRole('link', { name: 'Add a trusted contact' })).toHaveCount(0);
  await customer.goto('/trusted-contacts/new');
  await expect(customer.getByRole('heading', { name: 'You’ve reached the limit' })).toBeVisible();
  const third = await customer.request.post(`${API}/trusted-contacts`, { data: { firstName: 'Third', mobile: '+61400000333' } });
  expect(third.status()).toBe(409);

  await customer.goto('/trusted-contacts');
  await customer.getByRole('link', { name: /Mo/ }).click();
  await expect(customer.getByText(/Text-message invitations aren’t available yet/)).toBeVisible();
  await customer.getByRole('button', { name: 'Remove' }).click();
  await customer.getByRole('dialog').getByRole('button', { name: 'Remove' }).click();
  await expect(customer).toHaveURL(/\/trusted-contacts$/);
  await expect(customer.getByRole('link', { name: 'Add a trusted contact' })).toBeVisible();
});

test('C: report → Customer confirms alive (case closed) → a new report starts a new case', async () => {
  await tc.goto('/trusted-contact/accounts');
  await tc.getByRole('link', { name: /Clara Phase/ }).click();
  await tc.getByRole('link', { name: 'Submit a death report' }).click();
  await tc.getByLabel(/^Note for the For After team/).fill('Phase 10 E2E. Fictional.');
  await tc.getByRole('checkbox').check();
  await tc.getByRole('button', { name: 'Submit report' }).click();
  await expect(tc.getByText('You submitted a report for this account.')).toBeVisible();
  const first = (await (await customer.request.get(`${API}/death-verification/me`)).json()).status;
  expect(['PENDING_VERIFICATION', 'SAFEGUARD_ACTIVE']).toContain(first);

  await customer.goto('/dashboard');
  const banner = customer.getByRole('region', { name: /received a report about your account/ });
  await banner.getByRole('button', { name: "I'm still alive" }).click();
  await customer.getByRole('dialog').getByRole('button', { name: 'Yes, close the report' }).click();
  await expect(banner).toHaveCount(0);

  await tc.reload();
  await expect(tc.getByRole('heading', { name: 'Case closed' })).toBeVisible();
  await expect(tc.getByText(/This case is closed. If they have since passed away/)).toBeVisible();
  await tc.getByRole('link', { name: 'Submit a new death report' }).click();
  await tc.getByRole('checkbox').check();
  await tc.getByRole('button', { name: 'Submit report' }).click();
  await expect(tc.getByText('Your report has been submitted for verification')).toBeVisible();
  await expect(tc.getByRole('link', { name: /Submit a (new )?death report/ })).toHaveCount(0);

  // A new open case, with the full safety workflow again: the banner is back.
  const me = await (await customer.request.get(`${API}/death-verification/me`)).json();
  expect(me.canConfirmAlive).toBe(true);
  await customer.goto('/dashboard');
  await expect(customer.getByRole('region', { name: /received a report about your account/ })).toBeVisible();
});
