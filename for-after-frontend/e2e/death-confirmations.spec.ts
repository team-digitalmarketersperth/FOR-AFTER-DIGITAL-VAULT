import { expect, test } from '@playwright/test';
import { adminSignIn, db, submitReport, trustedContactSignIn } from './death-helpers';
import { API, newAccount, registerViaApi } from './helpers';

// Phase 19B, local only: a Customer with two Trusted Contacts. The first
// report needs a second, independent one before an admin may verify; the
// second report unlocks verify but verifies nothing itself. Same isolated
// setup as death-evidence.spec.ts (E2E_BACKEND_LOG, console email). No worker
// runs there, so the safeguard is ended by moving this synthetic case's stored
// times into the past in the local database (never waiting 14 days, never a
// worker on shared dev data). Fictional people only; deleted afterwards.
const LOG = process.env.E2E_BACKEND_LOG;
test.skip(!LOG, 'Set E2E_BACKEND_LOG to the backend output file to run the confirmation flow.');

test('two contacts: 1 of 2 blocks verify; the second report unlocks it without verifying anything', async ({ browser }) => {
  const customer = newAccount();
  const admin = newAccount();
  const run = Date.now();
  const first = `e2e-tc1-${run}@example.com`;
  const second = `e2e-tc2-${run}@example.com`;
  try {
    const context = await browser.newContext();
    await registerViaApi(context.request, customer);
    const login = { email: customer.email, password: customer.password };
    expect((await context.request.post(`${API}/auth/login`, { data: login })).status()).toBe(200);
    for (const [firstName, email] of [['Tess', first], ['Theo', second]]) {
      expect((await context.request.post(`${API}/trusted-contacts`, { data: { firstName, email } })).status()).toBe(201);
    }

    // First contact reports through the existing form.
    const tc1 = await trustedContactSignIn(browser, first);
    await submitReport(tc1, customer.firstName);
    const [kase] = await db<{ id: string; requiredConfirmations: number }>(
      `SELECT c.id, c."requiredConfirmations" FROM "DeathVerificationCase" c JOIN "User" u ON u.id = c."ownerUserId" WHERE u.email = $1`,
      [customer.email],
    );
    expect(kase.requiredConfirmations).toBe(2);
    // Safeguard over for this synthetic case only (see the header).
    const past = new Date(Date.now() - 60_000);
    await db(
      `UPDATE "DeathVerificationCase" SET status = 'READY_FOR_REVIEW', "safetyNoticeSentAt" = $2, "safeguardStartedAt" = $2, "safeguardEndsAt" = $2 WHERE id = $1`,
      [kase.id, past],
    );

    // Admin: 1 of 2, Verify unavailable, Reject still offered.
    await registerViaApi(context.request, admin);
    await db(`UPDATE "User" SET role = 'ADMIN' WHERE email = $1`, [admin.email]);
    const adminPage = await adminSignIn(browser, admin.email, admin.password);
    await adminPage.goto(`/admin/death-verifications/${kase.id}`);
    await expect(adminPage.getByText('1 of 2')).toBeVisible();
    await expect(adminPage.getByText('Confirmation requirement pending')).toBeVisible();
    await expect(adminPage.getByText(/Another independent Trusted Contact confirmation is required/)).toBeVisible();
    await expect(adminPage.getByRole('button', { name: 'Verify death…' })).toBeDisabled();
    await expect(adminPage.getByRole('button', { name: /Reject/ })).toBeEnabled();
    // The API refuses a forged verify too.
    const forged = await adminPage.request.post(`${API}/admin/death-verifications/${kase.id}/verify`, {
      data: { verifiedDeathAt: past.toISOString(), confirmVerification: true, decisionNote: null },
    });
    expect(forged.status()).toBe(409);

    // Second contact: sees the ordinary report action, no counts or other reporter.
    const tc2 = await trustedContactSignIn(browser, second);
    await tc2.getByRole('link', { name: new RegExp(customer.firstName) }).click();
    await expect(tc2.getByRole('link', { name: 'Submit a death report' })).toBeVisible();
    await expect(tc2.getByText(/\d of \d|confirmation|Tess/i)).toHaveCount(0);
    await submitReport(tc2, customer.firstName);

    // Admin: 2 of 2, Verify available; nothing was verified or released by the report.
    await adminPage.reload();
    await expect(adminPage.getByText('2 of 2')).toBeVisible();
    await expect(adminPage.getByText('Confirmation requirement satisfied')).toBeVisible();
    await expect(adminPage.getByRole('button', { name: 'Verify death…' })).toBeEnabled();
    const [after] = await db<{ status: string; owner: string }>(
      `SELECT c.status, u.status AS owner FROM "DeathVerificationCase" c JOIN "User" u ON u.id = c."ownerUserId" WHERE c.id = $1`,
      [kase.id],
    );
    expect(after).toEqual({ status: 'READY_FOR_REVIEW', owner: 'ACTIVE' });
    expect((await context.request.get(`${API}/auth/me`)).status()).toBe(200);
  } finally {
    await db(`DELETE FROM "User" WHERE email = ANY($1)`, [[customer.email, admin.email]]);
  }
});
