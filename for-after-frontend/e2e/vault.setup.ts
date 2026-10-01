import { expect, test as setup } from '@playwright/test';
import { newAccount, registerViaApi, signIn } from './helpers';

// Two throwaway local Customers, signed in once and reused by vault.spec.ts,
// so the suite stays inside the API's 5-per-minute login limit.
for (const who of ['a', 'b'] as const) {
  setup(`sign in customer ${who}`, async ({ page, request }) => {
    const account = { ...newAccount(), firstName: who === 'a' ? 'Alice' : 'Bruno' };
    await registerViaApi(request, account);
    await page.goto('/login');
    await signIn(page, account);
    await expect(page).toHaveURL(/\/dashboard$/);
    await page.context().storageState({ path: `e2e/.auth/${who}.json` });
  });
}
