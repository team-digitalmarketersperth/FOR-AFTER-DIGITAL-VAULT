import { API, newAccount, registerViaApi } from './helpers';
import { adminSignIn, db, trustedContactSignIn } from './death-helpers';
import { expect, test } from './imagekit';

// Phase 19A, local only: a Trusted Contact reports and uploads a synthetic PDF;
// an admin sees it and opens it through a short-lived signed URL; nothing is
// verified or released. Every person and file here is fictional. The run needs:
//   - an API whose output is teed into E2E_BACKEND_LOG with EMAIL_PROVIDER=console
//     (OTP codes and the invitation email are read from / printed to that log,
//     never sent), its own queue names, and local PostgreSQL/Redis/clamd;
//   - the app pointed at that API (NEXT_PUBLIC_API_BASE_URL).
// The uploaded file goes to the development ImageKit account and is deleted by
// the imagekitFiles fixture; the test users (and so the case and evidence rows)
// are deleted from the local database afterwards.
const LOG = process.env.E2E_BACKEND_LOG;
test.skip(!LOG, 'Set E2E_BACKEND_LOG to the backend output file to run the evidence flow.');

// A tiny, harmless PDF: no personal data, just a valid header and trailer.
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');

test('evidence: Trusted Contact uploads a PDF, admin views it securely, nothing is verified or released', async ({
  browser,
  imagekitFiles,
}) => {
  const customer = newAccount();
  const admin = newAccount();
  const contactEmail = `e2e-tc-${Date.now()}@example.com`;
  try {
    // Customer names a Trusted Contact (the invitation is printed to the log, not sent).
    const customerContext = await browser.newContext();
    await registerViaApi(customerContext.request, customer);
    const login = { email: customer.email, password: customer.password };
    expect((await customerContext.request.post(`${API}/auth/login`, { data: login })).status()).toBe(200);
    expect(
      (await customerContext.request.post(`${API}/trusted-contacts`, { data: { firstName: 'Tess', email: contactEmail } })).status(),
    ).toBe(201);

    // Trusted Contact: report, then add supporting evidence. Its own browser
    // context, so its uploads are handed to the cleanup fixture explicitly.
    const tc = await trustedContactSignIn(browser, contactEmail);
    const tracked: Promise<void>[] = [];
    tc.on('response', (r) => {
      if (r.request().method() !== 'POST' || !/^https:\/\/upload\.imagekit\.io\//.test(r.url())) return;
      tracked.push(
        r
          .json()
          .then((b: { fileId?: string }) => void (b.fileId && imagekitFiles.add(b.fileId)))
          .catch(() => undefined),
      );
    });
    await tc.getByRole('link', { name: new RegExp(customer.firstName) }).click();
    await tc.getByRole('link', { name: 'Submit a death report' }).click();
    await tc.getByRole('checkbox').check();
    await tc.getByRole('button', { name: 'Submit report' }).click();
    await expect(tc.getByText('Your report has been submitted for verification')).toBeVisible();
    await expect(tc.getByText('You submitted a report for this account.')).toBeVisible();
    await expect(tc.getByRole('heading', { name: 'Documents for the review' })).toBeVisible();
    await expect(tc.getByText(/Adding evidence doesn't verify the account or release any messages/)).toBeVisible();
    await tc.getByTestId('evidence-file').setInputFiles({ name: 'synthetic-certificate.pdf', mimeType: 'application/pdf', buffer: PDF });
    await expect(tc.getByText("Evidence uploaded. It's ready for review.")).toBeVisible({ timeout: 60_000 });
    await Promise.all(tracked);
    await expect(tc.getByText(/PDF · 1 KB/)).toBeVisible();
    await expect(tc.getByText(/verified/i)).toHaveCount(0);

    // Evidence changed nothing else: the Customer is still active, the case still open.
    expect((await customerContext.request.get(`${API}/auth/me`)).status()).toBe(200);
    const [kase] = await db<{ id: string; status: string }>(
      `SELECT c.id, c.status FROM "DeathVerificationCase" c JOIN "User" u ON u.id = c."ownerUserId" WHERE u.email = $1`,
      [customer.email],
    );
    expect(['PENDING_VERIFICATION', 'SAFEGUARD_ACTIVE', 'READY_FOR_REVIEW']).toContain(kase.status);

    // Admin (a fresh, fictional account promoted the documented way: docs/admin.md §11).
    await registerViaApi(customerContext.request, admin);
    await db(`UPDATE "User" SET role = 'ADMIN' WHERE email = $1`, [admin.email]);
    const adminPage = await adminSignIn(browser, admin.email, admin.password);
    await adminPage.goto(`/admin/death-verifications/${kase.id}`);
    await expect(adminPage.getByText('synthetic-certificate.pdf')).toBeVisible();
    // The new tab loads the file from a signed, expiring URL. Headless Chromium
    // has no PDF viewer (it downloads), so the response is checked, not the tab.
    const served = adminPage.context().waitForEvent('response', (r) => /^https:\/\/ik\.imagekit\.io\/.*ik-s=/.test(r.url()));
    const popup = adminPage.waitForEvent('popup');
    await adminPage.getByRole('button', { name: 'View securely' }).click();
    const response = await served;
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('application/pdf');
    const signed = new URL(response.url());
    expect(signed.searchParams.get('ik-t')).toBeTruthy(); // expiring signature
    expect(await adminPage.content()).not.toContain(signed.searchParams.get('ik-s')!);
    await (await popup).close();
    await expect(adminPage.getByText('Supporting evidence viewed by an admin')).toBeVisible();
    // No automatic decision: the case is exactly as open as before.
    const [after] = await db<{ status: string }>(`SELECT status FROM "DeathVerificationCase" WHERE id = $1`, [kase.id]);
    expect(after.status).not.toBe('VERIFIED');
    const [owner] = await db<{ status: string }>(`SELECT status FROM "User" WHERE email = $1`, [customer.email]);
    expect(owner.status).toBe('ACTIVE');
    expect(imagekitFiles.size).toBe(1);
  } finally {
    await db(`DELETE FROM "User" WHERE email = ANY($1)`, [[customer.email, admin.email]]);
  }
});
