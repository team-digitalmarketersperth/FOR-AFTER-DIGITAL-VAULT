// Updated Plans Step 8: customer journeys in a real browser. LOCAL evidence only: isolated `next start` (:3001) +
// isolated API (:4001, api-fake-stripe.mjs: no request reaches Stripe; subscription reads come from FAKE_SUBS_FILE and
// webhooks are signed locally with the fake STRIPE_WEBHOOK_SECRET). Synthetic accounts (browser-seed.mjs). Run through
// scripts/phase24/isolated-env.mjs (DATABASE_URL = the isolated DB). NOT payment evidence. One JSON line per check.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
const fe = createRequire('D:/FOR-AFTER-DIGITAL-VAULT/for-after-frontend/package.json');
const be = createRequire('D:/FOR-AFTER-DIGITAL-VAULT/for-after-backend/package.json');
const { chromium } = fe('playwright');
const Stripe = be('stripe');
const pg = be('pg');

// A path to the seed's JSON (the isolated-env wrapper spawns through a shell, which would strip inline JSON quotes).
const F = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const SUBS_FILE = process.argv[3];
const WHSEC = process.argv[4];
const APP = 'http://localhost:3001';
const API = 'http://localhost:4001/api/v1';
const OUT = new URL('.', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
const SHOTS = `${OUT}/screens`;
mkdirSync(SHOTS, { recursive: true });
const VP = { desktop: { width: 1280, height: 900 }, tablet: { width: 820, height: 1180 }, phone: { width: 390, height: 844 }, zoom200: { width: 640, height: 450 } };
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
if (!/_(p24|test)$/.test(new URL(process.env.DATABASE_URL).pathname)) throw new Error('refusing: not the isolated DB');
await db.connect();

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
const go = (p) => page.goto(`${APP}${p}`, { waitUntil: 'load' });
const planReady = () => page.getByRole('heading', { name: 'What you’re using' }).waitFor();
const chooseReady = () => page.getByRole('heading', { name: 'Choose a plan', level: 1 }).waitFor();
const shot = (name) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
const billing = () => page.evaluate(async (api) => (await fetch(`${api}/billing`, { credentials: 'include' })).json(), API);
const panel = (name) => page.locator('li', { has: page.getByRole('heading', { name, level: 2 }) });
const absent = async (locator, what) => expect((await locator.count()) === 0, `${what} should not be shown`);
const focused = (locator) => locator.evaluate((el) => el === document.activeElement);
const focusVisible = (locator) =>
  locator.evaluate((el) => {
    const s = getComputedStyle(el);
    return (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) || s.boxShadow !== 'none';
  });
const tabTo = async (locator, n = 80) => {
  for (let i = 0; i < n; i++) {
    await page.keyboard.press('Tab');
    if (await focused(locator).catch(() => false)) return;
  }
  throw new Error('not reachable by Tab');
};
// The plan page never holds purchase controls (Step 8).
const noPurchaseControls = async () => {
  await absent(page.getByRole('radio'), 'an interval selector on the plan page');
  await absent(page.getByRole('button', { name: /secure checkout/i }), 'a checkout button on the plan page');
  await absent(page.getByRole('table'), 'a comparison table');
  await absent(page.getByText('Compare everything in each plan'), 'the comparison');
  await absent(page.getByRole('link', { name: /Compare plans/ }), 'an external comparison link (none configured)');
};

// ── Fake Stripe state (file) and locally signed webhooks (fake secret).
const subs = {};
const setSub = (id, customer, status, price) => {
  subs[id] = {
    id, object: 'subscription', customer, status, livemode: false, created: Math.floor(Date.now() / 1000), cancel_at_period_end: false,
    items: { data: [{ price: { id: price }, quantity: 1, current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400 }] },
  };
  writeFileSync(SUBS_FILE, JSON.stringify(subs));
};
const webhook = async (type, object) => {
  const payload = JSON.stringify({ id: `evt_${randomUUID().replace(/-/g, '')}`, object: 'event', type, livemode: false, created: Math.floor(Date.now() / 1000), data: { object } });
  const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: WHSEC });
  const r = await fetch(`${API}/webhooks/stripe`, { method: 'POST', headers: { 'Stripe-Signature': header, 'Content-Type': 'application/json' }, body: payload });
  expect(r.ok, `webhook ${type} → ${r.status} ${await r.text()}`);
};
const customerOf = async (emailAddr) =>
  (await db.query(`SELECT b."stripeCustomerId" c FROM "BillingAccount" b JOIN "User" u ON u.id = b."userId" WHERE u.email = $1`, [emailAddr])).rows[0]?.c;

async function signIn(context, emailAddr) {
  page = context.pages()[0] ?? (await context.newPage());
  page.setDefaultTimeout(30_000);
  await go('/login');
  await page.getByLabel('Email').fill(emailAddr);
  await page.getByLabel('Password', { exact: true }).fill('StrongPassword123!');
  await page.getByRole('button', { name: /^sign in$/i }).click();
  // The API allows 5 sign-ins per minute per IP (unchanged); this run signs in more accounts than that, so a throttled
  // attempt waits out the window once and retries. A wrong password or any other error still fails the check.
  const throttled = page.getByText('Too many attempts. Please try again shortly.');
  const outcome = await Promise.race([
    page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 60_000 }).then(() => 'in'),
    throttled.waitFor({ timeout: 60_000 }).then(() => 'throttled'),
  ]);
  if (outcome === 'throttled') {
    console.log(JSON.stringify({ note: 'login throttled (5/min per IP); waiting 65 s and retrying once' }));
    await page.waitForTimeout(65_000);
    await page.getByLabel('Password', { exact: true }).fill('StrongPassword123!');
    await page.getByRole('button', { name: /^sign in$/i }).click();
    await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 60_000 });
  }
}
const logOut = async () => {
  await page.getByRole('button', { name: /^Account:/ }).click();
  await page.getByRole('menuitem', { name: 'Log out' }).click();
  await page.waitForURL((u) => u.pathname.startsWith('/login'));
};

const browser = await chromium.launch();
try {
  // ── 1. New customer → explicit trial start → trial usage and limits.
  const n = await browser.newContext({ viewport: VP.desktop });
  await signIn(n, F.fresh);
  await check('[desktop] new customer: no trial until started; Start free trial (one click) → Free Trial, 7-day dates, trial limits (0 of 1 person, 0 of 5 AI, 100 MB)', async () => {
    await go('/settings/plan');
    await planReady();
    expect((await billing()).state === 'trial_available', 'a trial existed before the click');
    await noPurchaseControls();
    await page.getByRole('button', { name: 'Start free trial' }).click();
    await page.locator('dt', { hasText: /^Free trial$/ }).waitFor();
    await page.locator('dd', { hasText: /^Free Trial$/ }).waitFor();
    const b = await billing();
    const days = (new Date(b.trial.endsAt) - new Date(b.trial.startedAt)) / 86_400_000;
    expect(b.state === 'trial_active' && Math.abs(days - 7) < 0.001, `trial ${b.state} ${days} days`);
    await page.getByText('0 of 5 replies used').waitFor();
    await page.locator('li', { has: page.getByText('People I Love', { exact: true }) }).getByText('0 of 1').waitFor();
    await page.getByText(/of 100\.0 MB used/).waitFor();
    await absent(page.getByRole('button', { name: 'Start free trial' }), 'a second trial start');
    await noOverflow();
  });
  await n.close();

  // ── 2. Cap reached → dialog → plan page → purchase route; layouts; keyboard; focus.
  const t = await browser.newContext({ viewport: VP.desktop });
  await signIn(t, F.trial);
  await check('[desktop] trial at the people cap: "Premium" lock dialog traps focus, Escape returns it; View plans → plan page → "Choose a plan" → purchase route', async () => {
    await go('/people');
    await page.getByText('1 of 1 person').waitFor();
    const lock = page.getByRole('button', { name: /Add someone you love\s*Premium/ });
    await lock.click();
    const dialog = page.getByRole('dialog');
    await dialog.getByText(/For After Premium includes up to 10 people/).waitFor();
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => !!document.activeElement?.closest('[role=dialog]')), 'focus left the dialog');
    }
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    expect(await focused(lock), 'focus did not return to the lock');
    await lock.click();
    await dialog.getByRole('link', { name: 'View plans' }).click();
    await page.waitForURL((u) => u.pathname === '/settings/plan');
    await planReady();
    await noPurchaseControls();
    await page.getByRole('link', { name: 'Choose a plan' }).click();
    await page.waitForURL((u) => u.pathname === '/settings/plan/choose');
    await chooseReady();
    await panel('For After Complete').getByRole('button', { name: 'Continue to secure checkout' }).waitFor();
    await absent(page.getByRole('heading', { name: 'For After Premium' }), 'unpriced Premium');
  });
  await check('[desktop] trial capabilities: Photos locked "Premium", Video locked "Complete"; written text open', async () => {
    await go('/messages/new');
    await page.getByRole('radio', { name: /Written/ }).waitFor();
    await page.getByRole('button', { name: /Photos[\s\S]*Premium/ }).waitFor();
    await page.getByRole('button', { name: /Video[\s\S]*Complete/ }).waitFor();
  });
  for (const vp of ['desktop', 'tablet', 'phone', 'zoom200']) {
    await page.setViewportSize(VP[vp]);
    await check(`[${vp}] final plan page and purchase route: fit, no page-level horizontal scroll`, async () => {
      await go('/settings/plan');
      await planReady();
      await noOverflow();
      await shot(`plan-trial-${vp}`);
      await go('/settings/plan/choose');
      await chooseReady();
      await panel('For After Complete').waitFor();
      await noOverflow();
      await shot(`choose-trial-${vp}`);
    });
  }
  await page.setViewportSize(VP.desktop);
  await check('[desktop] keyboard: "Choose a plan" link reachable by Tab with visible focus; purchase route interval by arrow keys', async () => {
    await go('/settings/plan');
    await planReady();
    const link = page.getByRole('link', { name: 'Choose a plan' });
    await tabTo(link);
    expect(await focusVisible(link), 'no visible focus on Choose a plan');
    await page.keyboard.press('Enter');
    await page.waitForURL((u) => u.pathname === '/settings/plan/choose');
    const complete = panel('For After Complete');
    const monthly = complete.getByRole('radio', { name: 'Monthly' });
    await monthly.waitFor();
    await monthly.focus();
    expect(await focusVisible(page.locator(':focus').locator('xpath=..')), 'no visible focus on the interval choice');
    await page.keyboard.press('ArrowRight');
    expect(await complete.getByRole('radio', { name: 'Annual' }).isChecked(), 'Annual not chosen by arrow key');
  });
  await t.close();

  // ── 3. Premium and Complete capabilities; tier change keeps the month's AI use.
  const p = await browser.newContext({ viewport: VP.desktop });
  await signIn(p, F.prem);
  await check('[desktop] Premium: plan page has Manage billing and no purchase; purchase route refuses a second subscription; Photos/Voice open, Video locked "Complete"', async () => {
    await go('/settings/plan');
    await planReady();
    await page.locator('dd', { hasText: /^For After Premium/ }).waitFor();
    await page.getByRole('button', { name: 'Manage billing' }).waitFor();
    await absent(page.getByRole('link', { name: 'Choose a plan' }), 'Choose a plan for a subscriber');
    await noPurchaseControls();
    await page.getByText('12 of 50 replies used').waitFor();
    await shot('plan-premium-desktop');
    await go('/settings/plan/choose');
    await page.getByText(/You already have a subscription/).waitFor();
    await absent(page.getByRole('button', { name: /secure checkout/i }), 'a checkout button');
    await go('/messages/new');
    await page.getByRole('radio', { name: /Photos/ }).waitFor();
    await page.getByRole('radio', { name: /Voice/ }).waitFor();
    await page.getByRole('button', { name: /Video[\s\S]*Complete/ }).waitFor();
  });
  await check('[desktop] tier change Premium → Complete (signed fake webhook, real sync): plan page shows Complete; AI keeps this month\'s 12 (12 of 200); 3 of 50 people', async () => {
    setSub(F.sub.prem, F.customer.prem, 'active', 'price_fake_complete_month');
    await webhook('customer.subscription.updated', { id: F.sub.prem, customer: F.customer.prem });
    await go('/settings/plan');
    await planReady();
    await page.locator('dd', { hasText: /^For After Complete/ }).waitFor();
    await page.getByText('12 of 200 replies used').waitFor();
    await page.getByText('3 of 50', { exact: true }).waitFor();
    await go('/messages/new');
    await page.getByRole('radio', { name: /Video/ }).waitFor();
  });
  await p.close();

  const c = await browser.newContext({ viewport: VP.desktop });
  await signIn(c, F.comp);
  await check('[desktop] Complete: video open; nothing to buy; plan page Billed annually', async () => {
    await go('/settings/plan');
    await planReady();
    await page.getByText('Billed annually').waitFor();
    await absent(page.getByRole('link', { name: 'Choose a plan' }), 'Choose a plan');
    await go('/messages/new');
    await page.getByRole('radio', { name: /Video/ }).waitFor();
  });
  await c.close();

  // ── 4. Trial expiry while a form is open; then account switching in the same tab.
  const x = await browser.newContext({ viewport: VP.desktop });
  await signIn(x, F.expiring);
  const TYPED = 'For Sofia, when she starts school';
  await check('[desktop] trial ends while a new message is open: typing is kept, "Not saved to your account", a tab-local copy only, the plan re-read', async () => {
    await go('/messages/new');
    const title = page.getByLabel('Title');
    await title.fill('For Sofia');
    await page.getByText(/Autosaved/).waitFor({ timeout: 45_000 });
    const r = await db.query(`UPDATE "CustomerTrial" SET "endsAt" = (now() AT TIME ZONE 'UTC') - interval '1 second' WHERE "userId" = (SELECT id FROM "User" WHERE email = $1)`, [F.expiring]);
    expect(r.rowCount === 1, 'trial not ended');
    await title.fill(TYPED);
    await page.getByText('Not saved to your account.').first().waitFor({ timeout: 45_000 });
    expect((await title.inputValue()) === TYPED, 'typed text was lost');
    // The tab copy is written 500 ms after the refusal (use-draft-editor), so wait for it rather than read at once.
    await page.waitForFunction(() => Object.keys(sessionStorage).some((k) => k.startsWith('for-after:unsaved:')), null, { timeout: 10_000 });
    const b = await billing();
    expect(b.state === 'trial_expired' && !b.hasAccess, `after expiry: ${b.state}`);
  });
  await check('[desktop] account switching in the same tab: log out → kept copy removed; the next account sees only its own plan and usage', async () => {
    await logOut();
    const left = await page.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith('for-after:unsaved:')));
    expect(left.length === 0, `kept copies survived log out: ${left.length}`);
    await signIn(x, F.comp);
    await go('/settings/plan');
    await planReady();
    await page.locator('dd', { hasText: /^For After Complete/ }).waitFor();
    await absent(page.getByText(/Free trial ended|Free Trial/), "the previous account's trial");
    await go('/messages/new');
    await page.getByLabel('Title').waitFor();
    expect((await page.getByLabel('Title').inputValue()) === '', 'another account\'s draft was offered');
    await absent(page.getByText(TYPED), "the previous account's typed text");
  });
  await x.close();

  // ── 5. Locked (expired): view and delete stay open; fake Checkout cancel / success-before-webhook / confirmed.
  const e = await browser.newContext({ viewport: VP.desktop });
  await signIn(e, F.exp);
  await check('[desktop] expired: memories readable; delete still works; adding is locked; the plan page offers "Choose a plan"', async () => {
    await go('/memory-vault');
    await page.getByText('Sunday pancakes').first().click();
    await page.getByText('Two eggs, a cup of flour, and patience.').waitFor();
    await page.getByRole('button', { name: 'Delete' }).click();
    await page.getByRole('button', { name: 'Delete memory' }).click();
    await page.waitForURL((u) => u.pathname === '/memory-vault');
    await page.getByText('Your Memory Vault is ready when you are').waitFor();
    await absent(page.getByText('Sunday pancakes').filter({ visible: true }), 'the deleted memory');
    await go('/people');
    await page.getByText('Noor').first().waitFor();
    await go('/settings/plan');
    await planReady();
    await page.getByText(/You can still read everything you’ve saved/).waitFor();
    await page.getByRole('link', { name: 'Choose a plan' }).waitFor();
  });
  await check('[desktop] Checkout cancelled: "Nothing was charged"; still locked', async () => {
    await go('/settings/plan?checkout=cancelled');
    await page.getByText('Checkout was cancelled. Nothing was charged.').waitFor();
    const b = await billing();
    expect(b.state === 'trial_expired' && !b.hasAccess, `after cancel: ${b.state}`);
  });
  await check('[desktop] Checkout by keyboard sends only { COMPLETE, annual }; the success URL alone grants nothing; a signed (fake) webhook confirms → "Your subscription is confirmed", access on', async () => {
    await go('/settings/plan/choose');
    await chooseReady();
    const complete = panel('For After Complete');
    await complete.getByRole('radio', { name: 'Monthly' }).focus();
    await page.keyboard.press('ArrowRight');
    const sent = page.waitForRequest((r) => r.url().endsWith('/api/v1/billing/checkout') && r.method() === 'POST');
    await tabTo(complete.getByRole('button', { name: 'Continue to secure checkout' }), 5);
    await page.keyboard.press('Enter');
    const body = JSON.parse((await sent).postData() ?? '{}');
    expect(JSON.stringify(body) === JSON.stringify({ tier: 'COMPLETE', interval: 'annual' }), `checkout body ${JSON.stringify(body)}`);
    await page.waitForURL(/\/settings\/plan\?checkout=success/);
    await page.getByText(/Confirming your subscription/).waitFor();
    let b = await billing();
    expect(b.state === 'trial_expired' && !b.hasAccess, `before the webhook: ${b.state}/${b.hasAccess}`);
    await shot('checkout-pending-desktop');
    const customer = await customerOf(F.exp);
    expect(!!customer, 'no billing account after checkout');
    const sub = `sub_fake_up8_exp_${F.run}`;
    setSub(sub, customer, 'active', 'price_fake_complete_year');
    await webhook('checkout.session.completed', { id: 'cs_fake_up8', customer, subscription: sub });
    await page.getByText('Your subscription is confirmed.').waitFor({ timeout: 40_000 });
    b = await billing();
    expect(b.state === 'paid_active' && b.hasAccess && b.productTier.tier === 'COMPLETE', `after the webhook: ${b.state}`);
  });
  await e.close();

  // ── 6. Unresolved → support → valid synchronization recovery.
  const u = await browser.newContext({ viewport: VP.desktop });
  await signIn(u, F.unres);
  await check('[desktop] unresolved: plan page support note → Contact support opens /support/new; purchase route refuses; a valid (fake) sync recovers to Complete', async () => {
    await go('/settings/plan');
    await planReady();
    await page.getByText('Plan being checked', { exact: true }).first().waitFor();
    await absent(page.getByRole('link', { name: 'Choose a plan' }), 'Choose a plan');
    await shot('plan-unresolved-desktop');
    await go('/settings/plan/choose');
    await page.getByText(/couldn’t match it to one of our plans/).waitFor();
    await absent(page.getByRole('radio'), 'interval choices');
    await page.locator('main').getByRole('link', { name: 'Contact support' }).click();
    await page.waitForURL((u2) => u2.pathname === '/support/new');
    setSub(F.sub.unres, F.customer.unres, 'active', 'price_fake_complete_year');
    await webhook('customer.subscription.updated', { id: F.sub.unres, customer: F.customer.unres });
    await go('/settings/plan');
    await planReady();
    await page.locator('dd', { hasText: /^For After Complete/ }).waitFor();
    await absent(page.getByText('Plan being checked', { exact: true }), 'the unresolved state');
    const b = await billing();
    expect(b.state === 'paid_active' && b.productTier.tier === 'COMPLETE', `after recovery: ${b.state}`);
  });
  await u.close();
} finally {
  await browser.close();
  await db.end();
}
const passed = results.filter((r) => r.ok).length;
console.log(JSON.stringify({ summary: { checks: results.length, passed, failed: results.length - passed } }));
