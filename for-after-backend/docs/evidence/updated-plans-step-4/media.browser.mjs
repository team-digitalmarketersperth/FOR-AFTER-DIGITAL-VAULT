// Updated Plans Step 4 in a real browser at desktop (1280×900) and phone (390×844): isolated `next start` (:3001,
// production build of the current source) against the isolated API (:4001, test DB, Redis :6390, email disabled,
// SMS/Stripe/Observe blanked). Synthetic accounts from browser-seed.mjs. One JSON line per check, then a summary.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire('D:/FOR-AFTER-DIGITAL-VAULT/for-after-frontend/package.json');
const { chromium } = require('playwright');

const F = JSON.parse(process.argv[2]);
const APP = 'http://localhost:3001';
const OUT = new URL('.', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
const TITLE = 'Video is part of For After Complete';
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
  execFileSync('node', ['scripts/phase24/isolated-env.mjs', '--', 'node', `${OUT}/browser-seed.mjs`, args[0], F.run, ...args.slice(1)], { cwd: 'D:/FOR-AFTER-DIGITAL-VAULT/for-after-backend', stdio: 'ignore' });

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
  const ctx = await browser.newContext({ viewport: VIEWPORTS.desktop });
  await signIn(ctx, F.prem);
  for (const [vp, size] of Object.entries(VIEWPORTS)) {
    await page.setViewportSize(size);
    await check(`[${vp}] Premium message media: photo/audio normal; "Add a video" shows Complete, opens the dialog (keyboard), Escape returns focus`, async () => {
      await go(`/messages/${F.premMixed}`);
      await page.getByRole('button', { name: 'Add a photo' }).waitFor();
      const video = page.getByRole('button', { name: /Add a video\s*Complete/ });
      await video.focus();
      await page.keyboard.press('Enter');
      const dialog = page.getByRole('dialog', { name: TITLE });
      await dialog.waitFor();
      expect((await dialog.getByRole('link', { name: 'View plans' }).getAttribute('href')) === '/settings/plan', 'View plans');
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'hidden' });
      await page.waitForFunction(() => /Add a video/.test(document.activeElement?.textContent ?? ''), null, { timeout: 5000 });
      expect((await page.getByRole('button', { name: /Record a video\s*Complete/ }).count()) === 1, 'record video not marked');
      await noOverflow();
    });
    await check(`[${vp}] new message: Video shows Complete; closing the dialog keeps the typed title`, async () => {
      await go('/messages/new');
      await page.getByLabel('Title').fill('Typed before the dialog');
      await page.getByRole('button', { name: /Video\s*Complete/ }).click();
      const dialog = page.getByRole('dialog', { name: TITLE });
      await dialog.getByRole('button', { name: 'Close' }).click();
      await dialog.waitFor({ state: 'hidden' });
      expect((await page.getByLabel('Title').inputValue()) === 'Typed before the dialog', 'title lost');
      await noOverflow();
    });
    await check(`[${vp}] story → message: the photo is a checkbox; the video shows "Copy this video" Complete instead`, async () => {
      await go(`/my-story/${F.story}/create-message`);
      const content = page.getByRole('group', { name: 'Story content' });
      await content.getByRole('checkbox', { name: /platform\.jpg/ }).waitFor();
      expect((await content.getByRole('checkbox', { name: /train\.mp4/ }).count()) === 0, 'video selectable');
      expect(await content.getByRole('button', { name: /Copy this video\s*Complete/ }).isVisible(), 'Complete control');
      await noOverflow();
    });
  }
  await page.setViewportSize(VIEWPORTS.desktop);
  await check('[desktop] My Story workspace: "Add a video" shows Complete beside Add media', async () => {
    await go('/my-story');
    await page.getByRole('button', { name: /Add a video\s*Complete/ }).first().waitFor();
    expect(await page.getByRole('button', { name: 'Add media' }).first().isVisible(), 'Add media');
  });
  await check('[desktop] editing the text of a VIDEO message keeps its existing video (not a new attachment)', async () => {
    await go(`/messages/${F.premVideo}/edit`);
    const title = page.getByLabel('Title');
    await title.fill('A video from before, renamed');
    await page.getByRole('button', { name: /^Save/ }).first().click();
    await page.waitForURL(`${APP}/messages/${F.premVideo}`);
    await page.getByRole('heading', { name: 'A video from before, renamed' }).waitFor();
    await page.getByRole('button', { name: 'Remove kept.mp4' }).waitFor();
  });
  await check('[desktop] an existing video stays listed and can be removed', async () => {
    await go(`/messages/${F.premVideo}`);
    await page.getByRole('button', { name: 'Remove kept.mp4' }).click();
    await page.getByRole('dialog').getByRole('button', { name: /Remove|Delete/ }).click();
    await page.getByRole('button', { name: 'Remove kept.mp4' }).waitFor({ state: 'detached' });
  });
  await check('[desktop] a direct API request bypassing the UI is refused (TIER_REQUIRED, Complete)', async () => {
    const res = await page.evaluate(async (id) => {
      const r = await fetch(`http://localhost:4001/api/v1/messages/${id}/media/upload-url`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'VIDEO', mimeType: 'video/mp4', sizeBytes: 1000, originalFileName: 'x.mp4' }),
      });
      return { status: r.status, body: await r.json() };
    }, F.premMixed);
    expect(res.status === 409 && res.body.code === 'TIER_REQUIRED' && res.body.requiredTier === 'COMPLETE', JSON.stringify(res));
  });
  await ctx.close();

  const comp = await browser.newContext({ viewport: VIEWPORTS.phone });
  await signIn(comp, F.comp);
  await check('[phone] Complete: the normal video controls, no Complete mark', async () => {
    await go(`/messages/${F.compMixed}`);
    await page.getByRole('button', { name: 'Add a video' }).waitFor();
    expect((await page.getByText('Complete', { exact: true }).count()) === 0, 'Complete mark shown');
    await noOverflow();
  });
  await check('[phone] a stale page refused by the server (plan changed to Premium): the message, View plans, and the typed title kept', async () => {
    await go('/messages/new');
    await page.getByRole('radio', { name: /Video/ }).check();
    await page.getByRole('checkbox', { name: /Sofia/ }).check();
    await page.getByLabel('Title').fill('Typed before the refusal');
    seed('tier', 'comp', 'PREMIUM');
    try {
      await page.getByRole('button', { name: 'Save draft' }).click();
      await page.getByText('Video is available with For After Complete. Your plan includes photos and audio.').waitFor();
      expect((await page.getByRole('link', { name: 'View plans' }).count()) > 0, 'View plans');
      expect((await page.getByLabel('Title').inputValue()) === 'Typed before the refusal', 'title lost');
      expect(new URL(page.url()).pathname === '/messages/new', 'navigated away');
      await noOverflow();
    } finally {
      seed('tier', 'comp', 'COMPLETE');
    }
  });
  await comp.close();
  const trial = await browser.newContext({ viewport: VIEWPORTS.phone });
  await signIn(trial, F.trial);
  await check('[phone] trial: unchanged, video shows Pro (not Complete); no overflow', async () => {
    await go(`/messages/${F.trialMixed}`);
    await page.getByRole('button', { name: /Add a video\s*Pro/ }).waitFor();
    expect((await page.getByText('Complete', { exact: true }).count()) === 0, 'Complete mark shown to a trial');
    await noOverflow();
  });
  await trial.close();
} finally {
  await browser.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(JSON.stringify({ summary: { checks: results.length, passed: results.length - failed, failed } }));
  process.exitCode = failed ? 1 : 0;
}
