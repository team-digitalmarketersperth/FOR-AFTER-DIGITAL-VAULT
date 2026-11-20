// Updated Plans Step 7: Settings → Plan and the shared feature lock in a real browser. LOCAL evidence only: isolated
// `next start` (:3001) + isolated API (:4001) booted from dist with a fake Stripe gateway (../updated-plans-step-6/
// api-fake-stripe.mjs). No payment, no Stripe page, no webhook. Synthetic accounts (browser-seed.mjs). Screenshots go
// to ./screens. Desktop 1280, tablet 820, phone 390, and 200% zoom (1280 px at 2× = 640 CSS px).
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire('D:/FOR-AFTER-DIGITAL-VAULT/for-after-frontend/package.json');
const { chromium } = require('playwright');

const F = JSON.parse(process.argv[2]);
const APP = 'http://localhost:3001';
const OUT = new URL('.', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
const SHOTS = `${OUT}/screens`;
mkdirSync(SHOTS, { recursive: true });
const VP = { desktop: { width: 1280, height: 900 }, tablet: { width: 820, height: 1180 }, phone: { width: 390, height: 844 }, zoom200: { width: 640, height: 450 } };
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
  expect(o <= 0, `horizontal page overflow ${o}px`);
};
const go = async (p) => {
  await page.goto(`${APP}${p}`, { waitUntil: 'load' });
};
const planReady = () => page.getByRole('heading', { name: 'What you’re using' }).waitFor();
const shot = (name) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
const billing = () => page.evaluate(async () => (await fetch('http://localhost:4001/api/v1/billing', { credentials: 'include' })).json());
const card = (name) => page.locator('li', { has: page.getByRole('heading', { name, level: 3 }) });
const absent = async (locator, what) => expect((await locator.count()) === 0, `${what} should not be shown`);
const focused = (locator) => locator.evaluate((el) => el === document.activeElement);
const tabTo = async (locator, n = 80) => {
  for (let i = 0; i < n; i++) {
    await page.keyboard.press('Tab');
    if (await focused(locator).catch(() => false)) return;
  }
  throw new Error('not reachable by Tab');
};
const focusVisible = (locator) =>
  locator.evaluate((el) => {
    const s = getComputedStyle(el);
    return (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) || s.boxShadow !== 'none';
  });

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
  // ── Active trial: summary, usage, layouts, and the shared lock dialog.
  const t = await browser.newContext({ viewport: VP.desktop });
  await signIn(t, F.trial);
  await check('[desktop] active trial: Free Trial + separate access; usage meters from the API (AI 3 of 5, 1 of 1 people); Free Trial card is "Your plan"', async () => {
    await go('/settings/plan');
    await planReady();
    await page.locator('dd', { hasText: /^Free Trial$/ }).waitFor();
    await page.getByText('3 of 5 replies used').waitFor();
    const people = page.locator('li', { has: page.getByText('People I Love', { exact: true }) });
    await people.getByText('1 of 1').waitFor();
    expect((await page.getByRole('progressbar').count()) >= 4, 'progress bars');
    const bar = people.getByRole('progressbar');
    expect((await bar.getAttribute('aria-valuenow')) === '1' && (await bar.getAttribute('aria-valuemax')) === '1', 'people bar values');
    await card('Free Trial').getByText('Your plan').waitFor();
    expect(!/unlimited|Most popular|\bAUD\b|\$/i.test(await page.locator('main').innerText()), 'forbidden claim on the page');
    await noOverflow();
    await shot('01-trial-desktop');
  });
  for (const vp of ['tablet', 'phone', 'zoom200']) {
    await page.setViewportSize(VP[vp]);
    await check(`[${vp}] active trial plan page: no page-level horizontal scroll; the comparison scrolls inside its own box`, async () => {
      await go('/settings/plan');
      await planReady();
      await noOverflow();
      if (vp === 'phone') await shot('02-trial-phone');
      if (vp === 'zoom200') await shot('03-trial-200pct-zoom');
    });
  }
  await page.setViewportSize(VP.desktop);
  await check('[desktop] People I Love at the trial cap: counter "1 of 1 person"; "Premium" lock opens the shared dialog (allowance, Premium’s 10, View plans, Close); Escape returns focus', async () => {
    await go('/people');
    await page.getByText('1 of 1 person').waitFor();
    const lock = page.getByRole('button', { name: /Add someone you love\s*Premium/ });
    await lock.click();
    const dialog = page.getByRole('dialog');
    await dialog.getByText(/For After Premium includes up to 10 people/).waitFor();
    await dialog.getByRole('link', { name: 'View plans' }).waitFor();
    await dialog.getByRole('button', { name: 'Close' }).waitFor();
    await shot('04-feature-lock-dialog');
    // Focus stays inside while open (Radix trap): Tab cycles within the dialog.
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => !!document.activeElement?.closest('[role=dialog]')), 'focus left the dialog');
    }
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    expect(await focused(lock), 'focus did not return to the lock');
  });
  await t.close();

  // ── Premium.
  const p = await browser.newContext({ viewport: VP.desktop });
  await signIn(p, F.prem);
  await check('[desktop] Premium: name, "Billed monthly", Manage billing; Complete card says plan changes aren’t online (no upgrade/checkout); AI 12 of 50 with UTC reset; 3 of 10 people', async () => {
    await go('/settings/plan');
    await planReady();
    await page.locator('dd', { hasText: /^For After Premium/ }).waitFor();
    await page.getByText('Billed monthly').waitFor();
    await page.getByRole('button', { name: 'Manage billing' }).waitFor();
    await card('For After Complete').getByText(/Changing plans isn’t available online yet/).waitFor();
    await absent(page.getByRole('button', { name: /secure checkout|Upgrade/i }), 'a purchase/upgrade button');
    await page.getByText('12 of 50 replies used').waitFor();
    await page.getByText(/Resets on .* \(UTC\)\. Annual plans reset monthly too\./).waitFor();
    await page.getByText('3 of 10', { exact: true }).waitFor();
    await noOverflow();
    await shot('05-premium-desktop');
  });
  await page.setViewportSize(VP.phone);
  await check('[phone] Premium plan page fits the phone width', async () => {
    await go('/settings/plan');
    await planReady();
    await noOverflow();
    await shot('06-premium-phone');
  });
  await p.close();

  // ── Complete.
  const c = await browser.newContext({ viewport: VP.desktop });
  await signIn(c, F.comp);
  await check('[desktop] Complete annual: name, "Billed annually", Complete card is "Your plan"; nothing to buy', async () => {
    await go('/settings/plan');
    await planReady();
    await page.locator('dd', { hasText: /^For After Complete/ }).waitFor();
    await page.getByText('Billed annually').waitFor();
    await card('For After Complete').getByText('Your plan').waitFor();
    await absent(page.getByRole('button', { name: /secure checkout/i }), 'a checkout button');
    await shot('07-complete-desktop');
  });
  await c.close();

  // ── Expired trial: keyboard interval choice, real <details> keyboard toggle, checkout payload, pending return.
  const e = await browser.newContext({ viewport: VP.desktop });
  await signIn(e, F.exp);
  await check('[desktop] expired: read-only notice; Premium "Not available to buy yet"; the comparison opens with Enter (native disclosure) and its focus is visible', async () => {
    await go('/settings/plan');
    await planReady();
    await page.getByText(/You can still read everything you’ve saved/).waitFor();
    await card('For After Premium').getByText('Not available to buy yet.').waitFor();
    await card('Free Trial').getByText('Your free trial has been used.').waitFor();
    const summary = page.getByText('Compare everything in each plan');
    await summary.focus();
    expect(await focusVisible(summary), 'no visible focus on the comparison toggle');
    await page.keyboard.press('Enter');
    await page.getByRole('table', { name: 'What each plan includes' }).waitFor();
    await shot('08-expired-desktop-comparison-open');
    await page.keyboard.press('Enter');
    await page.getByRole('table', { name: 'What each plan includes' }).waitFor({ state: 'hidden' });
  });
  await check('[desktop] expired: arrow keys pick Annual; Tab + Enter sends only { tier: COMPLETE, interval: annual }; the return shows "Confirming", access stays locked', async () => {
    await go('/settings/plan');
    await planReady();
    const complete = card('For After Complete');
    const monthly = complete.getByRole('radio', { name: 'Monthly' });
    await monthly.focus();
    expect(await focusVisible(page.locator(':focus').locator('xpath=..')), 'no visible focus on the interval choice');
    await page.keyboard.press('ArrowRight');
    expect(await complete.getByRole('radio', { name: 'Annual' }).isChecked(), 'Annual not chosen by arrow key');
    const sent = page.waitForRequest((r) => r.url().endsWith('/api/v1/billing/checkout') && r.method() === 'POST');
    await tabTo(complete.getByRole('button', { name: 'Continue to secure checkout' }), 5);
    await page.keyboard.press('Enter');
    const body = JSON.parse((await sent).postData() ?? '{}');
    expect(JSON.stringify(body) === JSON.stringify({ tier: 'COMPLETE', interval: 'annual' }), `checkout body ${JSON.stringify(body)}`);
    await page.waitForURL(/\/settings\/plan\?checkout=success/);
    await page.getByText(/Confirming your subscription/).waitFor();
    const s = await billing();
    expect(s.hasAccess === false && s.state === 'trial_expired', `access after return: ${s.state}/${s.hasAccess}`);
  });
  await page.setViewportSize(VP.phone);
  await check('[phone] expired: plan cards stack and fit; screenshot', async () => {
    await go('/settings/plan');
    await planReady();
    await noOverflow();
    await shot('09-expired-phone');
  });
  await e.close();

  // ── Unresolved.
  const u = await browser.newContext({ viewport: VP.desktop });
  await signIn(u, F.unres);
  await check('[desktop] unresolved: "Subscription" + "Plan being checked" (never the stored Complete), Contact support, no checkout; AI "Available again with an active plan"', async () => {
    await go('/settings/plan');
    await planReady();
    await page.locator('dd', { hasText: /^Subscription$/ }).waitFor();
    await page.getByText('Plan being checked', { exact: true }).first().waitFor();
    await absent(page.locator('dd', { hasText: /For After (Premium|Complete)/ }), 'the stored tier as active');
    await page.locator('main').getByRole('link', { name: 'Contact support' }).first().waitFor();
    await absent(page.getByRole('button', { name: /secure checkout/i }), 'a checkout button');
    await page.getByText('Available again with an active plan').waitFor();
    await noOverflow();
    await shot('10-unresolved-desktop');
  });
  await u.close();
} finally {
  await browser.close();
}
const passed = results.filter((r) => r.ok).length;
console.log(JSON.stringify({ summary: { checks: results.length, passed, failed: results.length - passed } }));
