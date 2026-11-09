import fs from 'node:fs';
import { createRequire } from 'node:module';
import { parseEnv } from 'node:util';
import { expect, type Browser, type Page } from '@playwright/test';
import { emailFromLog, freshTotp } from './helpers';

// Shared by the death-verification specs (Phase 19A/19B). Local only.
const LOG = process.env.E2E_BACKEND_LOG;
const backend = '../for-after-backend';

/** One query against the LOCAL development database (test harness only). */
export async function db<T>(sql: string, params: unknown[]): Promise<T[]> {
  const url = process.env.DATABASE_URL ?? parseEnv(fs.readFileSync(`${backend}/.env`, 'utf8')).DATABASE_URL!;
  if (!['localhost', '127.0.0.1'].includes(new URL(url).hostname)) throw new Error('E2E database must be local');
  const { Client } = createRequire(`${process.cwd()}/${backend}/package.json`)('pg');
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query(sql, params)).rows as T[];
  } finally {
    await client.end();
  }
}

/** A fresh browser context signed in to the Trusted Contact portal with the code from the API log. */
export async function trustedContactSignIn(browser: Browser, email: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  const from = fs.statSync(LOG!).size;
  await page.goto('/trusted-contact/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Send me a code' }).click();
  const line = await emailFromLog(LOG!, 'trusted-contact-otp', email, from);
  await page.getByLabel('6-digit code').fill(line.match(/Your sign-in code is (\d{6})/)![1]);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/trusted-contact\/accounts$/);
  return page;
}

/** A freshly promoted admin: password, TOTP enrolment (key read from the page), recovery codes. */
export async function adminSignIn(browser: Browser, email: string, password: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto('/admin/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Set up my authenticator' }).click();
  await page.getByText("Can't scan it? Enter a setup key instead").click();
  const secret = (await page.locator('p.font-mono').first().innerText()).replace(/\s/g, '');
  await page.getByLabel('6-digit code').fill((await freshTotp(secret)).code);
  await page.getByRole('button', { name: 'Confirm and continue' }).click();
  await page.getByLabel(/saved these recovery codes/).check();
  await page.getByRole('button', { name: 'Continue to the Admin Portal' }).click();
  await expect(page).toHaveURL(/\/admin$/);
  return page;
}

/** The Trusted Contact files their own report from the account page (existing form). */
export async function submitReport(tc: Page, accountName: string) {
  await tc.goto('/trusted-contact/accounts');
  await tc.getByRole('link', { name: new RegExp(accountName) }).click();
  await tc.getByRole('link', { name: 'Submit a death report' }).click();
  await tc.getByRole('checkbox').check();
  await tc.getByRole('button', { name: 'Submit report' }).click();
  await expect(tc.getByText('Your report has been submitted for verification')).toBeVisible();
  await expect(tc.getByText('You submitted a report for this account.')).toBeVisible();
}
