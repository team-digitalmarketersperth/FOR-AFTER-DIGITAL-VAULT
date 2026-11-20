// Updated Plans Step 7 browser fixtures, ISOLATED test DB only (run through scripts/phase24/isolated-env.mjs).
// trial: active trial, 1 person (cap reached), 3 of 5 AI replies; prem: mapped PREMIUM monthly, 3 people, 12 AI replies;
// comp: mapped COMPLETE annual; exp: ended trial (may buy); unres: plan_unresolved with COMPLETE kept as stored.
// Synthetic people, fictional ids, no real customer data. `cleanup <run>` removes them.
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
const email = (n) => `browser.up7.${n}.${run}@example.test`;
const NOW = `(now() AT TIME ZONE 'UTC')`;
const q = (sql, args) => db.query(sql, args);

if (cmd === 'cleanup') {
  const r = await q(`DELETE FROM "User" WHERE email LIKE $1`, [`browser.up7.%.${run}@example.test`]);
  console.log(JSON.stringify({ deleted: r.rowCount }));
} else {
  const hash = await argon2.hash('StrongPassword123!', { type: argon2.argon2id });
  const user = async (n, first) => (await q(`INSERT INTO "User" (id, email, "passwordHash", "firstName", "lastName", role, status, "emailVerifiedAt", "createdAt", "updatedAt") VALUES (gen_random_uuid(), $1, $2, $3, 'Test', 'CUSTOMER', 'ACTIVE', ${NOW}, ${NOW}, ${NOW}) RETURNING id`, [email(n), hash, first])).rows[0].id;
  const account = (id, n, { plan = null, tier = null, status = null, unresolved = false } = {}) =>
    q(
      `INSERT INTO "BillingAccount" (id, "userId", "stripeCustomerId", livemode, "stripeSubscriptionId", plan, tier, "priceUnresolved", "subscriptionStatus", "cancelAtPeriodEnd", "currentPeriodEnd", "syncedAt", "createdAt", "updatedAt")
       VALUES (gen_random_uuid(), $1, $2, false, $3, $4, $5::"PaidTier", $6, $7, false, ${NOW} + interval '30 days', ${NOW}, ${NOW}, ${NOW})`,
      [id, `cus_fake_up7_${n}_${run}`, status ? `sub_fake_up7_${n}_${run}` : null, plan, tier, unresolved, status],
    );
  const people = (id, names) => Promise.all(names.map((first) => q(`INSERT INTO "Recipient" (id, "ownerUserId", "firstName", "createdAt", "updatedAt") VALUES (gen_random_uuid(), $1, $2, ${NOW}, ${NOW})`, [id, first])));
  const used = (id, period, count) =>
    count &&
    q(`INSERT INTO "AiUsage" (id, "userId", "requestId", period, status, "expiresAt", "settledAt", "createdAt") VALUES ${Array.from({ length: count }, () => `('${randomUUID()}', '${id}', '${randomUUID()}', '${period}', 'USED', ${NOW}, ${NOW}, ${NOW})`).join(',')}`);
  const d = new Date();
  const month = `month:${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

  const trial = await user('trial', 'Tia');
  const trialId = (await q(`INSERT INTO "CustomerTrial" (id, "userId", "startedAt", "endsAt", "createdAt") VALUES (gen_random_uuid(), $1, ${NOW}, ${NOW} + interval '7 days', ${NOW}) RETURNING id`, [trial])).rows[0].id;
  await people(trial, ['Sofia']);
  await used(trial, `trial:${trialId}`, 3);

  const prem = await user('prem', 'Pria');
  await account(prem, 'prem', { plan: 'monthly', tier: 'PREMIUM', status: 'active' });
  await people(prem, ['Ari', 'Bea', 'Cal']);
  await used(prem, month, 12);

  const comp = await user('comp', 'Cora');
  await account(comp, 'comp', { plan: 'annual', tier: 'COMPLETE', status: 'active' });

  const exp = await user('exp', 'Eli');
  await q(`INSERT INTO "CustomerTrial" (id, "userId", "startedAt", "endsAt", "createdAt") VALUES (gen_random_uuid(), $1, ${NOW} - interval '8 days', ${NOW} - interval '1 day', ${NOW})`, [exp]);

  const unres = await user('unres', 'Una');
  await account(unres, 'unres', { plan: 'unknown', tier: 'COMPLETE', status: 'active', unresolved: true });

  console.log(JSON.stringify({ run, trial: email('trial'), prem: email('prem'), comp: email('comp'), exp: email('exp'), unres: email('unres') }));
}
await db.end();
