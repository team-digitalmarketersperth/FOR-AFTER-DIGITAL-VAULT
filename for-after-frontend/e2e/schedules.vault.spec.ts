import { expect, test, type Page } from '@playwright/test';
import { API } from './helpers';

// Phase 16 schedule picker against the real local API, PostgreSQL, Redis and
// BullMQ: NOW releases through the worker; BIRTHDAY, ANNIVERSARY,
// CUSTOM_EVENT and ANNUAL_AFTER_DEATH are scheduled and described. Recipients
// have no email, so no release email is ever sent. Waiting for real dates is
// covered by the backend e2e suite (test clock), not here.
test.use({ storageState: 'e2e/.auth/a.json' });

async function draftFor(page: Page, people: { firstName: string; birthday?: string }[]) {
  const recipientIds: string[] = [];
  for (const p of people) {
    const res = await page.request.post(`${API}/recipients`, { data: p });
    expect(res.status()).toBe(201);
    recipientIds.push((await res.json()).id);
  }
  const res = await page.request.post(`${API}/messages`, {
    data: { title: `Phase 16 ${Date.now()}`, contentType: 'TEXT', textContent: 'Fictional text.', recipientIds },
  });
  expect(res.status()).toBe(201);
  const id = (await res.json()).id as string;
  await page.goto(`/messages/${id}`);
  await expect(page.getByText('Ready to schedule.')).toBeVisible();
  return id;
}

const scheduled = async (page: Page) => {
  await page.getByRole('button', { name: 'Schedule message' }).click();
  await expect(page.getByText('Scheduled', { exact: true })).toBeVisible();
};

test('NOW: “Right away” schedules, then the worker releases it', async ({ page }) => {
  await draftFor(page, [{ firstName: 'Nora' }]);
  await page.getByRole('radio', { name: /Right away/ }).check();
  await page.getByRole('button', { name: 'Schedule message' }).click();
  await expect(async () => {
    await page.reload();
    await expect(page.getByText('Released', { exact: true })).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await expect(page.getByText(/This message has been released \(as soon as it was scheduled\)/)).toBeVisible();
});

test('BIRTHDAY: a missing birthday is named; with birthdays it schedules per recipient', async ({ page }) => {
  const missing = await draftFor(page, [{ firstName: 'Una' }]);
  await page.getByRole('radio', { name: /On their birthday/ }).check();
  await expect(page.getByText('Una doesn’t have a birthday saved yet.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Schedule message' }).click();
  await expect(page.getByText(/needs a birthday for a birthday release/)).toBeVisible();
  expect((await page.request.get(`${API}/messages/${missing}`)).ok()).toBe(true);

  const id = await draftFor(page, [
    { firstName: 'Amy', birthday: '1990-03-10' },
    { firstName: 'Bob', birthday: '1988-02-29' },
  ]);
  await page.getByRole('radio', { name: /On their birthday/ }).check();
  await expect(page.getByText(/shared on 28 February in other years/)).toBeVisible();
  await page.getByLabel('Time zone', { exact: true }).selectOption('Australia/Perth');
  await page.getByLabel('Time', { exact: true }).fill('08:15');
  await scheduled(page);
  await expect(page.getByText('Every year on each recipient’s birthday at 8:15 am (Australia/Perth time)')).toBeVisible();
  await expect(page.getByText(/Repeats every year/)).toBeVisible();
  const schedule = await (await page.request.get(`${API}/messages/${id}/schedule`)).json();
  expect(schedule).toMatchObject({ triggerType: 'BIRTHDAY', timezone: 'Australia/Perth', localTime: '08:15', releasedRecipientCount: 0 });
});

test('ANNIVERSARY: 29 February, time and zone; change timing; unschedule', async ({ page }) => {
  const id = await draftFor(page, [{ firstName: 'Elsa' }]);
  await page.getByRole('radio', { name: /Every year on a date/ }).check();
  await page.getByLabel('Month', { exact: true }).selectOption('2');
  await page.getByLabel('Day', { exact: true }).selectOption('30');
  await page.getByRole('button', { name: 'Schedule message' }).click();
  await expect(page.getByText('Choose a day that exists in that month.')).toBeVisible();
  await page.getByLabel('Day', { exact: true }).selectOption('29');
  await page.getByLabel('Time zone', { exact: true }).selectOption('America/New_York');
  await scheduled(page);
  await expect(page.getByText(/Every year on 29 February at 9:00 am \(America\/New York time\)/)).toBeVisible();

  await page.getByRole('button', { name: 'Change timing' }).click();
  await page.getByLabel('Day', { exact: true }).selectOption('28');
  await page.getByRole('button', { name: 'Save timing' }).click();
  await expect(page.getByText(/Every year on 28 February/)).toBeVisible();

  await page.getByRole('button', { name: 'Unschedule to edit' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Unschedule' }).click();
  await expect(page.getByText('Draft', { exact: true })).toBeVisible();
  expect((await page.request.get(`${API}/messages/${id}/schedule`)).status()).toBe(404);
});

test('CUSTOM_EVENT: named one-time occasion in its own zone', async ({ page }) => {
  const id = await draftFor(page, [{ firstName: 'Gus' }]);
  await page.getByRole('radio', { name: /On a special occasion/ }).check();
  await expect(page.getByText('Shared once, on this day. It doesn’t repeat.')).toBeVisible();
  await page.getByLabel('What’s the occasion?').fill('<b>Party</b>');
  await page.getByLabel('Date', { exact: true }).fill('2031-06-01');
  await page.getByRole('button', { name: 'Schedule message' }).click();
  await expect(page.getByText('Please leave out < and >.')).toBeVisible();
  await page.getByLabel('What’s the occasion?').fill('Mia’s graduation');
  await page.getByLabel('Time', { exact: true }).fill('18:30');
  await page.getByLabel('Time zone', { exact: true }).selectOption('Asia/Tokyo');
  await scheduled(page);
  await expect(page.getByText('Mia’s graduation: 1 June 2031 at 6:30 pm (Asia/Tokyo time)')).toBeVisible();
  const schedule = await (await page.request.get(`${API}/messages/${id}/schedule`)).json();
  // 18:30 in Tokyo (UTC+9) is 09:30 UTC.
  expect(schedule).toMatchObject({ triggerType: 'CUSTOM_EVENT', scheduledFor: '2031-06-01T09:30:00.000Z' });
});

test('ANNUAL_AFTER_DEATH: explains verification; nothing is released by scheduling', async ({ page }) => {
  const id = await draftFor(page, [{ firstName: 'Ivy' }]);
  await page.getByRole('radio', { name: /Every year after my passing/ }).check();
  await expect(page.getByText(/Nothing is shared until your passing has been formally verified/)).toBeVisible();
  await expect(page.getByText(/A report from a trusted contact is never enough on its own/)).toBeVisible();
  await scheduled(page);
  await expect(page.getByText(/Every year on the anniversary of the verified date of death/)).toBeVisible();
  const schedule = await (await page.request.get(`${API}/messages/${id}/schedule`)).json();
  expect(schedule).toMatchObject({ triggerType: 'ANNUAL_AFTER_DEATH', releasedRecipientCount: 0 });
});
