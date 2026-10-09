import type { APIRequestContext, Page } from '@playwright/test';
import { expect, test } from './imagekit';
import fs from 'node:fs';
import { API, emailFromLog, freshTotp, newAccount, PNG, registerViaApi, signIn, WAV } from './helpers';
import { messageMediaFileIds } from './imagekit';

// Step 19: Recipient and Trusted Contact portals, Customer safety banner.
// Customer B (vault.setup.ts) owns the fictional test data here.
//
// OTP codes exist only in the API's console in development ([DEV ONLY] ...).
// The OTP flows run when E2E_BACKEND_LOG points at a file the backend's output
// is teed into, e.g. `npm run start:dev | tee backend.log`; the test harness
// reads the code from it, as a developer would. The UI never sees it.
const LOG = process.env.E2E_BACKEND_LOG;
const RUN = Date.now();

test.use({ storageState: 'e2e/.auth/b.json' });

async function codeFromLog(label: 'Recipient' | 'Trusted Contact', email: string, from: number) {
  const kind = label === 'Recipient' ? 'recipient-otp' : 'trusted-contact-otp';
  return (await emailFromLog(LOG!, kind, email, from)).match(/Your sign-in code is (\d{6})/)![1];
}

// Optional: when the API on :4000 runs in a terminal you can't tee, start a second
// instance on the same database and Redis with its output in E2E_BACKEND_LOG and
// set E2E_OTP_API to its origin (e.g. http://localhost:4001). Only the code request
// goes there; challenges and sessions live in the shared Redis.
const OTP_API = process.env.E2E_OTP_API;

async function signInWithCode(page: Page, portal: 'recipient' | 'trusted-contact', email: string) {
  if (OTP_API) {
    await page.route('**/*-auth/request-otp', (route) =>
      route.continue({ url: route.request().url().replace(new URL(API).origin, OTP_API) }),
    );
  }
  const from = fs.statSync(LOG!).size;
  await page.goto(`/${portal}/sign-in`);
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Send me a code' }).click();
  await expect(page.getByLabel('6-digit code')).toBeVisible();
  const code = await codeFromLog(portal === 'recipient' ? 'Recipient' : 'Trusted Contact', email, from);
  await page.getByLabel('6-digit code').fill(code);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

const status = async (request: APIRequestContext, path: string) => (await request.get(`${API}${path}`)).status();

test('a Customer session alone opens neither portal', async ({ page }) => {
  expect(await status(page.request, '/auth/me')).toBe(200);
  for (const path of ['/recipient-auth/me', '/recipient/messages', '/trusted-contact-auth/me', '/trusted-contact/accounts']) {
    expect(await status(page.request, path), path).toBe(401);
  }
  await page.goto('/recipient/messages');
  await expect(page).toHaveURL(/\/recipient\/sign-in$/);
  await page.goto('/trusted-contact/accounts');
  await expect(page).toHaveURL(/\/trusted-contact\/sign-in$/);
});

test('sign-in never reveals whether an email has access', async ({ page }) => {
  await page.goto('/recipient/sign-in');
  await expect(page.getByRole('heading', { name: /Messages shared with you/ })).toBeVisible();
  await page.getByLabel('Email').fill(`nobody-${RUN}@example.com`);
  await page.getByRole('button', { name: 'Send me a code' }).click();
  await expect(page.getByText('If released content is available for this email, a verification code has been sent.')).toBeVisible();
  await expect(page.getByLabel('6-digit code')).toBeVisible();
});

test.describe('with the dev OTP log', () => {
  test.skip(!LOG, 'Set E2E_BACKEND_LOG to the backend output file to run the OTP flows.');

  test('Trusted Contact: sign in → accounts → death report → status; Customer confirms alive', async ({ page, browser }) => {
    const email = `david@tc-${RUN}.example.com`;
    const created = await page.request.post(`${API}/trusted-contacts`, { data: { firstName: 'David', relationship: 'Brother', email } });
    expect(created.status()).toBe(201);
    const tc = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const tcPage = await tc.newPage();

    await signInWithCode(tcPage, 'trusted-contact', email);
    await expect(tcPage).toHaveURL(/\/trusted-contact\/accounts$/);
    await expect(tcPage.getByText(/a report never releases any messages/)).toBeVisible();
    await tcPage.getByRole('link', { name: /Bruno/ }).click();
    await expect(tcPage.getByRole('heading', { name: 'No report submitted' })).toBeVisible();
    await tcPage.getByRole('link', { name: 'Submit a death report' }).click();

    // Fictional test data only.
    await tcPage.getByLabel(/^Note for the For After team/).fill('E2E test report. Fictional.');
    await tcPage.getByRole('button', { name: 'Submit report' }).click();
    await expect(tcPage.getByText('Please confirm you understand before submitting.')).toBeVisible();
    await tcPage.getByRole('checkbox').check();
    await tcPage.getByRole('button', { name: 'Submit report' }).click();
    await expect(tcPage.getByText('Your report has been submitted for verification')).toBeVisible();
    await expect(tcPage.getByText('You submitted a report for this account.')).toBeVisible();
    await expect(tcPage.getByRole('link', { name: 'Submit a death report' })).toHaveCount(0);

    // The Trusted Contact cookie opens nothing else.
    expect(await status(tcPage.request, '/recipient/messages')).toBe(401);
    expect(await status(tcPage.request, '/messages')).toBe(401);

    // The account holder sees the calm banner and closes the case.
    await page.goto('/dashboard');
    const banner = page.getByRole('region', { name: /received a report about your account/ });
    await expect(banner).toBeVisible();
    await banner.getByRole('button', { name: "I'm still alive" }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Yes, close the report' }).click();
    await expect(banner).toHaveCount(0);
    expect((await (await page.request.get(`${API}/death-verification/me`)).json()).status).toBe('CANCELLED');

    await tcPage.reload();
    await expect(tcPage.getByRole('heading', { name: 'Case closed' })).toBeVisible();
    await tcPage.getByRole('button', { name: 'Sign out' }).click();
    await expect(tcPage).toHaveURL(/\/trusted-contact\/sign-in$/);
    expect(await status(tcPage.request, '/trusted-contact/accounts')).toBe(401);
    await tc.close();
  });

  test('Recipient: only released, granted messages; read; sign out', async ({ page, browser }) => {
    test.setTimeout(6 * 60_000); // waits for a real FIXED_DATE release
    const email = `sofia@rc-${RUN}.example.com`;
    const recipient = await (await page.request.post(`${API}/recipients`, { data: { firstName: 'Sofia', email } })).json();
    const make = async (title: string) =>
      (await page.request.post(`${API}/messages`, { data: { title, textContent: `Dear Sofia,\n\n${title}.`, recipientIds: [recipient.id] } })).json();
    const released = await make('Released letter');
    const scheduled = await make('Scheduled letter');
    await make('Draft letter');
    const logStart = fs.statSync(LOG!).size;
    const soon = new Date(Date.now() + 70_000).toISOString();
    expect((await page.request.post(`${API}/messages/${released.id}/schedule`, { data: { triggerType: 'FIXED_DATE', scheduledFor: soon } })).status()).toBe(201);
    expect((await page.request.post(`${API}/messages/${scheduled.id}/schedule`, { data: { triggerType: 'ON_DEATH' } })).status()).toBe(201);
    await expect
      .poll(async () => (await (await page.request.get(`${API}/messages/${released.id}`)).json()).status, { timeout: 4 * 60_000, intervals: [5_000] })
      .toBe('RELEASED');
    // Step 24: the release queued one minimal "a message is waiting" email,
    // with a sign-in link and nothing of the message itself.
    const notice = await emailFromLog(LOG!, 'message-released', email, logStart);
    expect(notice).toContain('A message is waiting for you');
    expect(notice).toContain('/recipient/sign-in');
    expect(notice).not.toContain('Released letter');

    const rc = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const rcPage = await rc.newPage();
    await signInWithCode(rcPage, 'recipient', email);
    await expect(rcPage).toHaveURL(/\/recipient\/messages$/);
    await expect(rcPage.getByRole('link', { name: /Released letter/ })).toBeVisible();
    await expect(rcPage.getByText('Scheduled letter')).toHaveCount(0);
    await expect(rcPage.getByText('Draft letter')).toHaveCount(0);
    expect(await status(rcPage.request, `/recipient/messages/${scheduled.id}`)).toBe(404);

    await rcPage.getByRole('link', { name: /Released letter/ }).click();
    await expect(rcPage.getByText('Released letter.')).toBeVisible();
    await rcPage.reload(); // session is the cookie + Redis, not page state
    await expect(rcPage.getByText('Released letter.')).toBeVisible();

    expect(await status(rcPage.request, '/trusted-contact/accounts')).toBe(401);
    expect(await status(rcPage.request, '/messages')).toBe(401);

    await rcPage.getByRole('button', { name: 'Sign out' }).click();
    await expect(rcPage).toHaveURL(/\/recipient\/sign-in$/);
    expect(await status(rcPage.request, '/recipient/messages')).toBe(401);
    await rc.close();
  });

  test('Recipient: a released VIDEO plays from a short-lived signed URL; an unreleased one stays hidden (Phase 12)', async ({
    page,
    browser,
    imagekitFiles,
  }) => {
    test.setTimeout(6 * 60_000); // waits for a real FIXED_DATE release
    const email = `vera@rc-${RUN}.example.com`;
    const recipient = await (await page.request.post(`${API}/recipients`, { data: { firstName: 'Vera', email } })).json();
    const video = fs.readFileSync('e2e/fixtures/synthetic-video.webm');
    // A VIDEO draft with one verified video: upload auth → direct ImageKit
    // upload (as the browser does) → complete.
    const videoMessage = async (title: string) => {
      const message = await (
        await page.request.post(`${API}/messages`, { data: { title, contentType: 'VIDEO', recipientIds: [recipient.id] } })
      ).json();
      const target = await (
        await page.request.post(`${API}/messages/${message.id}/media/upload-url`, {
          data: { kind: 'VIDEO', originalFileName: 'hello.webm', mimeType: 'video/webm', sizeBytes: video.length },
        })
      ).json();
      const uploaded = await page.request.post(target.upload.url, {
        multipart: { ...target.upload.fields, file: { name: 'hello.webm', mimeType: 'video/webm', buffer: video } },
      });
      expect(uploaded.status()).toBe(200);
      const { fileId } = await uploaded.json();
      imagekitFiles.add(fileId); // page.request: no browser event to track
      const done = await page.request.post(`${API}/messages/${message.id}/media/${target.mediaAssetId}/complete`, {
        data: { providerFileId: fileId },
      });
      expect(done.status()).toBe(200);
      return { id: message.id as string, mediaId: target.mediaAssetId as string };
    };
    const released = await videoMessage('Released video');
    const held = await videoMessage('Unreleased video');
    const soon = new Date(Date.now() + 70_000).toISOString();
    expect((await page.request.post(`${API}/messages/${released.id}/schedule`, { data: { triggerType: 'FIXED_DATE', scheduledFor: soon } })).status()).toBe(201);
    expect((await page.request.post(`${API}/messages/${held.id}/schedule`, { data: { triggerType: 'ON_DEATH' } })).status()).toBe(201);
    await expect
      .poll(async () => (await (await page.request.get(`${API}/messages/${released.id}`)).json()).status, { timeout: 4 * 60_000, intervals: [5_000] })
      .toBe('RELEASED');

    const rc = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const rcPage = await rc.newPage();
    await signInWithCode(rcPage, 'recipient', email);
    await rcPage.getByRole('link', { name: /Released video/ }).click();
    await rcPage.getByRole('button', { name: 'Watch' }).click();
    const player = rcPage.getByLabel('Play hello.webm');
    await expect(player).toHaveAttribute('src', /ik-s=.+/);
    await expect.poll(() => player.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThan(0);
    // The unreleased video: no message, no media list, no signed URL.
    await expect(rcPage.getByText('Unreleased video')).toHaveCount(0);
    expect(await status(rcPage.request, `/recipient/messages/${held.id}/media`)).toBe(404);
    expect(await status(rcPage.request, `/recipient/messages/${held.id}/media/${held.mediaId}/access-url`)).toBe(404);
    await rc.close();
  });
});

// Phase 13B. A memory with text, a photo and a recording (real ImageKit
// uploads) becomes a separate MIXED message in the UI; the API copies the
// files. The message is released for real and the Recipient reads it; the
// memory is then edited and deleted, and the message stays as it was.
test('Memory → Message: copy text + media, release, Recipient reads it; the memory stays private and independent', async ({
  page,
  browser,
  imagekitFiles,
}) => {
  test.skip(!LOG, 'Set E2E_BACKEND_LOG to the backend output file to run the OTP flows.');
  test.setTimeout(7 * 60_000); // waits for a real FIXED_DATE release
  const email = `mira@rc-${RUN}.example.com`;
  expect((await page.request.post(`${API}/recipients`, { data: { firstName: 'Mira', email } })).status()).toBe(201);
  const memory = await (
    await page.request.post(`${API}/memory-vault`, {
      data: { title: `Lake house ${RUN}`, category: 'FAMILY', textContent: 'Original memory text.', tags: ['Private tag'] },
    })
  ).json();
  // Upload auth → direct ImageKit upload (as the browser does) → complete.
  const add = async (kind: 'PHOTO' | 'AUDIO', name: string, mimeType: string, buffer: Buffer) => {
    const base = `${API}/memory-vault/${memory.id}/media`;
    const target = await (await page.request.post(`${base}/upload-url`, { data: { kind, originalFileName: name, mimeType, sizeBytes: buffer.length } })).json();
    const uploaded = await page.request.post(target.upload.url, { multipart: { ...target.upload.fields, file: { name, mimeType, buffer } } });
    expect(uploaded.status()).toBe(200);
    const { fileId } = await uploaded.json();
    imagekitFiles.add(fileId);
    expect((await page.request.post(`${base}/${target.mediaAssetId}/complete`, { data: { providerFileId: fileId } })).status()).toBe(200);
  };
  await add('PHOTO', 'lake.png', 'image/png', PNG);
  await add('AUDIO', 'loons.wav', 'audio/wav', WAV);

  let messageId = '';
  try {
    await page.goto(`/memory-vault/${memory.id}`);
    await page.getByRole('link', { name: 'Create a message' }).click();
    await expect(page.getByText('Your memory stays private. A separate message will be created from the content you choose.')).toBeVisible();
    await page.getByRole('checkbox', { name: /Mira/ }).check();
    await page.getByRole('radio', { name: /Mixed/ }).check();
    await page.getByLabel('Message title').fill(`For Mira ${RUN}`);
    await expect(page.getByRole('checkbox', { name: 'The memory’s written text' })).toBeChecked();
    await page.getByRole('checkbox', { name: /lake\.png/ }).check();
    await page.getByRole('checkbox', { name: /loons\.wav/ }).check();
    await page.getByRole('button', { name: 'Create draft message' }).click();

    // The normal message page: copied text, copied (verified) files, a draft.
    await expect(page).toHaveURL(/\/messages\/[0-9a-f-]{36}$/);
    messageId = page.url().split('/').pop()!;
    await expect(page.getByText('Original memory text.')).toBeVisible();
    await expect(page.getByRole('img', { name: 'lake.png' })).toBeVisible();
    await page.getByRole('button', { name: 'Listen' }).click();
    await expect(page.getByLabel('Play loons.wav')).toBeVisible();

    const soon = new Date(Date.now() + 70_000).toISOString();
    expect((await page.request.post(`${API}/messages/${messageId}/schedule`, { data: { triggerType: 'FIXED_DATE', scheduledFor: soon } })).status()).toBe(201);
    await expect
      .poll(async () => (await (await page.request.get(`${API}/messages/${messageId}`)).json()).status, { timeout: 4 * 60_000, intervals: [5_000] })
      .toBe('RELEASED');

    // Change and then delete the memory: the released message is a snapshot.
    expect((await page.request.patch(`${API}/memory-vault/${memory.id}`, { data: { textContent: 'Changed memory text.' } })).status()).toBe(200);
    expect((await page.request.delete(`${API}/memory-vault/${memory.id}`)).status()).toBe(204);

    const rc = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const rcPage = await rc.newPage();
    await signInWithCode(rcPage, 'recipient', email);
    await rcPage.getByRole('link', { name: new RegExp(`For Mira ${RUN}`) }).click();
    await expect(rcPage.getByText('Original memory text.')).toBeVisible();
    await expect(rcPage.getByText('Changed memory text.')).toHaveCount(0);
    await expect(rcPage.getByRole('img', { name: 'lake.png' })).toBeVisible();
    await rcPage.getByRole('button', { name: 'Listen' }).click();
    await expect(rcPage.getByLabel('Play loons.wav')).toBeVisible();
    // Nothing of the memory itself: no category, tags or Memory Vault access.
    await expect(rcPage.getByText('Private tag')).toHaveCount(0);
    await expect(rcPage.getByText(`Lake house ${RUN}`)).toHaveCount(0);
    expect(await status(rcPage.request, `/memory-vault/${memory.id}`)).toBe(401);
    expect(await status(rcPage.request, '/memory-vault')).toBe(401);
    await rc.close();
  } finally {
    // The copies were made by the API, not the browser: add their ids too.
    if (messageId) for (const id of await messageMediaFileIds([messageId])) imagekitFiles.add(id);
  }
});


// Phase 15B (approved policy), scenarios C + D. A fresh, fictional Customer
// (a verified death ends their sign-in, so never the shared vault Customers)
// writes a wish with a photo, makes a message from it in the UI for Recipient
// Iris with "After my passing" timing, then edits and deletes the wish. A
// Trusted Contact's report releases nothing; Iris has no grant (so no sign-in
// code) and no email through the safeguard and review; only the admin's verification (the
// current API path, with TOTP) releases it through the normal queue. Iris then
// reads the original snapshot and its photo, and never reaches My Wishes.
// Needs the API to run with a short DEATH_VERIFICATION_SAFEGUARD_SECONDS and a
// fictional local admin: E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD, E2E_ADMIN_TOTP_SECRET.
test('My Wishes → Message: after-death release only after a verified death; the Recipient never reaches the wish', async ({
  browser,
  playwright,
  imagekitFiles,
}) => {
  const ADMIN = { email: process.env.E2E_ADMIN_EMAIL, password: process.env.E2E_ADMIN_PASSWORD, secret: process.env.E2E_ADMIN_TOTP_SECRET };
  test.skip(!LOG || !ADMIN.email || !ADMIN.password || !ADMIN.secret, 'Needs E2E_BACKEND_LOG and a fictional admin (E2E_ADMIN_EMAIL/PASSWORD/TOTP_SECRET).');
  test.setTimeout(8 * 60_000);
  const KEY = 'personal-message.remember';
  const text = `Remember the long walks. ${RUN}`;
  const iris = `iris@rc-${RUN}.example.com`;
  const ezra = `ezra@tc-${RUN}.example.com`;
  const customer = newAccount();
  const cx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await cx.newPage();
  const admin = await playwright.request.newContext();
  let messageId = '';
  try {
    await registerViaApi(page.request, customer);
    await page.goto('/login');
    await signIn(page, customer);
    await expect(page).toHaveURL(/\/dashboard/);
    expect((await page.request.post(`${API}/my-wishes/disclaimer/acknowledgement`, { data: { version: 1 } })).status()).toBe(200);
    expect((await page.request.post(`${API}/recipients`, { data: { firstName: 'Iris', email: iris } })).status()).toBe(201);
    const tc = await (await page.request.post(`${API}/trusted-contacts`, { data: { firstName: 'Ezra', email: ezra } })).json();

    // The wish, with a photo, in the UI.
    await page.goto(`/my-wishes/${KEY}`);
    await page.getByLabel('Your answer').fill(text);
    await page.getByRole('button', { name: 'Save answer' }).click();
    await expect(page).toHaveURL(/\/my-wishes$/);
    await page.goto(`/my-wishes/${KEY}`);
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Add a photo' }).click();
    await (await chooser).setFiles({ name: 'walk.png', mimeType: 'image/png', buffer: PNG });
    await expect(page.getByText('Photo added')).toBeVisible();

    // Create message → person → type → content → the normal message page → ON_DEATH.
    await page.getByRole('link', { name: 'Create message for loved ones' }).click();
    await page.getByRole('checkbox', { name: /Iris/ }).check();
    await page.getByRole('radio', { name: /Mixed/ }).check();
    await page.getByLabel('Message title').fill(`For Iris ${RUN}`);
    await page.getByRole('group', { name: 'Wish content' }).getByRole('checkbox', { name: /walk\.png/ }).check();
    await page.getByRole('button', { name: 'Create draft message' }).click();
    await expect(page).toHaveURL(/\/messages\/[0-9a-f-]{36}$/);
    messageId = page.url().split('/').pop()!;
    await page.getByRole('radio', { name: /After my passing/ }).check();
    await page.getByRole('button', { name: 'Schedule message' }).click();
    await expect(page.getByText('Scheduled', { exact: true })).toBeVisible();

    // Scenario D (before the death: a verified Customer can no longer sign in):
    // editing, then deleting the wish never touches the scheduled message.
    expect((await page.request.put(`${API}/my-wishes/prompts/${KEY}/response`, { data: { textContent: 'Changed wish.' } })).status()).toBe(200);
    expect((await page.request.delete(`${API}/my-wishes/prompts/${KEY}/response`)).status()).toBe(204);
    const scheduled = await (await page.request.get(`${API}/messages/${messageId}`)).json();
    expect(scheduled).toMatchObject({ status: 'SCHEDULED', textContent: text });

    // The Trusted Contact reports: nothing is released, and no wish is reachable.
    const tcContext = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const tcPage = await tcContext.newPage();
    await signInWithCode(tcPage, 'trusted-contact', ezra);
    // Portal pages can take long under `next dev`; the session itself is immediate.
    await expect(tcPage).toHaveURL(/\/trusted-contact\/accounts$/, { timeout: 60_000 });
    for (const path of ['/my-wishes/prompts', `/my-wishes/prompts/${KEY}/response`, `/messages/${messageId}`])
      expect(await status(tcPage.request, path)).toBe(401);
    const report = await tcPage.request.post(`${API}/trusted-contact/accounts/${tc.id}/death-reports`, {
      data: { confirmReport: true, reportedDateOfDeath: '2026-09-01' },
    });
    expect(report.status()).toBe(201);
    const { caseId } = await report.json();
    await tcContext.close();
    expect((await (await page.request.get(`${API}/messages/${messageId}`)).json()).status).toBe('SCHEDULED');

    // The Recipient has nothing yet: no release, so no grant (the portal sends no
    // sign-in code without one) and no release email.
    const releaseLogFrom = fs.statSync(LOG!).size;

    // Admin (password + TOTP, the current API path): waits for review, then verifies.
    const login = await (await admin.post(`${API}/auth/login`, { data: { email: ADMIN.email, password: ADMIN.password } })).json();
    const { code } = await freshTotp(ADMIN.secret!);
    expect((await admin.post(`${API}/admin-auth/totp/verify`, { data: { challengeId: login.challengeId, code } })).status()).toBe(200);
    await expect
      .poll(async () => (await (await admin.get(`${API}/admin/death-verifications/${caseId}`)).json()).status, { timeout: 60_000 })
      .toBe('READY_FOR_REVIEW');
    expect((await (await page.request.get(`${API}/messages/${messageId}`)).json()).status).toBe('SCHEDULED');
    expect(fs.readFileSync(LOG!, 'utf8').slice(releaseLogFrom)).not.toMatch(/Email \(message-released\) to i\*\*\*@/);
    const detail = JSON.stringify(await (await admin.get(`${API}/admin/death-verifications/${caseId}`)).json());
    expect(detail).not.toContain('long walks');
    expect(detail).not.toContain(`For Iris ${RUN}`);
    const verified = await admin.post(`${API}/admin/death-verifications/${caseId}/verify`, {
      data: { verifiedDeathAt: new Date(Date.now() - 86_400_000).toISOString(), confirmVerification: true, decisionNote: 'Fictional Phase 15B E2E.' },
    });
    expect(verified.status()).toBe(200);

    // Released by the normal queue, with the normal minimal email (nothing of the wish).
    const released = await emailFromLog(LOG!, 'message-released', iris, releaseLogFrom).catch(async () => {
      await new Promise((r) => setTimeout(r, 30_000)); // the queue may still be working
      return emailFromLog(LOG!, 'message-released', iris, releaseLogFrom);
    });
    expect(released).toContain('A message is waiting for you');
    expect(released).not.toContain('long walks');
    expect(released).not.toContain(`For Iris ${RUN}`);
    const rcContext = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const rcPage = await rcContext.newPage();
    await signInWithCode(rcPage, 'recipient', iris);
    await expect(rcPage).toHaveURL(/\/recipient\/messages$/, { timeout: 60_000 });
    await rcPage.getByRole('link', { name: new RegExp(`For Iris ${RUN}`) }).click();
    await expect(rcPage.getByText(text)).toBeVisible();
    await expect(rcPage.getByText('Changed wish.')).toHaveCount(0);
    await expect(rcPage.getByRole('img', { name: 'walk.png' })).toBeVisible();
    for (const path of ['/my-wishes/prompts', '/my-wishes/disclaimer', `/my-wishes/prompts/${KEY}/response`, `/my-wishes/prompts/${KEY}/response/media`])
      expect(await status(rcPage.request, path)).toBe(401);
    await rcContext.close();
  } finally {
    if (messageId) for (const id of await messageMediaFileIds([messageId])) imagekitFiles.add(id);
    // Only reachable if the test stopped before the death; the delete removes the wish's file too.
    await page.request.delete(`${API}/my-wishes/prompts/${KEY}/response`).catch(() => undefined);
    await admin.dispose();
    await cx.close();
  }
});

// Phase 14B. A My Story answer with text, a photo, audio and a video (real
// browser uploads to ImageKit) and a linked memory; then a separate MIXED
// message made from it in the UI, released for real and read by the
// Recipient. The story and the memory stay private; editing and deleting the
// story afterwards never changes the message.
test('My Story → Message: rich answer, copy, release, Recipient reads it; the story stays private and independent', async ({
  page,
  browser,
  imagekitFiles,
}) => {
  test.skip(!LOG, 'Set E2E_BACKEND_LOG to the backend output file to run the OTP flows.');
  test.setTimeout(8 * 60_000); // real uploads + a real FIXED_DATE release
  const KEY = 'travel.journey';
  const email = `nina@rc-${RUN}.example.com`;
  expect((await page.request.post(`${API}/recipients`, { data: { firstName: 'Nina', email } })).status()).toBe(201);
  const memory = await (
    await page.request.post(`${API}/memory-vault`, { data: { title: `Private trip ${RUN}`, category: 'TRAVEL' } })
  ).json();
  const video = fs.readFileSync('e2e/fixtures/synthetic-video.webm');
  const pick = async (button: string, file: { name: string; mimeType: string; buffer: Buffer }, added: string) => {
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: button }).click();
    await (await chooser).setFiles(file);
    await expect(page.getByText(added)).toBeVisible();
  };

  let messageId = '';
  try {
    await page.goto(`/my-story/${KEY}`);
    await page.getByLabel('Your answer').fill(`My first trip was by train. ${RUN}`);
    await page.getByRole('button', { name: 'Save answer' }).click();
    await expect(page).toHaveURL(/\/my-story$/);
    await page.goto(`/my-story/${KEY}`);
    await pick('Add a photo', { name: 'platform.png', mimeType: 'image/png', buffer: PNG }, 'Photo added');
    await pick('Upload audio', { name: 'whistle.wav', mimeType: 'audio/wav', buffer: WAV }, 'Audio added');
    await pick('Add a video', { name: 'train.webm', mimeType: 'video/webm', buffer: video }, 'Video added');
    await page.getByLabel('Find a memory to link').fill(`Private trip ${RUN}`);
    await page.getByRole('list', { name: 'Memories you can link' }).getByRole('button', { name: 'Link' }).first().click();
    await expect(page.getByRole('list', { name: 'Linked memories' })).toContainText(`Private trip ${RUN}`);

    // Reload: everything is kept.
    await page.reload();
    await expect(page.getByLabel('Your answer')).toHaveValue(`My first trip was by train. ${RUN}`);
    await expect(page.getByRole('img', { name: 'platform.png' })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Linked memories' })).toContainText(`Private trip ${RUN}`);

    // Share: a separate message from chosen parts.
    await page.getByRole('link', { name: 'Create a message' }).click();
    await expect(page.getByText('Your story stays private. A separate message will be created from the content you choose.')).toBeVisible();
    await page.getByRole('checkbox', { name: /Nina/ }).check();
    await page.getByRole('radio', { name: /Mixed/ }).check();
    await page.getByLabel('Message title').fill(`For Nina ${RUN}`);
    const content = page.getByRole('group', { name: 'Story content' });
    await expect(content.getByRole('checkbox', { name: 'The story’s written text' })).toBeChecked();
    for (const name of [/platform\.png/, /whistle\.wav/, /train\.webm/]) await content.getByRole('checkbox', { name }).check();
    await page.getByRole('button', { name: 'Create draft message' }).click();
    await expect(page).toHaveURL(/\/messages\/[0-9a-f-]{36}$/);
    messageId = page.url().split('/').pop()!;
    await expect(page.getByText(`My first trip was by train. ${RUN}`)).toBeVisible();
    await expect(page.getByRole('img', { name: 'platform.png' })).toBeVisible();

    const soon = new Date(Date.now() + 70_000).toISOString();
    expect((await page.request.post(`${API}/messages/${messageId}/schedule`, { data: { triggerType: 'FIXED_DATE', scheduledFor: soon } })).status()).toBe(201);
    await expect
      .poll(async () => (await (await page.request.get(`${API}/messages/${messageId}`)).json()).status, { timeout: 4 * 60_000, intervals: [5_000] })
      .toBe('RELEASED');

    // Change and then delete the story: the released message is a snapshot.
    expect((await page.request.put(`${API}/my-story/prompts/${KEY}/response`, { data: { textContent: 'Changed story.' } })).status()).toBe(200);
    expect((await page.request.delete(`${API}/my-story/prompts/${KEY}/response`)).status()).toBe(204);

    const rc = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const rcPage = await rc.newPage();
    await signInWithCode(rcPage, 'recipient', email);
    await rcPage.getByRole('link', { name: new RegExp(`For Nina ${RUN}`) }).click();
    await expect(rcPage.getByText(`My first trip was by train. ${RUN}`)).toBeVisible();
    await expect(rcPage.getByText('Changed story.')).toHaveCount(0);
    await expect(rcPage.getByRole('img', { name: 'platform.png' })).toBeVisible();
    await rcPage.getByRole('button', { name: 'Listen' }).click();
    await expect(rcPage.getByLabel('Play whistle.wav')).toBeVisible();
    await rcPage.getByRole('button', { name: 'Watch' }).click();
    await expect(rcPage.getByLabel('Play train.webm')).toHaveAttribute('src', /ik-s=.+/);
    // Nothing of the story or the linked memory.
    await expect(rcPage.getByText(`Private trip ${RUN}`)).toHaveCount(0);
    for (const path of ['/my-story/prompts', `/my-story/prompts/${KEY}/response/media`, `/memory-vault/${memory.id}`])
      expect(await status(rcPage.request, path)).toBe(401);
    await rc.close();
  } finally {
    if (messageId) for (const id of await messageMediaFileIds([messageId])) imagekitFiles.add(id);
    await page.request.delete(`${API}/my-story/prompts/${KEY}/response`);
    await page.request.delete(`${API}/memory-vault/${memory.id}`);
  }
});
