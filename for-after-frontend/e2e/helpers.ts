import { createHmac } from 'node:crypto';
import fs from 'node:fs';
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

const masked = (email: string) => email.replace(/^(.)[^@]*@/, '$1***@').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Step 24: with EMAIL_PROVIDER=console the API prints each email it would send
 * ("[DEV ONLY] Email (<kind>) to s***@… | subject | plain text") to its output,
 * which the test teed into `log`. Waits for the next one of `kind` to this
 * (masked) address after `from` bytes.
 */
export async function emailFromLog(log: string, kind: string, email: string, from: number) {
  const pattern = new RegExp(`\\[DEV ONLY\\] Email \\(${kind}\\) to ${masked(email)} \\| [^\\n]*`);
  for (let i = 0; i < 40; i++) {
    const match = fs.readFileSync(log, 'utf8').slice(from).match(pattern);
    if (match) return match[0];
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`No ${kind} email for ${email.replace(/^(.)[^@]*@/, '$1***@')} in ${log}`);
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

// Synthetic media: a 1×1 PNG and a valid 0.1 s silent WAV (8 kHz, 8-bit mono).
export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
export const WAV = (() => {
  const pcm = Buffer.alloc(800, 0x80);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(8000, 24);
  header.writeUInt32LE(8000, 28);
  header.writeUInt16LE(1, 32);
  header.writeUInt16LE(8, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
})();
