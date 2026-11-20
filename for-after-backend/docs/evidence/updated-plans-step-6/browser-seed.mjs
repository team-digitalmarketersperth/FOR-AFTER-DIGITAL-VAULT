// Updated Plans Step 6 close-out browser fixtures, ISOLATED test DB only (run through scripts/phase24/isolated-env.mjs).
// buyer: expired trial (may buy); legacy: unmapped paid (plan monthly, no tier); comp: mapped COMPLETE annual;
// unres: plan_unresolved (paid in "Stripe", unknown price, COMPLETE kept as stored). Synthetic rows only. `cleanup <run>`.
import { createRequire } from 'node:module';
const require = createRequire('D:/FOR-AFTER-DIGITAL-VAULT/for-after-backend/package.json');
const pg = require('pg');
const argon2 = require('argon2');

const url = new URL(process.env.DATABASE_URL);
if (!/_(p24|test)$/.test(url.pathname)) throw new Error(`refusing: not an isolated test database (${url.pathname})`);
const db = new pg.Client({ connectionString: url.href });
await db.connect();
const [cmd, runArg] = process.argv.slice(2);
const run = runArg ?? String(Date.now());
const email = (n) => `browser.up6.${n}.${run}@example.test`;
const NOW = `(now() AT TIME ZONE 'UTC')`;
const q = (sql, args) => db.query(sql, args);

if (cmd === 'cleanup') {
  const r = await q(`DELETE FROM "User" WHERE email LIKE $1`, [`browser.up6.%.${run}@example.test`]);
  console.log(JSON.stringify({ deleted: r.rowCount }));
} else {
  const hash = await argon2.hash('StrongPassword123!', { type: argon2.argon2id });
  const user = async (n, first) => (await q(`INSERT INTO "User" (id, email, "passwordHash", "firstName", "lastName", role, status, "emailVerifiedAt", "createdAt", "updatedAt") VALUES (gen_random_uuid(), $1, $2, $3, 'Test', 'CUSTOMER', 'ACTIVE', ${NOW}, ${NOW}, ${NOW}) RETURNING id`, [email(n), hash, first])).rows[0].id;
  const account = (id, n, { plan = null, tier = null, status = null, unresolved = false } = {}) =>
    q(
      `INSERT INTO "BillingAccount" (id, "userId", "stripeCustomerId", livemode, "stripeSubscriptionId", plan, tier, "priceUnresolved", "subscriptionStatus", "cancelAtPeriodEnd", "currentPeriodEnd", "syncedAt", "createdAt", "updatedAt")
       VALUES (gen_random_uuid(), $1, $2, false, $3, $4, $5::"PaidTier", $6, $7, false, ${NOW} + interval '30 days', ${NOW}, ${NOW}, ${NOW})`,
      [id, `cus_fake_up6_${n}_${run}`, status ? `sub_fake_up6_${n}_${run}` : null, plan, tier, unresolved, status],
    );

  const buyer = await user('buyer', 'Bea');
  await q(`INSERT INTO "CustomerTrial" (id, "userId", "startedAt", "endsAt", "createdAt") VALUES (gen_random_uuid(), $1, ${NOW} - interval '8 days', ${NOW} - interval '1 day', ${NOW})`, [buyer]);
  await account(await user('legacy', 'Leo'), 'legacy', { plan: 'monthly', status: 'active' });
  await account(await user('comp', 'Cora'), 'comp', { plan: 'annual', tier: 'COMPLETE', status: 'active' });
  await account(await user('unres', 'Una'), 'unres', { plan: 'unknown', tier: 'COMPLETE', status: 'active', unresolved: true });
  console.log(JSON.stringify({ run, buyer: email('buyer'), legacy: email('legacy'), comp: email('comp'), unres: email('unres') }));
}
await db.end();
