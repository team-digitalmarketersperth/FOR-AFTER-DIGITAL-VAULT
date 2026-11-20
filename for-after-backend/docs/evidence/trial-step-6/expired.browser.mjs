// Step 6 in a real browser at desktop (1280×900) and phone (390×844) widths: isolated `next start` (:3001, production
// build of the current source) against an isolated API (:4001, test DB for_after_p24, Redis :6390, email disabled,
// SMS/Stripe/Observe blanked). Synthetic accounts from seed.mjs. One JSON line per check, then a summary.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire('D:/FOR-AFTER-DIGITAL-VAULT/for-after-frontend/package.json');
const { chromium } = require('playwright');

const F = JSON.parse(process.argv[2]);
const APP = 'http://localhost:3001';
const OUT = new URL('.', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
const TITLE = 'Your free trial has ended';
const BODY = 'Choose a plan to keep creating and editing. You can still view, download and delete your existing content.';
const VIEWPORTS = { desktop: { width: 1280, height: 900 }, phone: { width: 390, height: 844 } };
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
const noOverflow = async () => {
  const o = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(o <= 0, `horizontal overflow ${o}px`);
};
const go = (p) => page.goto(`${APP}${p}`, { waitUntil: 'load' });
const banner = () => page.getByRole('region', { name: TITLE });
const focusedText = () => page.evaluate(() => document.activeElement?.textContent ?? '');

async function signIn(context, emailAddr) {
  page = await context.newPage();
  page.setDefaultTimeout(30_000);
  await go('/login');
  await page.getByLabel('Email').fill(emailAddr);
  await page.getByLabel('Password', { exact: true }).fill('StrongPassword123!');
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 60_000 });
}

const browser = await chromium.launch();
try {
  // ── Expired account, both widths in one session (sign-in is limited to 5/min per IP).
  const ctx = await browser.newContext({ viewport: VIEWPORTS.desktop });
  await signIn(ctx, F.exp);
  for (const [vp, size] of Object.entries(VIEWPORTS)) {
    await page.setViewportSize(size);
    await check(`[${vp}] banner on Memory Vault: approved heading, body, View plans; existing memory listed; no overflow`, async () => {
      await go('/memory-vault');
      await banner().waitFor();
      expect((await banner().textContent()).includes(BODY), 'body text');
      expect((await banner().getByRole('link', { name: 'View plans' }).getAttribute('href')) === '/settings/plan', 'View plans href');
      await page.getByText('Beach days').first().waitFor();
      await noOverflow();
    });
    await check(`[${vp}] "Save a memory" opens the plan dialog (keyboard); Escape closes; focus returns; no navigation`, async () => {
      const link = page.locator('a[href="/memory-vault/new"]').first();
      await link.focus();
      await page.keyboard.press('Enter');
      const dialog = page.getByRole('dialog', { name: TITLE });
      await dialog.waitFor();
      expect(new URL(page.url()).pathname === '/memory-vault', `navigated to ${page.url()}`);
      expect(await dialog.getByRole('link', { name: 'View plans' }).isVisible(), 'View plans in dialog');
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'hidden' });
      await page.waitForFunction(() => document.activeElement?.getAttribute('href') === '/memory-vault/new', null, { timeout: 5000 });
      await noOverflow();
    });
    await check(`[${vp}] direct edit URL explains and offers read-only viewing (no redirect loop)`, async () => {
      await go(`/memory-vault/${F.memory}/edit`);
      await page.getByRole('heading', { name: TITLE, level: 1 }).waitFor();
      await page.getByRole('link', { name: 'View it read-only' }).click();
      await page.waitForURL(`${APP}/memory-vault/${F.memory}`);
      await page.getByText('A synthetic memory.').first().waitFor();
      await noOverflow();
    });
    await check(`[${vp}] opening a message: prompt with View plans / Continue viewing; dismissed it stays closed; delete still offered`, async () => {
      await go(`/messages/${F.message}`);
      const dialog = page.getByRole('dialog', { name: TITLE });
      await dialog.waitFor();
      expect(await dialog.getByRole('link', { name: 'View plans' }).isVisible(), 'View plans');
      await dialog.getByRole('button', { name: 'Continue viewing' }).click();
      await dialog.waitFor({ state: 'hidden' });
      // Focus and a tab-visibility change make the app refetch; the prompt must not come back.
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await page.waitForTimeout(2500);
      expect((await page.getByRole('dialog').count()) === 0, 'prompt reopened');
      await page.getByText('Dear Sofia, a synthetic message.').waitFor();
      expect(await page.getByRole('button', { name: /Delete draft/ }).isVisible(), 'delete control');
      await noOverflow();
    });
    await check(`[${vp}] saved wish is read-only: Edit answer opens the plan dialog; Delete answer offered`, async () => {
      await go('/my-wishes/ceremony.style');
      const box = page.getByRole('textbox', { name: 'Your answer', exact: true });
      await box.waitFor();
      expect((await box.getAttribute('readonly')) !== null, 'textarea not read-only');
      expect((await box.inputValue()) === 'Something small, by the sea.', 'saved text shown');
      expect((await page.getByRole('button', { name: 'Save answer' }).count()) === 0, 'Save shown');
      expect(await page.getByRole('button', { name: 'Delete answer' }).isVisible(), 'Delete answer');
      await page.getByRole('button', { name: 'Edit answer' }).click();
      await page.getByRole('dialog', { name: TITLE }).waitFor();
      await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
      await noOverflow();
    });
  }
  await check('[desktop] deleting existing content still works (memory removed)', async () => {
    await page.setViewportSize(VIEWPORTS.desktop);
    await go(`/memory-vault/${F.memoryToDelete}`);
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete memory' }).click();
    await page.waitForURL(`${APP}/memory-vault`);
    await page.getByText('Beach days').first().waitFor();
    expect((await page.getByText('First house').count()) === 0, 'deleted memory still listed');
  });
  await ctx.close();

  // ── A form open when the trial ends: the save is refused, the text is kept, nothing is claimed saved.
  const act = await browser.newContext({ viewport: VIEWPORTS.phone });
  await signIn(act, F.act);
  await check('[phone] trial ends while a form is open: save refused, "This wasn’t saved", text kept, View plans, banner appears', async () => {
    await go('/my-wishes/ceremony.setting');
    const box = page.getByRole('textbox', { name: 'Your answer', exact: true });
    await box.waitFor();
    await box.fill('Typed before the trial ended.');
    execFileSync('node', ['scripts/phase24/isolated-env.mjs', '--', 'node', `${OUT}/seed.mjs`, 'expire', F.run], { cwd: 'D:/FOR-AFTER-DIGITAL-VAULT/for-after-backend', stdio: 'ignore' });
    await page.getByRole('button', { name: 'Save answer' }).click();
    await page.getByText('This wasn’t saved. What you typed is still here.').waitFor();
    expect((await box.inputValue()) === 'Typed before the trial ended.', 'typed text kept');
    expect((await page.getByRole('link', { name: 'View plans' }).count()) > 0, 'View plans link');
    await banner().waitFor();
    expect((await box.inputValue()) === 'Typed before the trial ended.', 'text kept after refetch');
    expect((await page.getByText('Your answer is saved').count()) === 0, 'claimed saved');
    await noOverflow();
  });
  await act.close();

  // ── Other states are explained accurately.
  const nos = await browser.newContext({ viewport: VIEWPORTS.desktop });
  await signIn(nos, F.nos);
  await check('[desktop] trial not started: "Start your free trial", never "trial ended"', async () => {
    await go('/memory-vault');
    await page.getByRole('region', { name: 'Start your free trial' }).waitFor();
    expect((await page.getByText(TITLE).count()) === 0, 'expired copy shown');
  });
  await nos.close();
  const paid = await browser.newContext({ viewport: VIEWPORTS.phone });
  await signIn(paid, F.paid);
  await check('[phone] paid with old trial dates: no banner, new answers open', async () => {
    await go('/my-wishes/ceremony.style');
    await page.getByRole('textbox', { name: 'Your answer', exact: true }).waitFor();
    await page.waitForTimeout(1500);
    expect((await page.getByText(TITLE).count()) === 0, 'expired banner shown');
    expect((await page.getByRole('button', { name: 'Save answer' }).count()) === 1, 'Save missing');
    await noOverflow();
  });
  await paid.close();
} finally {
  await browser.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(JSON.stringify({ summary: { checks: results.length, passed: results.length - failed, failed } }));
  process.exitCode = failed ? 1 : 0;
}
