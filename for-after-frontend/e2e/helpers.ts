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
