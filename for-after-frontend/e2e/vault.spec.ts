import { expect, test, type Page } from '@playwright/test';
import { API } from './helpers';

// Customer A's session (from vault.setup.ts). Runs against the real local API,
// PostgreSQL, Redis and the development storage bucket.
test.use({ storageState: 'e2e/.auth/a.json' });

// 1×1 PNG and a tiny WAV header: the backend verifies size and type, not pixels.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const WAV = Buffer.concat([Buffer.from('RIFF$\0\0\0WAVEfmt '), Buffer.alloc(28)]);

/**
 * The development bucket has no CORS rule for localhost:3000 yet, so a real
 * browser PUT is refused. Playwright relays the same signed PUT (unchanged URL,
 * headers and bytes) to storage and adds the CORS headers to the answer.
 * Remove this once the bucket CORS rule is in place.
 */
async function relayStorage(page: Page) {
  await page.route(/backblazeb2\.com/, async (route) => {
    const cors = {
      'Access-Control-Allow-Origin': 'http://localhost:3000',
      'Access-Control-Allow-Methods': 'GET, PUT',
      'Access-Control-Allow-Headers': 'content-type',
    };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), ...cors } });
  });
}

async function addPerson(page: Page, firstName: string) {
  const res = await page.request.post(`${API}/recipients`, { data: { firstName, relationship: 'Daughter' } });
  expect(res.status()).toBe(201);
  return (await res.json()).id as string;
}

async function newDraft(page: Page, type: 'Written' | 'Photos' | 'Voice' | 'Mixed', person: string, text?: string) {
  await page.goto('/messages/new');
  await page.getByRole('checkbox', { name: new RegExp(person) }).check();
  await page.getByRole('radio', { name: new RegExp(`^${type}`) }).check();
  await page.getByLabel('Title').fill(`${type} message for ${person}`);
  if (text) await page.getByLabel(/^Message/).fill(text);
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page).toHaveURL(/\/messages\/[0-9a-f-]{36}$/);
  await expect(page.getByText('Draft', { exact: true })).toBeVisible();
}

async function upload(page: Page, button: 'Add a photo' | 'Upload audio', file: { name: string; mimeType: string; buffer: Buffer }) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: button }).click();
  await (await chooser).setFiles(file);
  await expect(page.getByText(file.mimeType.startsWith('image') ? 'Photo added' : 'Audio added')).toBeVisible();
}

async function schedule(page: Page, trigger: 'On a date you choose' | 'After my passing' | 'Some time after my passing') {
  await page.getByRole('radio', { name: new RegExp(trigger) }).check();
  if (trigger === 'On a date you choose') await page.getByLabel('Date').fill('2031-06-01');
  await page.getByRole('button', { name: 'Schedule message' }).click();
  await expect(page.getByText('Locked while scheduled')).toBeVisible();
  await expect(page.getByText('Scheduled', { exact: true })).toBeVisible();
}

test('People I Love: add → view → edit → remove', async ({ page }) => {
  await page.goto('/people');
  await page.getByRole('link', { name: 'Add someone you love' }).first().click();
  await page.getByLabel('First name').fill('Sofia');
  await page.getByLabel(/^Relationship/).fill('Daughter');
  await page.getByLabel(/^Birthday/).fill('2010-01-01');
  await page.getByRole('button', { name: 'Add person' }).click();

  await expect(page.getByRole('heading', { name: 'Sofia' })).toBeVisible();
  await expect(page.getByText('1 January 2010')).toBeVisible(); // date-only, no timezone shift
  await page.getByRole('link', { name: 'Edit' }).click();
  await page.getByLabel(/^Last name/).fill('Rossi');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('heading', { name: 'Sofia Rossi' })).toBeVisible();

  await page.getByRole('button', { name: 'Remove' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove' }).click();
  await expect(page).toHaveURL(/\/people$/);
  await expect(page.getByRole('link', { name: /Sofia Rossi/ })).toHaveCount(0);
});

test('Trusted Contacts: add → edit → remove', async ({ page }) => {
  await page.goto('/trusted-contacts/new');
  await page.getByLabel('First name').fill('David');
  await page.getByRole('button', { name: 'Add trusted contact' }).click();
  await expect(page.getByText('Provide an email or a mobile (or both).')).toBeVisible();
  await page.getByLabel(/^Email/).fill(`david-${Date.now()}@example.com`);
  await page.getByRole('button', { name: 'Add trusted contact' }).click();

  await expect(page).toHaveURL(/\/trusted-contacts$/);
  await page.getByRole('link', { name: /David/ }).first().click();
  await page.getByLabel(/^Relationship/).fill('Brother');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('link', { name: /David.*Brother/ }).first()).toBeVisible();

  await page.getByRole('link', { name: /David.*Brother/ }).first().click();
  await page.getByRole('button', { name: 'Remove' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove' }).click();
  await expect(page).toHaveURL(/\/trusted-contacts$/);
});

test('TEXT message: draft → edit → FIXED_DATE → locked → unschedule → editable', async ({ page }) => {
  await addPerson(page, 'Tess');
  await newDraft(page, 'Written', 'Tess', 'Dear Tess,');
  const url = page.url();

  await page.getByRole('link', { name: 'Edit' }).click();
  await page.getByLabel(/^Message/).fill('Dear Tess, happy birthday.');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Dear Tess, happy birthday.')).toBeVisible();

  await expect(page.getByText('Ready to schedule.')).toBeVisible();
  await schedule(page, 'On a date you choose');
  await expect(page.getByText(/On Sunday 1 June 2031, 9:00/)).toBeVisible();

  // Editing is refused with an explanation, never a silent unschedule.
  await page.goto(`${url}/edit`);
  await expect(page.getByRole('heading', { name: 'This message is scheduled' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save changes' })).toHaveCount(0);

  await page.goto(url);
  await page.getByRole('button', { name: 'Unschedule to edit' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Unschedule' }).click();
  await expect(page.getByText('Draft', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Edit' })).toBeVisible();
});

test('PHOTO, AUDIO and MIXED messages upload to storage, reach READY and schedule', async ({ page }) => {
  await relayStorage(page);
  await addPerson(page, 'Pia');

  await newDraft(page, 'Photos', 'Pia');
  await upload(page, 'Add a photo', { name: 'pixel.png', mimeType: 'image/png', buffer: PNG });
  await expect(page.getByRole('img', { name: 'pixel.png' })).toBeVisible(); // short-lived signed GET
  await schedule(page, 'After my passing');

  await newDraft(page, 'Voice', 'Pia');
  await upload(page, 'Upload audio', { name: 'hello.wav', mimeType: 'audio/wav', buffer: WAV });
  await schedule(page, 'Some time after my passing');
  await expect(page.getByText('30 days after the verified date of death')).toBeVisible();

  await newDraft(page, 'Mixed', 'Pia', 'A few words and a photo.');
  await upload(page, 'Add a photo', { name: 'pixel.png', mimeType: 'image/png', buffer: PNG });
  await schedule(page, 'On a date you choose');
});

test('invalid composition: a PHOTO message without a photo is refused with the API message', async ({ page }) => {
  await addPerson(page, 'Ivo');
  await newDraft(page, 'Photos', 'Ivo');
  await expect(page.getByText('Add at least one photo.')).toBeVisible();
  await page.getByRole('radio', { name: /After my passing/ }).check();
  await page.getByRole('button', { name: 'Schedule message' }).click();
  await expect(page.getByText('PHOTO messages require at least one ready photo.')).toBeVisible();
  await expect(page.getByText('Draft', { exact: true })).toBeVisible();
});

test('Memory Vault: create → filter → view → edit → photo + audio → delete', async ({ page }) => {
  await relayStorage(page);
  const title = `Road trip ${Date.now()}`;
  await page.goto('/memory-vault/new');
  await page.getByLabel('Title').fill(title);
  await page.getByRole('radio', { name: 'Travel' }).check();
  await page.getByLabel(/^The memory/).fill('Somewhere past Esperance.');
  await page.getByRole('button', { name: 'Save memory' }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();

  await page.goto('/memory-vault?category=TRAVEL');
  await expect(page.getByRole('link', { name: new RegExp(title) })).toBeVisible();
  await page.goto('/memory-vault?category=RECIPES');
  await expect(page.getByRole('link', { name: new RegExp(title) })).toHaveCount(0);

  await page.goto('/memory-vault?category=TRAVEL');
  await page.getByRole('link', { name: new RegExp(title) }).click();
  await page.getByRole('link', { name: 'Edit' }).click();
  await page.getByRole('radio', { name: 'Family' }).check();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Family', { exact: true })).toBeVisible();

  await upload(page, 'Add a photo', { name: 'pixel.png', mimeType: 'image/png', buffer: PNG });
  await upload(page, 'Upload audio', { name: 'hello.wav', mimeType: 'audio/wav', buffer: WAV });
  await page.getByRole('button', { name: 'Listen' }).click();
  await expect(page.getByLabel('Play hello.wav')).toBeVisible();

  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete memory' }).click();
  await expect(page).toHaveURL(/\/memory-vault$/);
});

for (const area of ['my-story', 'my-wishes'] as const) {
  test(`${area}: answer → edit → delete`, async ({ page }) => {
    await page.goto(`/${area}`);
    if (area === 'my-wishes') await expect(page.getByText(/It is not a will, legal document/)).toBeVisible();
    const first = page.getByRole('link', { name: /Write your answer|Continue writing/ }).first();
    await first.click();
    if (area === 'my-wishes') await expect(page.getByText(/It is not a will, legal document/)).toBeVisible();

    await page.getByLabel('Your answer').fill('First thoughts.');
    await page.getByRole('button', { name: 'Save answer' }).click();
    await expect(page).toHaveURL(new RegExp(`/${area}$`));
    await expect(page.getByText('First thoughts.')).toBeVisible();

    await page.getByRole('link', { name: /First thoughts\./ }).click();
    await page.getByLabel('Your answer').fill('Second thoughts, kept.');
    await page.getByRole('button', { name: 'Save answer' }).click();
    await expect(page.getByText('Second thoughts, kept.')).toBeVisible();

    await page.getByRole('link', { name: /Second thoughts, kept\./ }).click();
    await page.getByRole('button', { name: 'Delete answer' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete answer' }).click();
    await expect(page).toHaveURL(new RegExp(`/${area}$`));
    await expect(page.getByText('Second thoughts, kept.')).toHaveCount(0);
  });
}

test('Customer B cannot see Customer A’s vault: safe not-found everywhere', async ({ page, browser }) => {
  const recipientId = await addPerson(page, 'Private');
  const contact = await (await page.request.post(`${API}/trusted-contacts`, { data: { firstName: 'Secret', email: 's@example.com' } })).json();
  const message = await (
    await page.request.post(`${API}/messages`, { data: { title: 'Only for A', recipientIds: [recipientId] } })
  ).json();
  const memory = await (await page.request.post(`${API}/memory-vault`, { data: { title: 'A’s memory', category: 'OTHER' } })).json();

  const b = await browser.newContext({ storageState: 'e2e/.auth/b.json' });
  const pageB = await b.newPage();
  for (const [path, text] of [
    [`/people/${recipientId}`, 'We couldn’t find this person'],
    [`/trusted-contacts/${contact.id}/edit`, 'We couldn’t find this trusted contact'],
    [`/messages/${message.id}`, 'We couldn’t find this message'],
    [`/memory-vault/${memory.id}`, 'We couldn’t find this memory'],
  ]) {
    await pageB.goto(path);
    await expect(pageB.getByText(text)).toBeVisible();
  }
  await expect(pageB.getByText('Only for A')).toHaveCount(0);
  await b.close();
});
