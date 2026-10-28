import { expect, test, type Page } from '@playwright/test';
import { db } from './death-helpers';
import { API, newAccount, registerViaApi } from './helpers';

// Recent changes, local only: real changes through the API, then the dashboard
// and the full history show them in order. Isolated console-email API (the
// sign-up's verification email is printed, never sent). The user is deleted after.
const LOG = process.env.E2E_BACKEND_LOG;
test.skip(!LOG, 'Set E2E_BACKEND_LOG (isolated console-email API) to run the activity flow.');

const recent = (page: Page) => page.getByRole('region', { name: 'Recent changes' }).getByRole('listitem');

test('changes appear in Recent changes and the full history, newest first', async ({ page }) => {
  const customer = newAccount();
  try {
    await registerViaApi(page.request, customer);
    expect(
      (await page.request.post(`${API}/auth/login`, { data: { email: customer.email, password: customer.password } })).status(),
    ).toBe(200);
    const send = async (method: 'post' | 'patch', path: string, data: object) => {
      const res = await page.request[method](`${API}${path}`, { data });
      expect(res.ok(), `${path} → ${res.status()}`).toBe(true);
      return res.json();
    };

    await page.goto('/dashboard');
    await expect(page.getByText(/No recent changes yet/)).toBeVisible();

    const person = await send('post', '/recipients', { firstName: 'Sofia' });
    const message = await send('post', '/messages', { title: 'For Sofia', textContent: 'Fictional words.', recipientIds: [person.id] });
    await send('patch', `/messages/${message.id}`, { textContent: 'Fictional words, revised.' });
    await page.goto('/dashboard');
    await expect(recent(page).first()).toContainText('Message updated');
    await expect(recent(page).first().getByRole('link')).toHaveAttribute('href', `/messages/${message.id}`);

    await send('post', '/memory-vault', { title: 'Lake house', category: 'FAMILY', textContent: 'Fictional.' });
    await page.goto('/dashboard');
    await expect(recent(page).first()).toContainText('Memory added');

    const at = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
    await send('post', `/messages/${message.id}/schedule`, { triggerType: 'FIXED_DATE', scheduledFor: at(365) });
    await send('patch', `/messages/${message.id}/schedule`, { triggerType: 'FIXED_DATE', scheduledFor: at(400) });
    await page.goto('/dashboard');
    await expect(recent(page).first()).toContainText('Schedule changed');
    // Five newest only, then the way to all of them.
    await expect(recent(page)).toHaveCount(5);
    await page.getByRole('link', { name: /View all activity/ }).click();
    await expect(page).toHaveURL(/\/settings\/activity$/);
    const today = page.getByRole('region', { name: 'Today' }).getByRole('listitem');
    // Signing up records nothing: exactly the six changes made above, newest first.
    await expect(today).toHaveCount(6);
    const order = (await today.allInnerTexts()).map((t) => t.split('\n')[0].trim());
    expect(order).toEqual([
      'Schedule changed',
      'Message scheduled',
      'Memory added',
      'Message updated',
      'Message created',
      'Person added',
    ]);
  } finally {
    await db(`DELETE FROM "User" WHERE email = $1`, [customer.email]);
  }
});
