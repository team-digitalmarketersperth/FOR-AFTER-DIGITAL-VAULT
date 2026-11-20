// Updated Plans Step 6 close-out: the plan page in a real browser at desktop (1280×900) and phone (390×844).
// LOCAL evidence: isolated `next start` (:3001) + isolated API (:4001) with a fake Stripe gateway (api-fake-stripe.mjs).
// No payment, no Stripe page, no webhook: a fake Checkout returns straight to the success URL. One JSON line per check.
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
const billing = () => page.evaluate(async () => (await fetch('http://localhost:4001/api/v1/billing', { credentials: 'include' })).json());
const tierRow = (name) => page.locator('li', { has: page.getByRole('heading', { name }) });
const absent = async (locator, what) => expect((await locator.count()) === 0, `${what} should not be shown`);
// Tab until the element has focus (keyboard only), at most n presses.
const tabTo = async (locator, n = 60) => {
  for (let i = 0; i < n; i++) {
    await page.keyboard.press('Tab');
    if (await locator.evaluate((el) => el === document.activeElement).catch(() => false)) return;
  }
  throw new Error('not reachable by Tab');
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
  // ── Buyer (expired trial): options, keyboard Checkout, pending return, cancelled return, no unlock from the URL.
  const b = await browser.newContext({ viewport: VIEWPORTS.desktop });
  await signIn(b, F.buyer);
  for (const [vp, size] of Object.entries(VIEWPORTS)) {
    await page.setViewportSize(size);
    await check(`[${vp}] configured options are buttons; unpriced Premium says "not available yet"; no price is invented`, async () => {
      await go('/settings/plan');
      await page.getByRole('heading', { name: 'Choose a plan' }).waitFor();
      const complete = tierRow('For After Complete');
      await complete.getByRole('button', { name: 'Monthly' }).waitFor();
      await complete.getByRole('button', { name: 'Annual' }).waitFor();
      const premium = tierRow('For After Premium');
      await premium.getByText('Monthly: not available yet').waitFor();
      await premium.getByText('Annual: not available yet').waitFor();
      await absent(premium.getByRole('button'), 'a Premium button');
      expect(!/\$|AUD/.test(await page.locator('main').innerText()), 'a price is shown');
      await noOverflow();
    });
  }
  await page.setViewportSize(VIEWPORTS.desktop);
  await check('[desktop] keyboard: Tab to Complete Annual and press Enter; the API gets only { tier, interval }; the return shows "Confirming", not success, and nothing unlocks', async () => {
    await go('/settings/plan');
    const annual = tierRow('For After Complete').getByRole('button', { name: 'Annual' });
    await annual.waitFor();
    const sent = page.waitForRequest((r) => r.url().endsWith('/api/v1/billing/checkout') && r.method() === 'POST');
    await tabTo(annual);
    await page.keyboard.press('Enter');
    const body = JSON.parse((await sent).postData() ?? '{}');
    expect(JSON.stringify(body) === JSON.stringify({ tier: 'COMPLETE', interval: 'annual' }), `checkout body ${JSON.stringify(body)}`);
    await page.waitForURL(/\/settings\/plan\?checkout=success/);
    await page.getByText(/Confirming your subscription/).waitFor();
    await absent(page.getByText('Your subscription is confirmed.'), 'a success note');
    const s = await billing();
    expect(s.hasAccess === false && s.state === 'trial_expired' && s.productTier?.tier == null, `access after return: ${s.state}/${s.hasAccess}`);
  });
  await page.setViewportSize(VIEWPORTS.phone);
  await check('[phone] the success query alone unlocks nothing; the pending note fits', async () => {
    await go('/settings/plan?checkout=success');
    await page.getByText(/Confirming your subscription/).waitFor();
    await page.getByText('Free trial ended', { exact: true }).first().waitFor();
    expect((await billing()).hasAccess === false, 'unlocked by the URL');
    await noOverflow();
  });
  await check('[phone] cancelled return: "Nothing was charged", options still offered', async () => {
    await go('/settings/plan?checkout=cancelled');
    await page.getByText('Checkout was cancelled. Nothing was charged.').waitFor();
    await tierRow('For After Complete').getByRole('button', { name: 'Monthly' }).waitFor();
    await noOverflow();
  });
  await b.close();

  // ── Legacy unmapped and mapped Complete wording.
  const l = await browser.newContext({ viewport: VIEWPORTS.desktop });
  await signIn(l, F.legacy);
  await check('[desktop] legacy/unmapped: "Subscribed", interval "Monthly", no tier name, no Choose a plan', async () => {
    await go('/settings/plan');
    await page.getByText('Subscribed', { exact: true }).first().waitFor();
    await page.locator('dd', { hasText: /^Monthly$/ }).waitFor();
    await absent(page.getByText(/For After (Premium|Complete)/), 'a tier name');
    await absent(page.getByRole('heading', { name: 'Choose a plan' }), 'Choose a plan');
  });
  await l.close();
  const c = await browser.newContext({ viewport: VIEWPORTS.phone });
  await signIn(c, F.comp);
  await check('[phone] mapped Complete: "For After Complete, annual"; layout fits', async () => {
    await go('/settings/plan');
    await page.getByText('For After Complete, annual').waitFor();
    await noOverflow();
  });
  await c.close();

  // ── Unresolved: explained, support offered by keyboard, never "buy again".
  const u = await browser.newContext({ viewport: VIEWPORTS.desktop });
  await signIn(u, F.unres);
  for (const [vp, size] of Object.entries(VIEWPORTS)) {
    await page.setViewportSize(size);
    await check(`[${vp}] unresolved: "Plan being checked", the explanation, Contact support (keyboard-reachable), no plan choices or "choose a plan"`, async () => {
      await go('/settings/plan');
      await page.getByText('Plan being checked', { exact: true }).first().waitFor();
      await page.getByText(/couldn’t match it to one of our plans/).waitFor();
      const support = page.locator('main').getByRole('link', { name: 'Contact support' });
      expect((await support.getAttribute('href')) === '/support/new', 'support link target');
      await absent(page.getByRole('heading', { name: 'Choose a plan' }), 'Choose a plan');
      await absent(page.getByText(/Choose a plan to keep|purchase|subscribe again/), 'a buy-again prompt');
      await page.locator('body').click({ position: { x: 1, y: 1 } });
      await tabTo(support);
      await noOverflow();
    });
  }
  await check('[phone] unresolved: a blocked save says why and links to support (API 402 PLAN_UNRESOLVED)', async () => {
    const r = await page.evaluate(async () => {
      const res = await fetch('http://localhost:4001/api/v1/recipients', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ firstName: 'Mia' }) });
      return { status: res.status, body: await res.json() };
    });
    expect(r.status === 402 && r.body.code === 'PLAN_UNRESOLVED' && !/choose a plan/i.test(r.body.message), `402 ${JSON.stringify(r.body)}`);
  });
  await u.close();
} finally {
  await browser.close();
}
const passed = results.filter((r) => r.ok).length;
console.log(JSON.stringify({ summary: { checks: results.length, passed, failed: results.length - passed } }));
