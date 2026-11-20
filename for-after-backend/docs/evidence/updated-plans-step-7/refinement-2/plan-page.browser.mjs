// Step 7 refinement 2 (2026-11-19): Settings → Plan as an account page. LOCAL evidence only: isolated `next start`
// (:3001, NEXT_PUBLIC_PLANS_URL unset) + isolated API (:4001, ../../updated-plans-step-8/api-fake-stripe.mjs: no request
// reaches Stripe). Synthetic accounts (browser-seed.mjs). Run through scripts/phase24/isolated-env.mjs.
// Desktop 1280×900 and phone 390×844, keyboard. One JSON line per check.
import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const fe = createRequire('D:/FOR-AFTER-DIGITAL-VAULT/for-after-frontend/package.json');
const { chromium } = fe('playwright');

const F = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const APP = 'http://localhost:3001';
const API = 'http://localhost:4001/api/v1';
const OUT = new URL('.', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
const SHOTS = `${OUT}/screens`;
mkdirSync(SHOTS, { recursive: true });
const VP = { desktop: { width: 1280, height: 900 }, phone: { width: 390, height: 844 } };

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
const shot = (name) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
const billing = () => page.evaluate(async (api) => (await fetch(`${api}/billing`, { credentials: 'include' })).json(), API);
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
const usageColumns = () =>
  page.locator('section[aria-labelledby="usage"] ul').first().evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);
// No sales content on Settings → Plan, ever.
const noSales = async () => {
  await absent(page.getByRole('radio'), 'an interval selector');
  await absent(page.getByRole('button', { name: /secure checkout/i }), 'a checkout button');
  await absent(page.getByRole('table'), 'a comparison table');
  await absent(page.getByText(/Compare everything in each plan|of storage|replies a month/), 'sales cards or comparison');
  await absent(page.getByRole('link', { name: /Compare plans/ }), 'a Compare plans link (no URL configured)');
  expect(!/unlimited|Most popular|\bAUD\b|\$/i.test(await page.locator('main').innerText()), 'a forbidden claim');
};
// Concise dates: one offset per date, never a long zone name or a start–end range.
const conciseDates = async () => {
  const text = await page.locator('main').innerText();
  expect(!/Standard Time|Daylight Time| to \d{1,2} \w+ 20\d\d/.test(text), 'a long zone name or date range');
};

async function signIn(context, emailAddr) {
  page = context.pages()[0] ?? (await context.newPage());
  page.setDefaultTimeout(30_000);
  await go('/login');
  await page.getByLabel('Email').fill(emailAddr);
  await page.getByLabel('Password', { exact: true }).fill('StrongPassword123!');
  await page.getByRole('button', { name: /^sign in$/i }).click();
  // 5 sign-ins per minute per IP (unchanged): a throttled attempt waits out the window once and retries.
  const outcome = await Promise.race([
    page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 60_000 }).then(() => 'in'),
    page.getByText('Too many attempts. Please try again shortly.').waitFor({ timeout: 60_000 }).then(() => 'throttled'),
  ]);
  if (outcome === 'throttled') {
    console.log(JSON.stringify({ note: 'login throttled (5/min per IP); waiting 65 s and retrying once' }));
    await page.waitForTimeout(65_000);
    await page.getByLabel('Password', { exact: true }).fill('StrongPassword123!');
    await page.getByRole('button', { name: /^sign in$/i }).click();
    await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 60_000 });
  }
}
async function asAccount(name, fn, viewport = VP.desktop) {
  const ctx = await browser.newContext({ viewport });
  await signIn(ctx, F[name]);
  try {
    await fn();
  } finally {
    await ctx.close();
  }
}

const browser = await chromium.launch();
try {
  await asAccount('trial', async () => {
    await check('[desktop] active trial: Free Trial + "Free trial" access; "Trial ends" once, concise with offset; usage in 3 columns; Choose a plan; no sales content', async () => {
      await go('/settings/plan');
      await planReady();
      await page.locator('dd', { hasText: /^Free Trial$/ }).waitFor();
      await page.locator('dt', { hasText: /^Trial ends$/ }).waitFor();
      const ends = await page.locator('dt', { hasText: /^Trial ends$/ }).locator('xpath=following-sibling::dd[1]').innerText();
      expect(/^\d{1,2} \w{3} 20\d\d, \d{1,2}:\d{2}\s[ap]m \(UTC[+-]\d/.test(ends), `trial end "${ends}"`);
      await conciseDates();
      expect((await usageColumns()) === 3, `usage columns at 1280: ${await usageColumns()}`);
      await page.getByText('3 of 5 replies used').waitFor();
      await page.getByText(/of 100\.0 MB used/).waitFor();
      await page.getByRole('link', { name: 'Choose a plan' }).waitFor();
      await noSales();
      await noOverflow();
      await shot('r2-01-trial-desktop');
    });
    await check('[desktop] keyboard: Tab reaches "Choose a plan" with visible focus; Enter opens the purchase route', async () => {
      await go('/settings/plan');
      await planReady();
      const link = page.getByRole('link', { name: 'Choose a plan' });
      await tabTo(link);
      expect(await focusVisible(link), 'no visible focus');
      await page.keyboard.press('Enter');
      await page.waitForURL((u) => u.pathname === '/settings/plan/choose');
      await page.getByRole('heading', { name: 'For After Complete', level: 2 }).waitFor();
    });
    await check('[desktop] usage request failures: storage and AI say "Not available right now" with Try again, never 0; Try again recovers', async () => {
      let fail = true;
      await page.route('**/api/v1/users/me/storage', (r) => (fail ? r.fulfill({ status: 500, body: '{}' }) : r.continue()));
      await page.route('**/api/v1/assistant/usage', (r) => (fail ? r.fulfill({ status: 500, body: '{}' }) : r.continue()));
      await go('/settings/plan');
      await planReady();
      await page.getByText('Not available right now.').nth(1).waitFor({ timeout: 20_000 });
      await absent(page.getByText(/^0 KB of|0 of 5 replies/), 'a zero for an unknown value');
      fail = false;
      await page.getByRole('button', { name: 'Try loading storage again' }).click();
      await page.getByText(/of 100\.0 MB used/).waitFor();
      await page.unrouteAll();
    });
    await check('[desktop] plan request failure: an error with Try again; no assumed plan or zero usage', async () => {
      await page.route('**/api/v1/billing', (r) => r.fulfill({ status: 400, body: '{"message":"down"}' }));
      await go('/settings/plan');
      await page.getByText("We couldn't load this").waitFor({ timeout: 20_000 });
      await page.getByRole('button', { name: /Try again/ }).waitFor();
      await absent(page.locator('dd', { hasText: /Free Trial|Premium|Complete/ }), 'an assumed plan');
      await absent(page.getByRole('heading', { name: 'What you’re using' }), 'usage without a plan');
      await page.unrouteAll();
    });
  });

  await asAccount('trial', async () => {
    await check('[phone] active trial: one usage column; fits; summary readable', async () => {
      await go('/settings/plan');
      await planReady();
      expect((await usageColumns()) === 1, `usage columns at 390: ${await usageColumns()}`);
      await noOverflow();
      await shot('r2-02-trial-phone');
    });
  }, VP.phone);

  await asAccount('exp', async () => {
    await check('[desktop] expired trial: "Trial ended", read-only notice with "View plans" (keyboard) → purchase route; no second button', async () => {
      await go('/settings/plan');
      await planReady();
      await page.locator('dt', { hasText: /^Trial ended$/ }).waitFor();
      const notice = page.locator('[role=status]', { hasText: 'You can still read everything you’ve saved' });
      const view = notice.getByRole('link', { name: 'View plans' });
      await absent(page.getByRole('link', { name: 'Choose a plan' }), 'a second purchase button');
      await noSales();
      await shot('r2-03-expired-desktop');
      await tabTo(view);
      expect(await focusVisible(view), 'no visible focus on View plans');
      await page.keyboard.press('Enter');
      await page.waitForURL((u) => u.pathname === '/settings/plan/choose');
    });
    await check('[desktop] Checkout entry and return: keyboard sends only { COMPLETE, annual }; back on the plan page "Confirming", access unchanged', async () => {
      await go('/settings/plan/choose');
      const complete = page.locator('li', { has: page.getByRole('heading', { name: 'For After Complete', level: 2 }) });
      await complete.getByRole('radio', { name: 'Monthly' }).focus();
      await page.keyboard.press('ArrowRight');
      const sent = page.waitForRequest((r) => r.url().endsWith('/api/v1/billing/checkout') && r.method() === 'POST');
      await tabTo(complete.getByRole('button', { name: 'Continue to secure checkout' }), 5);
      await page.keyboard.press('Enter');
      const body = JSON.parse((await sent).postData() ?? '{}');
      expect(JSON.stringify(body) === JSON.stringify({ tier: 'COMPLETE', interval: 'annual' }), `body ${JSON.stringify(body)}`);
      await page.waitForURL(/\/settings\/plan\?checkout=success/);
      await page.getByText(/Confirming your subscription/).waitFor();
      const b = await billing();
      expect(b.state === 'trial_expired' && !b.hasAccess, `after return: ${b.state}`);
      await go('/settings/plan?checkout=cancelled');
      await page.getByText('Checkout was cancelled. Nothing was charged.').waitFor();
    });
  });

  await asAccount('expiring', async () => {
    await check('[desktop] typed content kept when the trial ends mid-form (unchanged behaviour)', async () => {
      await go('/messages/new');
      const title = page.getByLabel('Title');
      await title.fill('For Sofia');
      await page.getByText(/Autosaved/).waitFor({ timeout: 45_000 });
      await page.evaluate(() => null);
      const pg = createRequire('D:/FOR-AFTER-DIGITAL-VAULT/for-after-backend/package.json')('pg');
      const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
      await db.connect();
      await db.query(`UPDATE "CustomerTrial" SET "endsAt" = (now() AT TIME ZONE 'UTC') - interval '1 second' WHERE "userId" = (SELECT id FROM "User" WHERE email = $1)`, [F.expiring]);
      await db.end();
      await title.fill('For Sofia, when she starts school');
      await page.getByText('Not saved to your account.').first().waitFor({ timeout: 45_000 });
      expect((await title.inputValue()) === 'For Sofia, when she starts school', 'typed text was lost');
    });
  });

  await asAccount('prem', async () => {
    await check('[desktop] Premium: "Billed monthly", "Renews" concise; Manage billing works (fake portal returns here); no Choose/Compare', async () => {
      await go('/settings/plan');
      await planReady();
      await page.locator('dd', { hasText: /^For After Premium/ }).waitFor();
      await page.getByText('Billed monthly').waitFor();
      await page.locator('dt', { hasText: /^Renews$/ }).waitFor();
      await conciseDates();
      await page.getByText('12 of 50 replies used').waitFor();
      await absent(page.getByRole('link', { name: 'Choose a plan' }), 'Choose a plan for a subscriber');
      await noSales();
      await shot('r2-04-premium-desktop');
      await page.getByRole('button', { name: 'Manage billing' }).click();
      await page.waitForLoadState('load');
      await planReady();
      expect(new URL(page.url()).pathname === '/settings/plan', `after Manage billing: ${page.url()}`);
    });
  });
  await asAccount('prem', async () => {
    await check('[phone] Premium fits; one usage column', async () => {
      await go('/settings/plan');
      await planReady();
      expect((await usageColumns()) === 1, 'usage columns on phone');
      await noOverflow();
      await shot('r2-05-premium-phone');
    });
  }, VP.phone);

  await asAccount('comp', async () => {
    await check('[desktop] Complete: "Billed annually"; nothing to buy', async () => {
      await go('/settings/plan');
      await planReady();
      await page.locator('dd', { hasText: /^For After Complete/ }).waitFor();
      await page.getByText('Billed annually').waitFor();
      await absent(page.getByRole('link', { name: 'Choose a plan' }), 'Choose a plan');
      await noSales();
    });
  });

  await asAccount('cancel', async () => {
    await check('[desktop] cancel at period end: "Access ends" + "won’t renew… keep full access"; access still active', async () => {
      await go('/settings/plan');
      await planReady();
      await page.locator('dt', { hasText: /^Access ends$/ }).waitFor();
      await page.getByText(/won’t renew. You keep full access until the date above/).waitFor();
      expect((await billing()).hasAccess === true, 'access lost before period end');
      await absent(page.getByText(/has ended|You can still read everything/), 'an ended-access message');
      await noSales();
      await shot('r2-06-cancelling-desktop');
    });
  });

  await asAccount('ended', async () => {
    await check('[desktop] ended paid access: read-only notice (read, nothing deleted) with "View plans"', async () => {
      await go('/settings/plan');
      await planReady();
      const notice = page.locator('[role=status]', { hasText: 'You can still read everything you’ve saved' });
      await notice.getByRole('link', { name: 'View plans' }).waitFor();
      expect((await billing()).hasAccess === false, 'ended account has access');
      await noSales();
    });
  });

  await asAccount('legacy', async () => {
    await check('[desktop] legacy/unmapped: "Subscription" · Monthly, "4 added" with no bar, AI "Not counted", never "unlimited"', async () => {
      await go('/settings/plan');
      await planReady();
      await page.locator('dd', { hasText: /^Subscription/ }).waitFor();
      await page.getByText('4 added').waitFor();
      await page.getByText('Not counted on your account').waitFor();
      await absent(page.getByRole('link', { name: 'Choose a plan' }), 'Choose a plan');
      await noSales();
      await shot('r2-07-legacy-desktop');
    });
  });

  await asAccount('exempt', async () => {
    // Run 1 expected no "Choose a plan" here; that was this script's assumption, not the requirement ("do not invent a
    // purchased plan"). The button is unchanged behaviour (Step 7 cards and Step 8 route offered checkout to exempt
    // accounts; the API accepts it). Whether to invite them is the open grandfathered-subscription policy: recorded.
    await check('[desktop] exempt (grandfathered): "Your current access", no invented plan, no sales content; "Choose a plan" recorded (open policy)', async () => {
      await go('/settings/plan');
      await planReady();
      await page.getByText('Your account isn’t on a plan and keeps its current access.').waitFor();
      await absent(page.locator('dd', { hasText: /Free Trial|Premium|Complete/ }), 'an invented plan');
      await page.getByText('Not counted on your account').waitFor();
      console.log(JSON.stringify({ note: `exempt account: Choose a plan shown = ${(await page.getByRole('link', { name: 'Choose a plan' }).count()) > 0}` }));
      await noSales();
      await shot('r2-09-exempt-desktop');
    });
  });

  await asAccount('unres', async () => {
    await check('[desktop] unresolved: Contact support first; never Choose a plan or Compare plans', async () => {
      await go('/settings/plan');
      await planReady();
      await page.getByText('Plan being checked', { exact: true }).first().waitFor();
      await page.locator('main').getByRole('link', { name: 'Contact support' }).first().waitFor();
      await absent(page.getByRole('link', { name: /Choose a plan|View plans/ }), 'a purchase prompt');
      await noSales();
      await shot('r2-08-unresolved-desktop');
    });
  });
} finally {
  await browser.close();
}
const passed = results.filter((r) => r.ok).length;
console.log(JSON.stringify({ summary: { checks: results.length, passed, failed: results.length - passed } }));
