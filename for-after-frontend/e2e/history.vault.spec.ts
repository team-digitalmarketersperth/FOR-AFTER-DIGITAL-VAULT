import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { API } from './helpers';

// Draft recovery (server-side autosave) and Message version history against
// the real local API and PostgreSQL. Synthetic content only; recipients have
// no email, and the one scheduled message is years away, so nothing is sent
// or released.
test.use({ storageState: 'e2e/.auth/a.json' });

async function newDraft(page: Page, textContent: string) {
  const person = await page.request.post(`${API}/recipients`, { data: { firstName: 'Iris' } });
  expect(person.status()).toBe(201);
  const res = await page.request.post(`${API}/messages`, {
    data: { title: `History ${Date.now()}`, contentType: 'TEXT', textContent, recipientIds: [(await person.json()).id] },
  });
  expect(res.status()).toBe(201);
  return (await res.json()).id as string;
}

// "The browser closed": a new tab in the same session, without beforeunload.
async function reopen(context: BrowserContext, page: Page, url: string) {
  await page.close();
  const next = await context.newPage();
  await next.goto(url);
  return next;
}

const messageText = (page: Page) => page.getByRole('textbox', { name: /^Message/ });

test('browser recovery: unsaved message text comes back after closing, until it is saved', async ({ page, context }) => {
  const id = await newDraft(page, 'Saved synthetic words.');
  await page.goto(`/messages/${id}/edit`);
  await messageText(page).fill('Saved synthetic words. And more unsaved ones.');
  await expect(page.getByText('Autosaved just now')).toBeVisible();
  // Kept server-side only: never in browser storage.
  const browserStorage = await page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }]));
  expect(browserStorage).not.toContain('unsaved ones');
  // The message itself is unchanged: autosave is not Save.
  expect((await (await page.request.get(`${API}/messages/${id}`)).json()).textContent).toBe('Saved synthetic words.');

  page = await reopen(context, page, `/messages/${id}/edit`);
  await expect(page.getByRole('heading', { name: 'Unsaved changes found' })).toBeVisible();
  await expect(messageText(page)).toHaveValue('Saved synthetic words.');
  await page.getByRole('button', { name: 'Restore changes' }).click();
  await expect(messageText(page)).toHaveValue('Saved synthetic words. And more unsaved ones.');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page).toHaveURL(new RegExp(`/messages/${id}$`));
  await expect(page.getByText('And more unsaved ones.')).toBeVisible();

  await page.goto(`/messages/${id}/edit`);
  await expect(messageText(page)).toHaveValue('Saved synthetic words. And more unsaved ones.');
  await expect(page.getByRole('heading', { name: 'Unsaved changes found' })).toHaveCount(0);
});

test('version history: restore version A; version B stays in history', async ({ page }) => {
  const id = await newDraft(page, 'Version A synthetic words.');
  await page.goto(`/messages/${id}/edit`);
  await messageText(page).fill('Version B synthetic words.');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page).toHaveURL(new RegExp(`/messages/${id}$`));

  await page.getByRole('button', { name: 'Version history' }).click();
  const list = page.getByRole('list', { name: 'Saved versions' });
  await expect(list.getByRole('listitem')).toHaveCount(2);
  await expect(list.getByRole('listitem').first()).toContainText(/Version 2.*Current/);
  await list.getByRole('button', { name: /Version 1/ }).click();
  await expect(page.getByRole('dialog').getByText('Version A synthetic words.')).toBeVisible();
  await page.getByRole('button', { name: 'Restore this version' }).click();
  await page.getByRole('dialog', { name: 'Restore this version?' }).getByRole('button', { name: 'Restore version' }).click();
  await expect(list.getByRole('listitem')).toHaveCount(3);
  await expect(list.getByRole('listitem').first()).toContainText(/Version 3.*Current.*Restored an earlier version/);
  await list.getByRole('button', { name: /Version 2/ }).click();
  await expect(page.getByRole('dialog').getByText('Version B synthetic words.')).toBeVisible();
  await page.keyboard.press('Escape');

  expect((await (await page.request.get(`${API}/messages/${id}`)).json()).textContent).toBe('Version A synthetic words.');
  await expect(page.getByRole('region', { name: 'Message' })).toContainText('Version A synthetic words.');
});

test('scheduled message: history is visible, restore is disabled, the schedule is untouched', async ({ page }) => {
  const id = await newDraft(page, 'Before.');
  const edit = await page.request.patch(`${API}/messages/${id}`, { data: { textContent: 'Scheduled words.' } });
  expect(edit.ok()).toBe(true);
  const res = await page.request.post(`${API}/messages/${id}/schedule`, {
    data: { triggerType: 'FIXED_DATE', scheduledFor: '2035-12-25T09:00:00+08:00', afterDeathDays: null },
  });
  expect(res.status()).toBe(201);
  const before = await (await page.request.get(`${API}/messages/${id}/schedule`)).json();

  await page.goto(`/messages/${id}`);
  await page.getByRole('button', { name: 'Version history' }).click();
  await page.getByRole('list', { name: 'Saved versions' }).getByRole('button', { name: /Version 1/ }).click();
  await expect(page.getByRole('button', { name: 'Restore this version' })).toBeDisabled();
  await expect(page.getByText('This message is scheduled. Unschedule it before restoring an earlier version.')).toBeVisible();

  const after = await (await page.request.get(`${API}/messages/${id}/schedule`)).json();
  expect(after).toEqual(before);
  expect((await (await page.request.get(`${API}/messages/${id}`)).json()).status).toBe('SCHEDULED');
});

const answer = (page: Page) => page.getByLabel('Your answer');

test('My Story: unsaved text is autosaved and recovered after closing', async ({ page, context }) => {
  const url = '/my-story/milestones.favourite-day';
  await page.goto(url);
  await answer(page).fill('A synthetic favourite day by the sea.');
  await expect(page.getByText('Autosaved just now')).toBeVisible();
  page = await reopen(context, page, url);
  await page.getByRole('button', { name: 'Restore changes' }).click();
  await expect(answer(page)).toHaveValue('A synthetic favourite day by the sea.');
  await page.getByRole('button', { name: 'Save answer' }).click();
  await expect(page).toHaveURL(/\/my-story$/);
});

test('My Wishes: unsaved text is autosaved and recovered after closing', async ({ page, context }) => {
  const url = '/my-wishes/ceremony.style';
  await page.goto(url);
  await answer(page).fill('A small synthetic gathering outdoors.');
  await expect(page.getByText('Autosaved just now')).toBeVisible();
  page = await reopen(context, page, url);
  await page.getByRole('button', { name: 'Restore changes' }).click();
  await expect(answer(page)).toHaveValue('A small synthetic gathering outdoors.');
  await page.getByRole('button', { name: 'Save answer' }).click();
  await expect(page).toHaveURL(/\/my-wishes$/);
});
