// Trial Step 5 in a real browser: isolated `next start` (:3001, production build of the current source) against an
// isolated API (:4001, test DB for_after_p24, Redis :6390, email disabled, SMS/Stripe unconfigured). Synthetic accounts
// from seed.mjs. Prints one JSON line per check and a summary; screenshots of failures go next to this file.
import { createRequire } from 'node:module';
const require = createRequire('D:/FOR-AFTER-DIGITAL-VAULT/for-after-frontend/package.json');
const { chromium } = require('playwright');

const [trialEmail, paidEmail] = process.argv.slice(2);
const APP = 'http://localhost:3001';
const API = 'http://localhost:4001/api/v1';
const OUT = new URL('.', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
// S[1] (childhood.home) is seeded with words and a linked memory; the workspace opens S[0] first.
const S = ['childhood.earliest-memory', 'childhood.home', 'childhood.school'];
const W = ['ceremony.style', 'ceremony.setting', 'atmosphere.feeling'];
const results = [];
let page;

async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    const shot = `${OUT}/fail-${results.length + 1}.png`;
    await page?.screenshot({ path: shot, fullPage: true }).catch(() => {});
    results.push({ name, ok: false, error: String(err?.message ?? err).split('\n').slice(0, 4).join(' | '), shot });
  }
  console.log(JSON.stringify(results.at(-1)));
}
const expect = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
// Writes through the real API from the page (same cookies, same Origin), as another tab would.
const put = (path, body) =>
  page.evaluate(
    async ([url, b]) => {
      const r = await fetch(url, { method: 'PUT', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
      return r.status;
    },
    [`${API}${path}`, body],
  );
const counter = () => page.getByText(/\d+ of 4 trial questions answered/).first().textContent({ timeout: 30_000 });

async function signIn(context, email) {
  page = await context.newPage();
  page.setDefaultTimeout(30_000);
  await page.goto(`${APP}/login`, { waitUntil: 'load' });
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill('StrongPassword123!');
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 60_000 });
}

const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await signIn(context, trialEmail);

  await check('My Wishes shows 1 of 4 (the seeded My Story answer) before any wish', async () => {
    await page.goto(`${APP}/my-wishes`, { waitUntil: 'load' });
    expect((await counter()) === '1 of 4 trial questions answered', `counter: ${await counter()}`);
  });

  await check('answer one wish in the UI: counter becomes 2 of 4 in both sections', async () => {
    await page.goto(`${APP}/my-wishes/${W[0]}`, { waitUntil: 'load' });
    await page.getByRole('textbox', { name: 'Your answer', exact: true }).fill('Something small, by the sea.');
    await page.getByRole('button', { name: 'Save answer' }).click();
    await page.waitForURL(`${APP}/my-wishes`);
    expect((await counter()) === '2 of 4 trial questions answered', `wishes counter: ${await counter()}`);
    await page.goto(`${APP}/my-story`, { waitUntil: 'load' });
    expect((await counter()) === '2 of 4 trial questions answered', `story counter: ${await counter()}`);
  });

  await check('answer one My Story question in the workspace: 3 of 4 shared', async () => {
    const box = page.getByRole('textbox', { name: 'Your answer', exact: true });
    await box.fill('A small house with a lemon tree.');
    await page.getByRole('button', { name: 'Save answer' }).click();
    await page.getByText('Your answer and private note are saved.').waitFor();
    await page.goto(`${APP}/my-wishes`, { waitUntil: 'load' });
    expect((await counter()) === '3 of 4 trial questions answered', `counter: ${await counter()}`);
  });

  await check('a fourth answer (wish, via the API like another tab): 4 of 4; a fifth via the API is 409 TRIAL_LIMIT', async () => {
    expect((await put(`/my-wishes/prompts/${W[1]}/response`, { textContent: 'Another.' })) === 200, 'wish 4th');
    const fifth = await put(`/my-wishes/prompts/${W[2]}/response`, { textContent: 'Fifth.' });
    expect(fifth === 409, `fifth status ${fifth}`);
    await page.goto(`${APP}/my-wishes`, { waitUntil: 'load' });
    expect((await counter()) === '4 of 4 trial questions answered', `counter: ${await counter()}`);
  });

  await check('at the cap: an unanswered wish shows Pro and opens the dialog (View plans / Close); Escape closes and focus returns', async () => {
    const card = page.getByRole('button', { name: /Write your answer\s*Pro/ }).first();
    await card.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Answer more questions with a plan' });
    await dialog.waitFor();
    expect((await dialog.getByRole('link', { name: 'View plans' }).getAttribute('href')) === '/settings/plan', 'View plans href');
    expect(await dialog.getByRole('button', { name: 'Close' }).isVisible(), 'Close button');
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.activeElement?.textContent?.includes('Write your answer'), null, { timeout: 5_000 });
  });

  await check('Close button closes the dialog and returns focus to the Pro control', async () => {
    const card = page.getByRole('button', { name: /Write your answer\s*Pro/ }).first();
    await card.click();
    const dialog = page.getByRole('dialog', { name: 'Answer more questions with a plan' });
    await dialog.getByRole('button', { name: 'Close' }).click();
    await dialog.waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.activeElement?.textContent?.includes('Write your answer'), null, { timeout: 5_000 });
  });

  await check('My Story at the cap: the current new question shows Pro instead of the answer box; the memory picker shows Pro', async () => {
    await page.goto(`${APP}/my-story`, { waitUntil: 'load' });
    await page.getByRole('button', { name: /Write your answer\s*Pro/ }).waitFor();
    expect((await page.getByRole('textbox', { name: 'Your answer', exact: true }).count()) === 0, 'answer box should not show');
    await page.getByRole('button', { name: /Choose from Memory Vault\s*Pro/ }).waitFor();
  });

  await check('an existing answer stays editable at the cap (edit + save; count stays 4)', async () => {
    await page.goto(`${APP}/my-wishes/${W[0]}`, { waitUntil: 'load' });
    const box = page.getByRole('textbox', { name: 'Your answer', exact: true });
    expect((await box.inputValue()) === 'Something small, by the sea.', 'saved text');
    await box.fill('Something small, by the sea, at dusk.');
    await page.getByRole('button', { name: 'Save answer' }).click();
    await page.waitForURL(`${APP}/my-wishes`);
    expect((await counter()) === '4 of 4 trial questions answered', `counter: ${await counter()}`);
  });

  await check('deleting an answer frees a slot: 3 of 4, and the locked wish opens as a form', async () => {
    await page.goto(`${APP}/my-wishes/${W[1]}`, { waitUntil: 'load' });
    await page.getByRole('button', { name: 'Delete answer' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete answer' }).click();
    await page.waitForURL(`${APP}/my-wishes`);
    expect((await counter()) === '3 of 4 trial questions answered', `counter: ${await counter()}`);
    expect((await page.getByRole('button', { name: /Write your answer\s*Pro/ }).count()) === 0, 'no Pro cards left');
    await page.goto(`${APP}/my-wishes/${W[2]}`, { waitUntil: 'load' });
    await page.getByRole('textbox', { name: 'Your answer', exact: true }).waitFor();
  });

  await check('stale-limit refusal: the open form keeps the typed text and shows the message with View plans', async () => {
    // The form for W[2] is open (3 of 4). Another tab uses the last slot.
    expect((await put(`/my-story/prompts/${S[2]}/response`, { textContent: 'Used the last slot.' })) === 200, 'other tab');
    const box = page.getByRole('textbox', { name: 'Your answer', exact: true });
    await box.fill('Typed before the refusal.');
    await page.getByRole('button', { name: 'Save answer' }).click();
    await page.getByText(/Choose a plan to answer more/).waitFor();
    expect((await box.inputValue()) === 'Typed before the refusal.', 'typed text kept');
    expect((await page.getByRole('link', { name: 'View plans' }).count()) > 0, 'View plans link');
    await page.waitForFunction(() => /4 of 4 trial questions answered/.test(document.body.innerText), null, { timeout: 15_000 });
    expect((await box.inputValue()) === 'Typed before the refusal.', 'typed text kept after the plan refetch');
  });

  await check('clearing the words of a linked answer in the UI frees a slot; its linked memory stays', async () => {
    await page.goto(`${APP}/my-story/${S[1]}`, { waitUntil: 'load' });
    const box = page.getByRole('textbox', { name: 'Your answer', exact: true });
    expect((await box.inputValue()) === 'A house by the sea.', 'seeded text');
    await box.fill('');
    await page.getByRole('button', { name: 'Save answer' }).click();
    await page.waitForURL(`${APP}/my-story`);
    expect((await counter()) === '3 of 4 trial questions answered', `counter: ${await counter()}`);
    await page.goto(`${APP}/my-story/${S[1]}`, { waitUntil: 'load' });
    await page.getByRole('button', { name: 'Unlink Beach days' }).waitFor();
  });

  await check('plan loading: a new answer shows "Checking your plan…" and no answer box', async () => {
    let release;
    const held = new Promise((r) => (release = r));
    await page.route(`${API}/billing`, async (route) => {
      await held;
      await route.continue();
    });
    await page.goto(`${APP}/my-wishes/${W[1]}`, { waitUntil: 'load' });
    await page.getByText('Checking your plan…').first().waitFor();
    expect((await page.getByRole('textbox', { name: 'Your answer', exact: true }).count()) === 0, 'no answer box while loading');
    release();
    await page.getByRole('textbox', { name: 'Your answer', exact: true }).waitFor();
    await page.unroute(`${API}/billing`);
  });

  await check('plan unreadable: retry state, then Check plan again opens the form', async () => {
    let fail = true;
    await page.route(`${API}/billing`, (route) =>
      fail ? route.fulfill({ status: 500, contentType: 'application/json', headers: { 'access-control-allow-origin': APP, 'access-control-allow-credentials': 'true' }, body: '{"message":"Down"}' }) : route.continue(),
    );
    await page.goto(`${APP}/my-wishes/${W[1]}`, { waitUntil: 'load' });
    await page.getByText(/You can write a new answer once we’ve checked your plan/).waitFor({ timeout: 60_000 });
    expect((await page.getByRole('textbox', { name: 'Your answer', exact: true }).count()) === 0, 'no answer box on unknown plan');
    fail = false;
    await page.getByRole('button', { name: 'Check plan again' }).first().click();
    await page.getByRole('textbox', { name: 'Your answer', exact: true }).waitFor();
    await page.unroute(`${API}/billing`);
  });

  await context.close();

  const paid = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await signIn(paid, paidEmail);
  await check('paid account: no trial counter, no Pro, new questions open', async () => {
    await page.goto(`${APP}/my-wishes/${W[0]}`, { waitUntil: 'load' });
    await page.getByRole('textbox', { name: 'Your answer', exact: true }).waitFor();
    await page.goto(`${APP}/my-wishes`, { waitUntil: 'load' });
    await page.getByRole('link', { name: /What kind of/ }).first().waitFor().catch(() => {});
    await page.waitForTimeout(1500);
    expect((await page.getByText(/trial questions answered/).count()) === 0, 'no counter');
    expect((await page.getByText('Pro', { exact: true }).count()) === 0, 'no Pro');
  });
  await paid.close();
} finally {
  await browser.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(JSON.stringify({ summary: { checks: results.length, passed: results.length - failed, failed } }));
  process.exitCode = failed ? 1 : 0;
}
