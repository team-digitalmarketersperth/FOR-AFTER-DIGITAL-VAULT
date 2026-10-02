import { createHmac } from 'node:crypto';
import type { APIRequestContext, Page } from '@playwright/test';

export const API = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000/api/v1';

// Throwaway local accounts: unique per run, never real people or production data.
export const newAccount = () => ({
  firstName: 'Edith',
  lastName: 'Tester',
  email: `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`,
  password: 'a local e2e passphrase',
});

export type Account = ReturnType<typeof newAccount>;

export async function registerViaApi(request: APIRequestContext, account: Account) {
  const response = await request.post(`${API}/auth/register`, { data: account });
  if (response.status() !== 201) {
    throw new Error(`Register failed with ${response.status()} (throttled? wait a minute)`);
  }
}

export async function signIn(page: Page, { email, password }: Account) {
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

// ─── Admin TOTP (test harness only) ─────────────────────────────────────────
// RFC 6238 with authenticator-app defaults (SHA-1, 6 digits, 30 s), computed
// the way a phone would, from the setup key the enrollment page shows. Never
// used by the app itself.

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const base32Decode = (secret: string) => {
  const bits = [...secret.replace(/[\s=]/g, '').toUpperCase()]
    .map((c) => BASE32.indexOf(c).toString(2).padStart(5, '0'))
    .join('');
  return Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => parseInt(b, 2)));
};

export const totpStep = () => Math.floor(Date.now() / 30_000);

export function totp(secret: string, step = totpStep()) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  return String((hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

/** A code from a time step after `usedStep`: the API refuses a step it has already accepted. */
export async function freshTotp(secret: string, usedStep = -1) {
  while (totpStep() <= usedStep) await new Promise((r) => setTimeout(r, 1000));
  const step = totpStep();
  return { code: totp(secret, step), step };
}
