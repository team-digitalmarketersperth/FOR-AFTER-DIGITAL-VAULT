// Step 7 refinement 2 (2026-11-19) browser fixtures, ISOLATED test DB only (run through scripts/phase24/isolated-env.mjs).
// trial (active, 1 person, 3 AI), expiring (active; ended mid-form), exp (ended trial), prem (PREMIUM monthly, 12 AI),
// comp (COMPLETE annual), cancel (PREMIUM, cancel at period end), ended (subscription canceled), legacy (interval only,
// no tier), exempt (created before BILLING_ENFORCE_FROM, no records: grandfathered), unres (plan_unresolved).
// Synthetic people, fictional ids. `seed <run>` prints the fixture map; `cleanup <run>` removes them.
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
const email = (n) => `browser.up7r2.${n}.${run}@example.test`;
const NOW = `(now() AT TIME ZONE 'UTC')`;
const q = (sql, args) => db.query(sql, args);

if (cmd === 'cleanup') {
  const r = await q(`DELETE FROM "User" WHERE email LIKE $1`, [`browser.up7r2.%.${run}@example.test`]);
  console.log(JSON.stringify({ deleted: r.rowCount }));
} else {
  const hash = await argon2.hash('StrongPassword123!', { type: argon2.argon2id });
  const user = async (n, first, created = NOW) => (await q(`INSERT INTO "User" (id, email, "passwordHash", "firstName", "lastName", role, status, "emailVerifiedAt", "createdAt", "updatedAt") VALUES (gen_random_uuid(), $1, $2, $3, 'Test', 'CUSTOMER', 'ACTIVE', ${NOW}, ${created}, ${NOW}) RETURNING id`, [email(n), hash, first])).rows[0].id;
  const account = (id, n, { plan, tier = null, status, unresolved = false, cancel = false, end = `${NOW} + interval '30 days'` }) =>
    q(
      `INSERT INTO "BillingAccount" (id, "userId", "stripeCustomerId", livemode, "stripeSubscriptionId", plan, tier, "priceUnresolved", "subscriptionStatus", "cancelAtPeriodEnd", "currentPeriodEnd", "syncedAt", "createdAt", "updatedAt")
       VALUES (gen_random_uuid(), $1, $2, false, $3, $4, $5::"PaidTier", $6, $7, $8, ${end}, ${NOW}, ${NOW}, ${NOW})`,
      [id, `cus_fake_up7r2_${n}_${run}`, `sub_fake_up7r2_${n}_${run}`, plan, tier, unresolved, status, cancel],
    );
  const trial = async (id, ends = `${NOW} + interval '7 days'`, starts = NOW) =>
    (await q(`INSERT INTO "CustomerTrial" (id, "userId", "startedAt", "endsAt", "createdAt") VALUES (gen_random_uuid(), $1, ${starts}, ${ends}, ${NOW}) RETURNING id`, [id])).rows[0].id;
  const people = (id, names) => Promise.all(names.map((first) => q(`INSERT INTO "Recipient" (id, "ownerUserId", "firstName", "createdAt", "updatedAt") VALUES (gen_random_uuid(), $1, $2, ${NOW}, ${NOW})`, [id, first])));
  const used = (id, period, count) =>
    count &&
    q(`INSERT INTO "AiUsage" (id, "userId", "requestId", period, status, "expiresAt", "settledAt", "createdAt") VALUES ${Array.from({ length: count }, () => `('${randomUUID()}', '${id}', '${randomUUID()}', '${period}', 'USED', ${NOW}, ${NOW}, ${NOW})`).join(',')}`);
  const d = new Date();
  const month = `month:${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

  const t = await user('trial', 'Tia');
  await people(t, ['Sofia']);
  await used(t, `trial:${await trial(t)}`, 3);
  await trial(await user('expiring', 'Xan'));
  await trial(await user('exp', 'Eli'), `${NOW} - interval '1 day'`, `${NOW} - interval '8 days'`);
  const prem = await user('prem', 'Pria');
  await account(prem, 'prem', { plan: 'monthly', tier: 'PREMIUM', status: 'active' });
  await people(prem, ['Ari', 'Bea', 'Cal']);
  await used(prem, month, 12);
  await account(await user('comp', 'Cora'), 'comp', { plan: 'annual', tier: 'COMPLETE', status: 'active' });
  await account(await user('cancel', 'Cai'), 'cancel', { plan: 'monthly', tier: 'PREMIUM', status: 'active', cancel: true });
  await account(await user('ended', 'Eda'), 'ended', { plan: 'monthly', tier: 'PREMIUM', status: 'canceled', end: `${NOW} - interval '2 days'` });
  const legacy = await user('legacy', 'Lev');
  await account(legacy, 'legacy', { plan: 'monthly', status: 'active' });
  await people(legacy, ['Mo', 'Ned', 'Oli', 'Pip']);
  await user('exempt', 'Ezra', `timestamp '2025-06-01 00:00:00'`);
  await account(await user('unres', 'Una'), 'unres', { plan: 'unknown', tier: 'COMPLETE', status: 'active', unresolved: true });

  const names = ['trial', 'expiring', 'exp', 'prem', 'comp', 'cancel', 'ended', 'legacy', 'exempt', 'unres'];
  console.log(JSON.stringify({ run, ...Object.fromEntries(names.map((n) => [n, email(n)])) }));
}
await db.end();
