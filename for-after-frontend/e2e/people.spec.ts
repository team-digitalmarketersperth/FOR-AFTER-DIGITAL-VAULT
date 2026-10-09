import type { Page } from '@playwright/test';
import { expect, test } from './imagekit';
import { API, newAccount, signIn } from './helpers';

// Phase 09: People I Love pages and a Recipient's private photo, through the
// real UI, API, PostgreSQL and the development ImageKit account (browser
// upload, server-verified, signed GET). Every API call goes to E2E_EMAIL_API, an API
// with EMAIL_PROVIDER=console, so registering never sends a real email.
const EMAIL_API = process.env.E2E_EMAIL_API;

// 1×1 images: the backend verifies size and type, not pixels.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const WEBP = Buffer.from('UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==', 'base64');

test.describe.configure({ mode: 'serial' });
test.skip(!EMAIL_API, 'Set E2E_EMAIL_API (an API with EMAIL_PROVIDER=console).');

const account = newAccount();
const toEmailApi = (url: string) => url.replace(new URL(API).origin, EMAIL_API!);

test.beforeEach(({ page }) =>
  page.route(`${API}/**`, (route) => route.continue({ url: toEmailApi(route.request().url()) })),
);

async function signedIn(page: Page) {
  await page.goto('/login');
  await signIn(page, account);
  await expect(page).toHaveURL(/\/dashboard/);
}

test('26 people: 25 on the first page, the 26th on the next', async ({ page }) => {
  const res = await page.request.post(toEmailApi(`${API}/auth/register`), { data: account });
  expect(res.status()).toBe(201);
  await signedIn(page);
  for (let i = 1; i <= 26; i++) {
    const created = await page.request.post(toEmailApi(`${API}/recipients`), {
      data: { firstName: `Person ${String(i).padStart(2, '0')}`, relationship: 'Friend' },
    });
    expect(created.status()).toBe(201);
  }
  await page.goto('/people');
  await expect(page.getByText('Page 1 of 2 · 26 people')).toBeVisible();
  await expect(page.getByText('Person 26')).toBeVisible(); // newest first
  await expect(page.getByText('Person 01')).toHaveCount(0);
  await page.getByRole('navigation', { name: 'People I Love pages' }).getByRole('button', { name: 'Next' }).click();
  await expect(page.getByText('Page 2 of 2 · 26 people')).toBeVisible();
  await expect(page.getByText('Person 01')).toBeVisible();
  await expect(page.getByText('Person 26')).toHaveCount(0);
});

test('photo: upload to private storage, shown from a signed URL, replaced, removed', async ({ page }) => {
  await signedIn(page);
  await page.goto('/people/new');
  await page.getByLabel('First name').fill('Mum');
  await page.getByLabel('Last name').fill('Tester');
  await page.getByRole('button', { name: 'Add person' }).click();
  await expect(page).toHaveURL(/\/people\/[0-9a-f-]{36}$/);
  await expect(page.getByText('MT', { exact: true })).toBeVisible();

  const choose = (name: string, mimeType: string, buffer: Buffer) =>
    page.locator('input[type=file]').setInputFiles({ name, mimeType, buffer });
  await choose('mum.png', 'image/png', PNG);
  const photo = page.locator('img[src*="ik-s="]').first();
  await expect(photo).toBeVisible();
  await expect.poll(() => photo.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1);
  const first = await photo.getAttribute('src');

  await expect(page.getByRole('button', { name: 'Change photo' })).toBeVisible();
  await choose('mum.webp', 'image/webp', WEBP);
  await expect.poll(() => photo.getAttribute('src')).not.toBe(first);
  await expect.poll(() => photo.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1);

  // The list shows the same private photo.
  await page.goto('/people');
  await expect(page.locator('img[src*="ik-s="]').first()).toBeVisible();

  await page.getByText('Mum Tester').click();
  await page.getByRole('button', { name: 'Remove photo' }).click();
  await expect(page.getByRole('button', { name: 'Add a photo' })).toBeVisible();
  await expect(page.locator('img[src*="ik-s="]')).toHaveCount(0);
  await expect(page.getByText('MT', { exact: true })).toBeVisible();
});

test('editing a person keeps their place and details', async ({ page }) => {
  await signedIn(page);
  await page.goto('/people');
  await page.getByText('Mum Tester').click();
  const edit = await page.getByRole('link', { name: 'Edit' }).getAttribute('href');
  // A full navigation: next dev can stall a first client-side RSC fetch.
  await page.goto(edit!);
  await page.getByLabel('Relationship').fill('Mother');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Mother').first()).toBeVisible();
});
