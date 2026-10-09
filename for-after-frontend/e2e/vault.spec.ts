import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, messageMediaFileIds, test } from './imagekit';
import { API, PNG, WAV } from './helpers';

// Customer A's session (from vault.setup.ts). Runs against the real local API,
// PostgreSQL, Redis and the development ImageKit account (Phase 12). Uploads are
// real browser POSTs to ImageKit with the API's signed upload token; only
// synthetic files are used, and the backend verifies every one.
test.use({ storageState: 'e2e/.auth/a.json' });

// Relative to the frontend folder, like the storageState paths.
const WEBM = readFileSync('e2e/fixtures/synthetic-video.webm');

async function addPerson(page: Page, firstName: string) {
  const res = await page.request.post(`${API}/recipients`, { data: { firstName, relationship: 'Daughter' } });
  expect(res.status()).toBe(201);
  return (await res.json()).id as string;
}

async function newDraft(page: Page, type: 'Written' | 'Photos' | 'Voice' | 'Video' | 'Mixed', person: string, text?: string) {
  await page.goto('/messages/new');
  await page.getByRole('checkbox', { name: new RegExp(person) }).check();
  await page.getByRole('radio', { name: new RegExp(`^${type}`) }).check();
  await page.getByLabel('Title').fill(`${type} message for ${person}`);
  if (text) await page.getByRole('textbox', { name: /^Message/ }).fill(text);
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page).toHaveURL(/\/messages\/[0-9a-f-]{36}$/);
  await expect(page.getByText('Draft', { exact: true })).toBeVisible();
}

async function upload(
  page: Page,
  button: 'Add a photo' | 'Upload audio' | 'Add a video',
  file: { name: string; mimeType: string; buffer: Buffer },
) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: button }).click();
  await (await chooser).setFiles(file);
  const added = { image: 'Photo added', audio: 'Audio added', video: 'Video added' }[file.mimeType.split('/')[0]];
  await expect(page.getByText(added!)).toBeVisible();
}

async function schedule(page: Page, trigger: 'On a date you choose' | 'After my passing' | 'Some time after my passing') {
  await page.getByRole('radio', { name: new RegExp(trigger) }).check();
  if (trigger === 'On a date you choose') await page.getByLabel('Date', { exact: true }).fill('2031-06-01');
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
  // The detail page also has a region named "Message": wait for the form, then target its textbox.
  await expect(page).toHaveURL(/\/edit$/);
  await page.getByRole('textbox', { name: /^Message/ }).fill('Dear Tess, happy birthday.');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Dear Tess, happy birthday.')).toBeVisible();

  await expect(page.getByText('Ready to schedule.')).toBeVisible();
  await schedule(page, 'On a date you choose');
  // Intl joins date and time with ", " or " at " depending on the browser's ICU version.
  await expect(page.getByText(/On Sunday 1 June 2031(,| at) 9:00/)).toBeVisible();

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

test('PHOTO, AUDIO and MIXED messages upload to ImageKit, reach READY and schedule', async ({ page }) => {
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

test('a failed upload stays unfinished and blocks scheduling; retry and the browser recorder reach READY', async ({ page }) => {
  await addPerson(page, 'Rory');
  await newDraft(page, 'Voice', 'Rory');
  const id = page.url().split('/').pop();
  const media = async () => (await (await page.request.get(`${API}/messages/${id}/media`)).json()) as { status: string }[];

  // The upload to ImageKit fails (as with a dropped connection): the asset never looks READY.
  await page.route(/upload\.imagekit\.io/, (route) => (route.request().method() === 'POST' ? route.abort() : route.fallback()));
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Upload audio' }).click();
  await (await chooser).setFiles({ name: 'hello.wav', mimeType: 'audio/wav', buffer: WAV });
  const failed = page.getByRole('alert').filter({ hasText: 'Upload failed' });
  await expect(failed).toBeVisible();
  expect((await media()).map((m) => m.status)).toEqual(['PENDING_UPLOAD']);
  expect((await page.request.post(`${API}/messages/${id}/schedule`, { data: { triggerType: 'ON_DEATH' } })).status()).toBe(409);
  await page.unroute(/upload\.imagekit\.io/);
  await failed.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByText('Audio added')).toBeVisible();

  // The unfinished attempt is shown as such and can be removed; the Draft is untouched.
  await page.reload();
  await page
    .getByRole('listitem')
    .filter({ hasText: 'Upload not finished' })
    .getByRole('button', { name: 'Remove hello.wav' })
    .click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove' }).click();
  await expect.poll(async () => (await media()).map((m) => m.status)).toEqual(['READY']);

  // Browser recording (Chromium's fake microphone, see playwright.config.ts).
  await page.getByRole('button', { name: 'Record your voice' }).click();
  await expect(page.getByText(/Recording \d/)).toBeVisible();
  await page.getByRole('button', { name: 'Stop' }).click();
  await page.getByRole('button', { name: 'Use this recording' }).click();
  await expect.poll(async () => (await media()).map((m) => m.status)).toEqual(['READY', 'READY']);
  await schedule(page, 'After my passing');
});

test('VIDEO message: upload to ImageKit, READY, signed preview, schedule (Phase 12)', async ({ page }) => {
  await addPerson(page, 'Vera');
  await newDraft(page, 'Video', 'Vera');
  await expect(page.getByText('Add at least one video.')).toBeVisible();
  await upload(page, 'Add a video', { name: 'hello.webm', mimeType: 'video/webm', buffer: WEBM });
  await page.getByRole('button', { name: 'Watch' }).click();
  // A short-lived signed URL of the private original, never a public link.
  const player = page.getByLabel('Play hello.webm');
  await expect(player).toHaveAttribute('src', /ik-s=.+/);
  await expect.poll(() => player.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThan(0);
  await schedule(page, 'After my passing');
});

test('VIDEO recorder: camera preview → record → play back → use → READY signed preview → schedule (Phase 12A)', async ({ page }) => {
  await addPerson(page, 'Rhea');
  await newDraft(page, 'Video', 'Rhea');
  await page.getByRole('button', { name: 'Record a video' }).click();
  await expect(page.getByLabel('Camera preview')).toBeVisible(); // Chromium's fake camera
  await page.getByRole('button', { name: 'Start recording' }).click();
  await expect(page.getByText(/Recording 0:0[2-9]/)).toBeVisible();
  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(page.getByLabel('Your recording')).toHaveAttribute('src', /^blob:/);
  await page.getByRole('button', { name: 'Use this recording' }).click();
  await expect(page.getByText('Video added')).toBeVisible();
  await expect(page.getByLabel('Your recording')).toHaveCount(0);
  await page.getByRole('button', { name: 'Watch' }).click();
  const player = page.getByLabel(/^Play recording-.*\.(webm|mp4)$/);
  await expect(player).toHaveAttribute('src', /ik-s=.+/); // signed provider URL, not the local blob
  await expect.poll(() => player.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThan(0);
  await schedule(page, 'After my passing');
});

test('VIDEO recorder: Discard uploads nothing; denied camera explains and file upload stays usable', async ({ page }) => {
  await addPerson(page, 'Dana');
  await newDraft(page, 'Video', 'Dana');
  const uploads: string[] = [];
  page.on('request', (r) => r.url().includes('/media/upload-url') && uploads.push(r.url()));
  await page.getByRole('button', { name: 'Record a video' }).click();
  await page.getByRole('button', { name: 'Start recording' }).click();
  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(page.getByLabel('Your recording')).toBeVisible();
  await page.getByRole('button', { name: 'Discard' }).click();
  await expect(page.getByLabel('Your recording')).toHaveCount(0);
  expect(uploads).toEqual([]);

  // Denied: the fake-UI flag auto-accepts prompts, so the browser's refusal is simulated.
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('denied', 'NotAllowedError'));
  });
  await page.reload();
  await page.getByRole('button', { name: 'Record a video' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Access to your camera and microphone was not allowed' })).toBeVisible();
  await upload(page, 'Add a video', { name: 'hello.webm', mimeType: 'video/webm', buffer: WEBM });
  expect(uploads).toHaveLength(1);
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

// Phase 13A. 25 synthetic memories are made through the API (so a run-unique
// search spans two pages); one through the form with tags. All are deleted at
// the end. Tag names are fixed, so repeated runs reuse the same tags.
test('Memory Vault: tags → search → category + tag filters → paginate → edit tags → delete', async ({ page }) => {
  const run = `Pw${Date.now()}`;
  const ids: string[] = [];
  const results = (n: number) => page.getByText(new RegExp(`${n} results$`));
  try {
    for (let i = 0; i < 25; i++) {
      const res = await page.request.post(`${API}/memory-vault`, {
        data: { title: `${run} filler ${i}`, category: 'OTHER', tags: ['Family'] },
      });
      expect(res.status()).toBe(201);
      ids.push((await res.json()).id);
    }

    const title = `${run} Esperance road trip`;
    await page.goto('/memory-vault/new');
    await page.getByLabel('Title').fill(title);
    await page.getByRole('radio', { name: 'Travel' }).check();
    await page.getByLabel(/^The memory/).fill('Somewhere past Esperance.');
    await page.getByLabel(/^Tags/).fill('Road trips');
    await page.getByLabel(/^Tags/).press('Enter');
    await page.getByLabel(/^Tags/).fill('family');
    await page.getByRole('button', { name: 'Add tag' }).click();
    // "family" reuses the Customer's existing "Family".
    await expect(page.getByRole('list', { name: 'Selected tags' }).getByRole('listitem')).toHaveText(['Road trips', 'Family']);
    await page.getByRole('button', { name: 'Save memory' }).click();
    await expect(page.getByRole('heading', { name: title })).toBeVisible();
    ids.push(page.url().split('/').pop()!);
    await expect(page.getByRole('list', { name: 'Tags' }).getByRole('listitem')).toHaveText(['Family', 'Road trips']);

    // Search (server-side, after a pause in typing) → 26 results over 2 pages.
    await page.goto('/memory-vault');
    await page.getByLabel('Search').fill(run.toLowerCase());
    await expect(page).toHaveURL(new RegExp(`search=${run.toLowerCase()}`));
    await expect(page.getByText('Page 1 of 2 · 26 results')).toBeVisible();
    await expect(page.getByRole('link', { name: new RegExp(title) })).toBeVisible();
    await page.getByRole('link', { name: 'Next' }).click();
    await expect(page.getByText('Page 2 of 2 · 26 results')).toBeVisible();
    await expect(page.getByRole('link', { name: new RegExp(`${run} filler 0`) })).toBeVisible();
    await expect(page.getByRole('link', { name: new RegExp(title) })).toHaveCount(0);

    // Category keeps the search and goes back to page 1.
    await page.getByRole('link', { name: 'Travel', exact: true }).click();
    await expect(page).toHaveURL(/category=TRAVEL/);
    await expect(page).not.toHaveURL(/page=/);
    await expect(page.getByText('1 result', { exact: true })).toBeVisible();
    // Tag + category + search.
    await page.getByLabel('Tag', { exact: true }).selectOption({ label: 'Road trips' });
    await expect(page).toHaveURL(/tag=Road\+trips/);
    await expect(page.getByText('1 result', { exact: true })).toBeVisible();
    // Tag + search across all categories.
    await page.getByLabel('Tag', { exact: true }).selectOption({ label: 'Family' });
    await expect(page).toHaveURL(/tag=Family/);
    await page.getByRole('link', { name: 'All', exact: true }).click();
    await expect(page).not.toHaveURL(/category=/);
    await expect(results(26)).toBeVisible();

    // Open the result and replace its tags.
    await page.goto(`/memory-vault?search=${run}&tag=Road%20trips`);
    await page.getByRole('link', { name: new RegExp(title) }).click();
    await page.getByRole('link', { name: 'Edit' }).click();
    await page.getByRole('button', { name: 'Remove tag Road trips' }).click();
    await page.getByLabel(/^Tags/).fill('Childhood');
    await page.getByLabel(/^Tags/).press('Enter');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('list', { name: 'Tags' }).getByRole('listitem')).toHaveText(['Childhood', 'Family']);
    await page.goto(`/memory-vault?search=${run}&tag=Road%20trips`);
    await expect(page.getByText('No memories match your filters')).toBeVisible();

    // Delete it: the list updates.
    await page.goto(`/memory-vault/${ids.at(-1)}`);
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete memory' }).click();
    await expect(page).toHaveURL(/\/memory-vault$/);
    await page.goto(`/memory-vault?search=${run}`);
    await expect(page.getByText('25 results', { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: new RegExp(title) })).toHaveCount(0);
  } finally {
    for (const id of ids) await page.request.delete(`${API}/memory-vault/${id}`);
  }
});

// Phase 12C. Needs the API started with a small STORAGE_LIMIT_BYTES (e.g.
// 50000) so the limit is reached with synthetic bytes; skipped otherwise.
test('Storage: settings meter, an upload over the remaining space is refused, existing files stay', async ({ page }) => {
  const usage = async () => (await page.request.get(`${API}/users/me/storage`)).json();
  const before = await usage();
  test.skip(before.limitBytes > 5_000_000, 'Start the API with a small STORAGE_LIMIT_BYTES to run the quota check.');
  const memory = await (await page.request.post(`${API}/memory-vault`, { data: { title: `Quota ${Date.now()}`, category: 'OTHER' } })).json();
  try {
    await page.goto(`/memory-vault/${memory.id}`);
    await upload(page, 'Add a photo', { name: 'pixel.png', mimeType: 'image/png', buffer: PNG });

    // Larger than what is left: refused by the API before any upload.
    const { remainingBytes } = await usage();
    const big = Buffer.concat([PNG, Buffer.alloc(remainingBytes + 1 - PNG.length)]);
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Add a photo' }).click();
    await (await chooser).setFiles({ name: 'big.png', mimeType: 'image/png', buffer: big });
    await expect(page.getByRole('alert').filter({ hasText: 'Upload failed' })).toContainText('This file is larger than your remaining storage.');
    await expect(page.getByRole('img', { name: 'pixel.png' })).toBeVisible();

    await page.goto('/settings');
    const meter = page.getByRole('progressbar', { name: 'Storage used' });
    await expect(meter).toBeVisible();
    expect(Number(await meter.getAttribute('aria-valuenow'))).toBe((await usage()).percentage);
  } finally {
    await page.request.delete(`${API}/memory-vault/${memory.id}`);
  }
});

for (const area of ['my-story', 'my-wishes'] as const) {
  test(`${area}: answer → edit → delete`, async ({ page }) => {
    await page.goto(`/${area}`);
    if (area === 'my-wishes') {
      // Phase 15A: the API's notice, acknowledged once per version with an unticked box.
      await expect(page.getByText(/It is not a will, legal document/)).toBeVisible();
      const box = page.getByRole('checkbox', { name: 'I have read this notice.' });
      await expect(box).not.toBeChecked();
      await expect(page.getByRole('button', { name: 'Continue' })).toBeDisabled();
      await box.check();
      await page.getByRole('button', { name: 'Continue' }).click();
      await expect(box).toHaveCount(0);
      // Same version after a reload: not asked again.
      await page.reload();
      await expect(page.getByText(/It is not a will, legal document/)).toBeVisible();
      await expect(page.getByRole('checkbox', { name: 'I have read this notice.' })).toHaveCount(0);
    }
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

// Phase 15B (approved policy), scenarios A + B. A wish with words, a photo, a
// recording and a video (real browser uploads to ImageKit, verified, scanned),
// kept across a reload; then a separate message made from chosen parts, with
// a person and "After my passing" timing in the normal message page. Nothing
// is released here (scenario C, portals.spec.ts, covers the verified death).
test('My Wishes: words + photo/audio/video → reload → create message for loved ones → person → ON_DEATH', async ({
  page,
  imagekitFiles,
}) => {
  test.setTimeout(4 * 60_000);
  const KEY = 'music-and-readings.readings';
  const run = Date.now();
  const text = `Please read something by the sea. ${run}`;
  expect((await page.request.post(`${API}/my-wishes/disclaimer/acknowledgement`, { data: { version: 1 } })).status()).toBe(200);
  await addPerson(page, 'Wren');
  let messageId = '';
  try {
    await page.goto(`/my-wishes/${KEY}`);
    await page.getByLabel('Your answer').fill(text);
    await page.getByRole('button', { name: 'Save answer' }).click();
    await expect(page).toHaveURL(/\/my-wishes$/);
    await page.goto(`/my-wishes/${KEY}`);
    await expect(page.getByRole('heading', { name: 'Add something personal' })).toBeVisible();
    await upload(page, 'Add a photo', { name: 'shore.png', mimeType: 'image/png', buffer: PNG });
    await upload(page, 'Upload audio', { name: 'waves.wav', mimeType: 'audio/wav', buffer: WAV });
    await upload(page, 'Add a video', { name: 'tide.webm', mimeType: 'video/webm', buffer: WEBM });

    // Reload: words and files are kept; previews are short-lived signed URLs.
    await page.reload();
    await expect(page.getByLabel('Your answer')).toHaveValue(text);
    await expect(page.getByRole('img', { name: 'shore.png' })).toBeVisible();
    await expect(page.getByText('waves.wav')).toBeVisible();
    await expect(page.getByText('tide.webm')).toBeVisible();
    await expect(page.getByText(/Your wish stays private\. This creates a separate message for the people you choose/)).toBeVisible();

    await page.getByRole('link', { name: 'Create message for loved ones' }).click();
    await expect(page.getByText('Your wish stays private. This creates a separate message for the people you choose.')).toBeVisible();
    await page.getByRole('checkbox', { name: /Wren/ }).first().check();
    await page.getByRole('radio', { name: /Mixed/ }).check();
    await page.getByLabel('Message title').fill(`For Wren ${run}`);
    const content = page.getByRole('group', { name: 'Wish content' });
    await expect(content.getByRole('checkbox', { name: 'The wish’s written text' })).toBeChecked();
    for (const name of [/shore\.png/, /waves\.wav/, /tide\.webm/]) await content.getByRole('checkbox', { name }).check();
    await page.getByRole('button', { name: 'Create draft message' }).click();
    await expect(page).toHaveURL(/\/messages\/[0-9a-f-]{36}$/);
    messageId = page.url().split('/').pop()!;
    await expect(page.getByText(text)).toBeVisible();
    await expect(page.getByRole('img', { name: 'shore.png' })).toBeVisible();
    await schedule(page, 'After my passing');

    // The wish itself is unchanged and still private.
    await page.goto(`/my-wishes/${KEY}`);
    await expect(page.getByLabel('Your answer')).toHaveValue(text);
  } finally {
    if (messageId) {
      for (const id of await messageMediaFileIds([messageId])) imagekitFiles.add(id);
      await page.request.delete(`${API}/messages/${messageId}/schedule`);
      await page.request.delete(`${API}/messages/${messageId}`);
    }
    await page.request.delete(`${API}/my-wishes/prompts/${KEY}/response`);
  }
});

// Phase 14A: the approved V1 catalogue (9 categories, 22 prompts) end to end.
test('My Story V1: categories in order → Work and Travel → answer, reload, edit, delete, answer again', async ({ page }) => {
  await page.goto('/my-story');
  const chips = page.getByRole('navigation', { name: /categor/i }).getByRole('link');
  await expect(chips).toHaveText([
    'All',
    'Childhood',
    'Family',
    'Relationships',
    'Work',
    'Travel',
    'Milestones',
    'Values',
    'Life lessons',
    'Legacy',
  ]);

  await chips.getByText('Travel', { exact: true }).click();
  await expect(page).toHaveURL(/category=TRAVEL/);
  await expect(page.getByText('Tell us about a journey that stayed with you.')).toBeVisible();
  await expect(page.getByText('What do you remember about your first job?')).toHaveCount(0);

  await chips.getByText('Work', { exact: true }).click();
  await expect(page).toHaveURL(/category=WORK/);
  await page.getByRole('link', { name: /What do you remember about your first job\?/ }).click();
  await expect(page.getByRole('heading', { name: 'What do you remember about your first job?' })).toBeVisible();
  try {
    await page.getByLabel('Your answer').fill('A paper round, synthetic answer.');
    await page.getByRole('button', { name: 'Save answer' }).click();
    await expect(page).toHaveURL(/\/my-story$/);
    await page.reload();
    await expect(page.getByText('A paper round, synthetic answer.')).toBeVisible();

    await page.getByRole('link', { name: /A paper round, synthetic answer\./ }).click();
    await expect(page.getByText(/earlier wording/)).toHaveCount(0); // answered the current wording
    await page.getByLabel('Your answer').fill('A paper round, edited.');
    await page.getByRole('button', { name: 'Save answer' }).click();
    await expect(page.getByText('A paper round, edited.')).toBeVisible();

    await page.getByRole('link', { name: /A paper round, edited\./ }).click();
    await page.getByRole('button', { name: 'Delete answer' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete answer' }).click();
    await expect(page.getByText('A paper round, edited.')).toHaveCount(0);

    // Answer again: the same prompt takes a new answer (restored server-side).
    await page.goto('/my-story/work.first-job');
    await expect(page.getByLabel('Your answer')).toHaveValue('');
    await page.getByLabel('Your answer').fill('Written again.');
    await page.getByRole('button', { name: 'Save answer' }).click();
    await expect(page.getByText('Written again.')).toBeVisible();
  } finally {
    await page.request.delete(`${API}/my-story/prompts/work.first-job/response`);
  }
});

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
