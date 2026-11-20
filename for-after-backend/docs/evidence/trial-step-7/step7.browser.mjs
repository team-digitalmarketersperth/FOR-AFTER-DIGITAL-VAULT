// Step 7 in a real browser at desktop (1280×900) and phone (390×844) widths: isolated `next start` (:3001, production
// build of the current source) against an isolated API (:4001, test DB for_after_p24, Redis :6390, email disabled,
// SMS/Stripe/Observe blanked). Synthetic accounts from browser-seed.mjs. One JSON line per check, then a summary.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire('D:/FOR-AFTER-DIGITAL-VAULT/for-after-frontend/package.json');
const { chromium } = require('playwright');

const F = JSON.parse(process.argv[2]);
const APP = 'http://localhost:3001';
const OUT = new URL('.', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
const EXPIRED = 'Your free trial has ended';
const MEM_TITLE = 'Save more memories with a plan';
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
const seed = (...args) =>
  execFileSync('node', ['scripts/phase24/isolated-env.mjs', '--', 'node', `${OUT}/browser-seed.mjs`, ...args, F.run], { cwd: 'D:/FOR-AFTER-DIGITAL-VAULT/for-after-backend', stdio: 'ignore' });

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
  // ── Active trial, one memory used: counter, Pro, dialog, direct /new, edit still open.
  const ctx = await browser.newContext({ viewport: VIEWPORTS.desktop });
  await signIn(ctx, F.act);
  for (const [vp, size] of Object.entries(VIEWPORTS)) {
    await page.setViewportSize(size);
    await check(`[${vp}] Memory Vault: "1 of 1 trial memory used"; Save a memory shows Pro and opens the dialog (keyboard); Escape returns focus; no expired banner`, async () => {
      await go('/memory-vault');
      await page.getByText('1 of 1 trial memory used').waitFor();
      const pro = page.getByRole('button', { name: /Save a memory\s*Pro/ });
      await pro.focus();
      await page.keyboard.press('Enter');
      const dialog = page.getByRole('dialog', { name: MEM_TITLE });
      await dialog.waitFor();
      expect((await dialog.getByRole('link', { name: 'View plans' }).getAttribute('href')) === '/settings/plan', 'View plans href');
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'hidden' });
      await page.waitForFunction(() => /Save a memory/.test(document.activeElement?.textContent ?? ''), null, { timeout: 5000 });
      expect((await page.getByText(EXPIRED).count()) === 0, 'expired banner during an active trial');
      expect(new URL(page.url()).pathname === '/memory-vault', 'navigated');
      await noOverflow();
    });
    await check(`[${vp}] direct /memory-vault/new at the cap explains (View plans, Back to Memory Vault), no form`, async () => {
      await go('/memory-vault/new');
      await page.getByRole('heading', { name: MEM_TITLE }).waitFor();
      expect((await page.getByRole('button', { name: 'Save memory' }).count()) === 0, 'form shown');
      expect(await page.getByRole('link', { name: 'Back to Memory Vault' }).isVisible(), 'back link');
      await noOverflow();
    });
  }
  await check('[desktop] the existing trial memory can still be edited', async () => {
    await page.setViewportSize(VIEWPORTS.desktop);
    await go(`/memory-vault/${F.actMemory}/edit`);
    const title = page.getByLabel('Title');
    await title.fill('Beach days, edited');
    await page.getByRole('button', { name: /^Save/ }).click();
    await page.waitForURL(`${APP}/memory-vault/${F.actMemory}`);
    await page.getByText('Beach days, edited').first().waitFor();
  });
  await ctx.close();

  // ── Active trial, nothing used: the first memory is saved through the UI, then the counter and Pro appear.
  const fresh = await browser.newContext({ viewport: VIEWPORTS.phone });
  await signIn(fresh, F.fresh);
  await check('[phone] first memory: "0 of 1", the form saves it, then "1 of 1" with Pro', async () => {
    await go('/memory-vault');
    await page.getByText('0 of 1 trial memory used').waitFor();
    await go('/memory-vault/new');
    await page.getByLabel('Title').fill('My first memory');
    await page.getByRole('radio', { name: 'Other' }).check();
    await page.getByRole('button', { name: 'Save memory' }).click();
    await page.waitForURL((u) => /\/memory-vault\/[0-9a-f-]{36}$/.test(u.pathname));
    await go('/memory-vault');
    await page.getByText('1 of 1 trial memory used').waitFor();
    await page.getByRole('button', { name: /Save a memory\s*Pro/ }).waitFor();
    await noOverflow();
  });
  await fresh.close();

  // ── Expired: unlink-only and unscheduling work; scheduling stays locked.
  const exp = await browser.newContext({ viewport: VIEWPORTS.desktop });
  await signIn(exp, F.exp);
  await check('[desktop] expired: Unlink removes one memory link; text stays read-only; the memory remains in the vault', async () => {
    await go('/my-story/childhood.earliest-memory');
    await page.getByRole('region', { name: EXPIRED }).waitFor();
    await page.getByRole('button', { name: 'Unlink Beach days' }).click();
    await page.getByRole('button', { name: 'Unlink Beach days' }).waitFor({ state: 'detached' });
    expect(await page.getByRole('link', { name: 'Old house' }).isVisible(), 'other link kept');
    await go('/memory-vault');
    await page.getByText('Beach days').first().waitFor();
  });
  await page.setViewportSize(VIEWPORTS.phone);
  await check('[phone] expired: Unlink the other memory; no overflow', async () => {
    await go('/my-story/childhood.earliest-memory');
    await page.getByRole('button', { name: 'Unlink Old house' }).click();
    await page.getByRole('button', { name: 'Unlink Old house' }).waitFor({ state: 'detached' });
    await noOverflow();
  });
  await check('[phone] expired: "Unschedule" (not "to edit") works; Change timing opens the plan dialog', async () => {
    await go(`/messages/${F.message}`);
    const prompt = page.getByRole('dialog', { name: EXPIRED });
    await prompt.waitFor();
    await prompt.getByRole('button', { name: 'Continue viewing' }).click();
    await prompt.waitFor({ state: 'hidden' });
    expect((await page.getByRole('button', { name: 'Unschedule to edit' }).count()) === 0, 'promises editing');
    await page.getByRole('button', { name: 'Change timing' }).click();
    const plan = page.getByRole('dialog', { name: EXPIRED });
    await plan.waitFor();
    await plan.getByRole('button', { name: 'Close' }).click();
    await plan.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: 'Unschedule', exact: true }).click();
    const confirm = page.getByRole('dialog', { name: 'Unschedule this message?' });
    await confirm.getByRole('button', { name: 'Unschedule', exact: true }).click();
    await page.getByText('Unscheduled: it’s a draft again').waitFor();
    await noOverflow();
  });
  await exp.close();

  // ── Local draft: refused autosave labelled, kept in this tab, offered after an upgrade, never sent by itself.
  const drf = await browser.newContext({ viewport: VIEWPORTS.desktop });
  await signIn(drf, F.drf);
  // Spaces, blank lines, a tab, curly quotes, an em dash and an emoji must survive byte for byte.
  const EXACT = 'Something small.\n\n  Then the sea —\t“by the water” 🌊  \nLast line  ';
  const puts = [];
  await check('[desktop] trial ends mid-typing: "Not saved to your account." and one exact tab copy', async () => {
    page.on('request', (r) => ['PUT', 'POST', 'PATCH'].includes(r.method()) && r.url().includes('/my-wishes/prompts/') && puts.push(`${r.method()} ${r.url()}`));
    await go('/my-wishes/ceremony.style');
    const box = page.getByRole('textbox', { name: 'Your answer', exact: true });
    await box.waitFor();
    seed('expire');
    await box.fill(EXACT);
    await page.getByText('Not saved to your account.').waitFor({ timeout: 15_000 });
    await page.waitForTimeout(1000);
    const kept = await page.evaluate(() => Object.entries(sessionStorage).filter(([k]) => k.startsWith('for-after:unsaved:')).map(([, v]) => JSON.parse(v).payload.textContent));
    expect(kept.length === 1 && kept[0] === EXACT, `kept ${JSON.stringify(kept)}`);
  });
  await check('[desktop] expired + reload: read-only answer offers "View unsaved draft" (exact text); nothing becomes editable', async () => {
    page.once('dialog', (d) => d.accept()); // the leave-page warning
    await page.reload({ waitUntil: 'load' });
    const section = page.getByRole('region', { name: 'Unsaved draft in this tab' });
    await section.waitFor();
    expect(await section.getByText(/may disappear when you close the tab/).isVisible(), 'temporary wording');
    await section.getByRole('button', { name: 'View unsaved draft' }).click();
    const shown = await section.getByRole('region', { name: 'Unsaved draft' }).textContent();
    expect(shown === EXACT, `shown ${JSON.stringify(shown)}`);
    const box = page.getByRole('textbox', { name: 'Your answer', exact: true });
    expect((await box.getAttribute('readonly')) !== null, 'answer became editable');
    expect((await box.inputValue()) === 'Something small.', 'saved text changed');
    expect((await page.getByRole('button', { name: 'Save answer' }).count()) === 0, 'Save shown');
    expect((await page.getByRole('button', { name: 'Restore changes' }).count()) === 0, 'Restore shown');
    expect(await section.getByRole('button', { name: 'Discard' }).isVisible(), 'Discard');
    await noOverflow();
  });
  await page.setViewportSize(VIEWPORTS.phone);
  await check('[phone] read-only unsaved draft fits the phone width', async () => {
    await page.getByRole('region', { name: 'Unsaved draft', exact: true }).waitFor();
    await noOverflow();
  });
  await page.setViewportSize(VIEWPORTS.desktop);
  await check('[desktop] after an upgrade (subscription row) + reload the copy is offered; Restore gives the exact text; nothing is sent', async () => {
    seed('pay');
    await page.reload({ waitUntil: 'load' });
    const notice = page.getByRole('region', { name: 'Unsaved changes found' });
    await notice.waitFor();
    expect(await notice.getByText('Not saved to your account.').isVisible(), 'label in recovery notice');
    await notice.getByRole('button', { name: 'Restore changes' }).click();
    await page.waitForFunction((t) => document.querySelector('textarea')?.value === t, EXACT, { timeout: 5000 });
    await page.waitForTimeout(3500); // longer than the autosave delay
    expect(puts.length === 0, `answer requests sent: ${puts.join(', ')}`);
  });
  await check('[desktop] Log out (account menu) removes the tab copy', async () => {
    await page.getByRole('button', { name: /^Account:/ }).click();
    await page.getByRole('menuitem', { name: 'Log out' }).click();
    await page.waitForURL((u) => u.pathname.startsWith('/login'));
    const left = await page.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith('for-after:unsaved:')).length);
    expect(left === 0, `${left} copies left after sign-out`);
  });
  await drf.close();

  // ── Paid: no trial counters or Pro.
  const paid = await browser.newContext({ viewport: VIEWPORTS.phone });
  await signIn(paid, F.paid);
  await check('[phone] paid: Memory Vault has no trial counter and a plain Save a memory link', async () => {
    await go('/memory-vault');
    await page.getByText('Paid memory').first().waitFor();
    await page.waitForTimeout(1000);
    expect((await page.getByText(/trial memory used/).count()) === 0, 'counter shown');
    expect((await page.locator('a[href="/memory-vault/new"]').count()) > 0, 'link missing');
    await noOverflow();
  });
  await paid.close();
} finally {
  await browser.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(JSON.stringify({ summary: { checks: results.length, passed: results.length - failed, failed } }));
  process.exitCode = failed ? 1 : 0;
}
