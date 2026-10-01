import { expect, test } from '@playwright/test';

// Runs against `next build && next start` (NODE_ENV=production), even though
// .env.local says NEXT_PUBLIC_APP_ENV=development.
test('/dev-login does not exist in a production build', async ({ page, request }) => {
  expect((await request.get('/dev-login')).status()).toBe(404);
  const response = await page.goto('/dev-login');
  expect(response?.status()).toBe(404);
  await expect(page.getByText('Development only')).toHaveCount(0);
  await expect(page.getByLabel('Password')).toHaveCount(0);
});

test('the normal sign-in page is served', async ({ page }) => {
  const response = await page.goto('/login');
  expect(response?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
});
