// Updated Plans Step 5 browser fixtures, ISOLATED test DB only (run through scripts/phase24/isolated-env.mjs).
// trial: active trial with 3 of 5 used; prem: mapped PREMIUM with 50 of 50 used this UTC month and a saved wish;
// unm: unmapped paid (not metered). Synthetic tiers and synthetic usage rows (metadata only). `cleanup <run>`.
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
const require = createRequire('D:/FOR-AFTER-DIGITAL-VAULT/for-after-backend/package.json');
const pg = require('pg');
const argon2 = require('argon2');

const url = new URL(process.env.DATABASE_URL);
if (!/_(p24|test)$/.test(url.pathname)) throw new Error(`refusing: not an isolated test database (${url.pathname})`);
const db = new pg.Client({ connectionString: url.href });
await db.connect();
const [cmd, runArg] = process.argv.slice(2);
const run = runArg ?? String(Date.now());
const email = (n) => `browser.up5.${n}.${run}@example.test`;
const NOW = `(now() AT TIME ZONE 'UTC')`;
const q = (sql, args) => db.query(sql, args);

if (cmd === 'cleanup') {
  const r = await q(`DELETE FROM "User" WHERE email LIKE $1`, [`browser.up5.%.${run}@example.test`]);
  console.log(JSON.stringify({ deleted: r.rowCount }));
} else {
  const hash = await argon2.hash('StrongPassword123!', { type: argon2.argon2id });
  const user = async (n, first) => (await q(`INSERT INTO "User" (id, email, "passwordHash", "firstName", "lastName", role, status, "emailVerifiedAt", "createdAt", "updatedAt") VALUES (gen_random_uuid(), $1, $2, $3, 'Test', 'CUSTOMER', 'ACTIVE', ${NOW}, ${NOW}, ${NOW}) RETURNING id`, [email(n), hash, first])).rows[0].id;
  const subscribe = (id, tier, n) =>
    q(`INSERT INTO "BillingAccount" (id, "userId", "stripeCustomerId", livemode, plan, tier, "subscriptionStatus", "cancelAtPeriodEnd", "currentPeriodEnd", "createdAt", "updatedAt") VALUES (gen_random_uuid(), $1, $2, false, 'monthly', $3::"PaidTier", 'active', false, ${NOW} + interval '30 days', ${NOW}, ${NOW})`, [id, `cus_fictional_up5_${n}_${run}`, tier]);
  const used = (id, period, count) => {
    const rows = Array.from({ length: count }, () => `('${randomUUID()}', '${id}', '${randomUUID()}', '${period}', 'USED', ${NOW}, ${NOW}, ${NOW})`).join(',');
    return q(`INSERT INTO "AiUsage" (id, "userId", "requestId", period, status, "expiresAt", "settledAt", "createdAt") VALUES ${rows}`);
  };
  const d = new Date();
  const month = `month:${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

  const trial = await user('trial', 'Tia');
  const trialId = (await q(`INSERT INTO "CustomerTrial" (id, "userId", "startedAt", "endsAt", "createdAt") VALUES (gen_random_uuid(), $1, ${NOW}, ${NOW} + interval '7 days', ${NOW}) RETURNING id`, [trial])).rows[0].id;
  await used(trial, `trial:${trialId}`, 3);

  const prem = await user('prem', 'Pria');
  await subscribe(prem, 'PREMIUM', 'prem');
  await used(prem, month, 50);
  await q(`INSERT INTO "MyWishResponse" (id, "ownerUserId", "promptKey", "promptTextSnapshot", "promptVersion", "textContent", "createdAt", "updatedAt") VALUES (gen_random_uuid(), $1, 'ceremony.style', 'What kind of ceremony would you like?', 1, 'Something small.', ${NOW}, ${NOW})`, [prem]);

  const unm = await user('unm', 'Uma');
  await subscribe(unm, null, 'unm');

  console.log(JSON.stringify({ run, trial: email('trial'), prem: email('prem'), unm: email('unm') }));
}
await db.end();
