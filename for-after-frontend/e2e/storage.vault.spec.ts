import type { Page } from '@playwright/test';
import { API, PNG } from './helpers';
import { expect, test } from './imagekit';

// Storage Manager against the real local API, PostgreSQL and the development
// ImageKit account (tiny synthetic PNGs, deleted afterwards by the imagekit
// fixture). Needs an API started with STORAGE_LIMIT_BYTES = 2 × the PNG size,
// so two pixels fill the quota; skipped otherwise.
test.use({ storageState: 'e2e/.auth/a.json' });

async function addPhoto(page: Page) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Add a photo' }).click();
  await (await chooser).setFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: PNG });
}

test('Storage Manager: Settings → Manage storage → filter → open → delete; full storage still allows deleting', async ({
  page,
}) => {
  const usage = async () => (await page.request.get(`${API}/users/me/storage`)).json();
  const before = await usage();
  test.skip(before.limitBytes !== PNG.length * 2, 'Start the API with STORAGE_LIMIT_BYTES = 2 × the test PNG size.');
  const title = `Storage ${Date.now()}`;
  const memory = await (await page.request.post(`${API}/memory-vault`, { data: { title, category: 'OTHER' } })).json();
  try {
    await page.goto(`/memory-vault/${memory.id}`);
    for (let i = 0; i < 2; i++) {
      await addPhoto(page);
      await expect(page.getByRole('img', { name: 'pixel.png' })).toHaveCount(i + 1);
    }
    expect(await usage()).toMatchObject({ level: 'FULL', remainingBytes: 0 });

    // Full: new uploads are paused…
    await addPhoto(page);
    await expect(page.getByRole('alert').filter({ hasText: 'Upload failed' })).toContainText('Your storage is full.');

    // …but Settings leads to the Storage Manager, with the same numbers.
    await page.goto('/settings');
    const card = page.getByRole('region', { name: 'Storage', exact: true });
    await expect(card.getByText(/storage is full/)).toBeVisible();
    const amount = await card.getByText(/ used$/).textContent();
    await card.getByRole('link', { name: 'Manage storage' }).click();
    await expect(page).toHaveURL(/\/settings\/storage$/);
    await expect(page.getByText(/ of .* used$/).first()).toHaveText(amount!);
    await expect(page.getByText(/new uploads are paused until you free up space/)).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Sort' })).toHaveValue('size_desc');

    // Photos only, then open where the file lives and come back.
    await page.getByRole('navigation', { name: 'Filter by type' }).getByRole('link', { name: 'Photos' }).click();
    await expect(page).toHaveURL(/type=PHOTO/);
    const files = page.getByRole('region', { name: 'Your files' }).getByRole('listitem');
    await expect(files).toHaveCount(2);
    await files.first().getByRole('link', { name: `View: ${title}` }).click();
    await expect(page).toHaveURL(new RegExp(`/memory-vault/${memory.id}$`));
    await page.goBack();
    await expect(files).toHaveCount(2);

    // Delete one while full: confirmed, gone, usage drops below the limit.
    await files.first().getByRole('button', { name: `Delete: ${title}` }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete this photo?' });
    await expect(dialog).toContainText('from your Memory Vault');
    await dialog.getByRole('button', { name: 'Delete photo' }).click();
    await expect(files).toHaveCount(1);
    await expect(page.getByText(/new uploads are paused/)).toHaveCount(0);
    expect(await usage()).toMatchObject({ usedBytes: PNG.length, percentage: 50 });

    // Uploads work again.
    await page.goto(`/memory-vault/${memory.id}`);
    await addPhoto(page);
    await expect(page.getByRole('img', { name: 'pixel.png' })).toHaveCount(2);
  } finally {
    await page.request.delete(`${API}/memory-vault/${memory.id}`);
  }
});

test('Storage Manager: a scheduled message’s file offers Open message, never Delete', async ({ page }) => {
  const usage = async () => (await page.request.get(`${API}/users/me/storage`)).json();
  test.skip((await usage()).limitBytes !== PNG.length * 2, 'Start the API with STORAGE_LIMIT_BYTES = 2 × the test PNG size.');
  const person = await (await page.request.post(`${API}/recipients`, { data: { firstName: 'Nora' } })).json();
  const message = await (
    await page.request.post(`${API}/messages`, {
      data: { title: `Locked ${Date.now()}`, contentType: 'PHOTO', recipientIds: [person.id] },
    })
  ).json();
  try {
    await page.goto(`/messages/${message.id}`);
    await addPhoto(page);
    await expect(page.getByRole('img', { name: 'pixel.png' })).toBeVisible();
    expect((await page.request.post(`${API}/messages/${message.id}/schedule`, { data: { triggerType: 'ON_DEATH' } })).status()).toBe(201);

    await page.goto('/settings/storage?source=MESSAGE');
    const row = page.getByRole('region', { name: 'Your files' }).getByRole('listitem').filter({ hasText: message.title });
    await expect(row).toContainText('This file belongs to a scheduled message.');
    await expect(row.getByRole('button', { name: /Delete/ })).toHaveCount(0);
    await row.getByRole('link', { name: `Open message: ${message.title}` }).click();
    await expect(page).toHaveURL(new RegExp(`/messages/${message.id}$`));
  } finally {
    await page.request.delete(`${API}/messages/${message.id}/schedule`);
    await page.request.delete(`${API}/messages/${message.id}`);
    await page.request.delete(`${API}/recipients/${person.id}`);
  }
});
