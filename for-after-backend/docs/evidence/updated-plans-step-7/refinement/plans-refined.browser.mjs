// Step 7 REFINEMENT (2026-11-19): no sales cards or comparison; one config-gated Compare plans link; Checkout kept.
// Same isolated setup as ../plans.browser.mjs (next start :3001, fake-Stripe API :4001, synthetic accounts from
// ../browser-seed.mjs). Screenshots go to ./screens.
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

const noSales = async () => {
  await absent(page.getByText('Compare everything in each plan'), 'the expandable comparison');
  await absent(page.getByRole('table'), 'a comparison table');
  await absent(page.getByRole('heading', { name: 'Free Trial', level: 3 }), 'a Free Trial sales card');
  await absent(page.getByText(/of storage|replies a month|Every My Story and My Wishes question/), 'card feature lists');
  // NEXT_PUBLIC_PLANS_URL is unset in this build (no verified marketing URL): no link at all, never a broken one.
  await absent(page.getByRole('link', { name: 'Compare plans' }), 'a Compare plans link without a configured URL');
};
const CHOOSE = () => page.getByRole('heading', { name: 'Choose a plan', level: 2 });

const browser = await chromium.launch();
try {
  const t = await browser.newContext({ viewport: VP.desktop });
  await signIn(t, F.trial);
  await check('[desktop] active trial: summary + usage; no sales cards/comparison/link; "Choose a plan" offers only Complete (Premium unpriced) with Checkout', async () => {
    await go('/settings/plan');
    await planReady();
    await page.locator('dd', { hasText: /^Free Trial$/ }).waitFor();
    await page.getByText('3 of 5 replies used').waitFor();
    await noSales();
    await CHOOSE().waitFor();
    await card('For After Complete').getByRole('button', { name: 'Continue to secure checkout' }).waitFor();
    await absent(page.getByRole('heading', { name: 'For After Premium', level: 3 }), 'unpriced Premium');
    expect(!/unlimited|Most popular|\bAUD\b|\$/i.test(await page.locator('main').innerText()), 'forbidden claim on the page');
    await noOverflow();
    await shot('r01-trial-desktop');
  });
  await page.setViewportSize(VP.phone);
  await check('[phone] active trial plan page fits; no horizontal scroll', async () => {
    await go('/settings/plan');
    await planReady();
    await noOverflow();
    await shot('r02-trial-phone');
  });
  await page.setViewportSize(VP.desktop);
  await check('[desktop] trial-cap lock dialog: "View plans" still navigates to /settings/plan, which loads with the Checkout entry', async () => {
    await go('/people');
    await page.getByText('1 of 1 person').waitFor();
    await page.getByRole('button', { name: /Add someone you love\s*Premium/ }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('link', { name: 'View plans' }).click();
    await page.waitForURL((u) => u.pathname === '/settings/plan');
    await planReady();
    await CHOOSE().waitFor();
  });
  await t.close();

  const p = await browser.newContext({ viewport: VP.desktop });
  await signIn(p, F.prem);
  await check('[desktop] Premium: name, Billed monthly, Manage billing; no purchase section, no checkout, no cards', async () => {
    await go('/settings/plan');
    await planReady();
    await page.locator('dd', { hasText: /^For After Premium/ }).waitFor();
    await page.getByText('Billed monthly').waitFor();
    await page.getByRole('button', { name: 'Manage billing' }).waitFor();
    await absent(CHOOSE(), 'Choose a plan for a subscriber');
    await absent(page.getByRole('button', { name: /secure checkout|Upgrade/i }), 'a purchase/upgrade button');
    await noSales();
    await page.getByText('3 of 10', { exact: true }).waitFor();
    await noOverflow();
    await shot('r03-premium-desktop');
  });
  await page.setViewportSize(VP.phone);
  await check('[phone] Premium plan page fits', async () => {
    await go('/settings/plan');
    await planReady();
    await noOverflow();
    await shot('r04-premium-phone');
  });
  await p.close();

  const c = await browser.newContext({ viewport: VP.desktop });
  await signIn(c, F.comp);
  await check('[desktop] Complete annual: name, Billed annually; nothing to buy; no cards', async () => {
    await go('/settings/plan');
    await planReady();
    await page.locator('dd', { hasText: /^For After Complete/ }).waitFor();
    await page.getByText('Billed annually').waitFor();
    await absent(CHOOSE(), 'Choose a plan');
    await noSales();
    await shot('r05-complete-desktop');
  });
  await c.close();

  const e = await browser.newContext({ viewport: VP.desktop });
  await signIn(e, F.exp);
  await check('[desktop] expired: read-only note; arrow keys pick Annual; Tab + Enter sends only { COMPLETE, annual }; return shows "Confirming", access stays locked', async () => {
    await go('/settings/plan');
    await planReady();
    await page.getByText(/You can still read everything you’ve saved/).waitFor();
    await noSales();
    await shot('r06-expired-desktop');
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
  await check('[phone] expired: Checkout entry fits the phone width', async () => {
    await go('/settings/plan');
    await planReady();
    await card('For After Complete').getByRole('button', { name: 'Continue to secure checkout' }).waitFor();
    await noOverflow();
    await shot('r07-expired-phone');
  });
  await e.close();

  const u = await browser.newContext({ viewport: VP.desktop });
  await signIn(u, F.unres);
  await check('[desktop] unresolved: Subscription + Plan being checked, Contact support, no purchase or cards', async () => {
    await go('/settings/plan');
    await planReady();
    await page.locator('dd', { hasText: /^Subscription$/ }).waitFor();
    await page.getByText('Plan being checked', { exact: true }).first().waitFor();
    await page.locator('main').getByRole('link', { name: 'Contact support' }).first().waitFor();
    await absent(CHOOSE(), 'Choose a plan');
    await absent(page.getByRole('button', { name: /secure checkout/i }), 'a checkout button');
    await noSales();
    await noOverflow();
    await shot('r08-unresolved-desktop');
  });
  await u.close();
} finally {
  await browser.close();
}
const passed = results.filter((r) => r.ok).length;
console.log(JSON.stringify({ summary: { checks: results.length, passed, failed: results.length - passed } }));
