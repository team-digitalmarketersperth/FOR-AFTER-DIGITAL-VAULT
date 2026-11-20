// Updated Plans Step 5: the companion's allowance UI in a real browser at desktop (1280×900) and phone (390×844).
// Isolated `next start` (:3001) + isolated API (:4001) with fake-groq.mjs preloaded (Groq is never contacted).
// Synthetic accounts from browser-seed.mjs. One JSON line per check, then a summary.
import { createRequire } from 'node:module';
const require = createRequire('D:/FOR-AFTER-DIGITAL-VAULT/for-after-frontend/package.json');
const { chromium } = require('playwright');

const F = JSON.parse(process.argv[2]);
const APP = 'http://localhost:3001';
const OUT = new URL('.', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
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
const panel = () => page.getByRole('dialog', { name: /For After AI companion/ });
const openCompanion = async () => {
  await page.getByRole('button', { name: 'Open AI companion' }).click();
  await panel().waitFor();
};
const closeCompanion = async () => {
  await page.keyboard.press('Escape');
  await panel().waitFor({ state: 'hidden' });
};
const sendText = async (text) => {
  await panel().getByRole('textbox').fill(text);
  await panel().getByRole('button', { name: 'Send' }).click();
};

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
  // ── Trial: 3 of 5 used; one reply (fake provider) makes it 4 of 5.
  const t = await browser.newContext({ viewport: VIEWPORTS.desktop });
  await signIn(t, F.trial);
  await check('[desktop] trial: "3 of 5 trial AI replies used"; a reply arrives and the line becomes 4 of 5', async () => {
    await go('/dashboard');
    await openCompanion();
    await panel().getByText('3 of 5 trial AI replies used').waitFor();
    await sendText('Where should I start?');
    await panel().getByText('A fictional suggestion from the fake provider.').waitFor();
    await panel().getByText('4 of 5 trial AI replies used').waitFor();
    await closeCompanion();
  });
  await page.setViewportSize(VIEWPORTS.phone);
  await check('[phone] trial: the usage line and the panel fit the phone width', async () => {
    await go('/dashboard');
    await openCompanion();
    await panel().getByText('4 of 5 trial AI replies used').waitFor();
    await noOverflow();
    await closeCompanion();
  });
  await t.close();

  // ── Premium at 50 of 50: exhaustion is explained, typed text comes back, no Try again; writing stays possible.
  const p = await browser.newContext({ viewport: VIEWPORTS.desktop });
  await signIn(p, F.prem);
  for (const [vp, size] of Object.entries(VIEWPORTS)) {
    await page.setViewportSize(size);
    await check(`[${vp}] Premium allowance used: its own message with the reset date (not "busy"), no Try again, the typed text kept`, async () => {
      await go('/my-wishes/ceremony.style');
      await openCompanion();
      await panel().getByText(/50 of 50 AI replies used this month · resets \d+ \w+/).waitFor();
      await sendText('Help me with my words');
      const alert = panel().getByRole('alert');
      await alert.waitFor();
      const text = await alert.textContent();
      expect(/You’ve used this month’s 50 AI companion replies\. They reset on \d+ \w+ \(UTC\)\. You can keep writing on your own\./.test(text), `message: ${text}`);
      expect(!/busy|hourly/i.test(text), 'shown as a rate limit');
      expect((await alert.getByRole('button', { name: 'Try again' }).count()) === 0, 'Try again offered');
      expect((await panel().getByRole('textbox').inputValue()) === 'Help me with my words', 'typed text lost');
      await noOverflow();
      await closeCompanion();
    });
    await check(`[${vp}] Premium allowance used: manual writing still works (the answer box is editable)`, async () => {
      const box = page.getByRole('textbox', { name: 'Your answer', exact: true });
      await box.waitFor();
      expect((await box.getAttribute('readonly')) === null, 'answer box read-only');
      await box.fill('Something small, written by hand.');
      expect((await box.inputValue()) === 'Something small, written by hand.', 'typing failed');
    });
  }
  await p.close();

  // ── Unmapped paid: not metered; no usage line, never "unlimited"; replies work.
  const u = await browser.newContext({ viewport: VIEWPORTS.phone });
  await signIn(u, F.unm);
  await check('[phone] unmapped paid: no usage line and no "unlimited"; a reply arrives', async () => {
    await go('/dashboard');
    await openCompanion();
    await sendText('Where should I start?');
    await panel().getByText('A fictional suggestion from the fake provider.').waitFor();
    expect((await panel().getByText(/AI replies used/).count()) === 0, 'usage line shown');
    expect((await panel().getByText(/unlimited/i).count()) === 0, '"unlimited" shown');
    await noOverflow();
  });
  await u.close();
} finally {
  await browser.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(JSON.stringify({ summary: { checks: results.length, passed: results.length - failed, failed } }));
  process.exitCode = failed ? 1 : 0;
}
