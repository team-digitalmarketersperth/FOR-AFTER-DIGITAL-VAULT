// Updated Plans Step 8 browser fixtures, ISOLATED test DB only (run through scripts/phase24/isolated-env.mjs).
// fresh: no trial yet (trial_available); trial: active trial at the 1-person cap, 3 of 5 AI replies; expiring: active
// trial (the journey ends it mid-form); prem: mapped PREMIUM monthly, 3 people, 12 AI replies this UTC month; comp:
// mapped COMPLETE annual; exp: ended trial with one written memory and one person (locked view/delete); unres:
// plan_unresolved (COMPLETE kept as stored). Synthetic people, fictional ids, no real customer data.
// `seed <run>` prints the fixture map; `expire <run> <name>` ends that account's trial now; `cleanup <run>` removes all.
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
const require = createRequire('D:/FOR-AFTER-DIGITAL-VAULT/for-after-backend/package.json');
const pg = require('pg');
const argon2 = require('argon2');

const url = new URL(process.env.DATABASE_URL);
if (!/_(p24|test)$/.test(url.pathname)) throw new Error(`refusing: not an isolated test database (${url.pathname})`);
const db = new pg.Client({ connectionString: url.href });
await db.connect();
const [cmd, runArg, nameArg] = process.argv.slice(2);
const run = runArg ?? String(Date.now());
const email = (n) => `browser.up8.${n}.${run}@example.test`;
const NOW = `(now() AT TIME ZONE 'UTC')`;
const q = (sql, args) => db.query(sql, args);

if (cmd === 'cleanup') {
  const r = await q(`DELETE FROM "User" WHERE email LIKE $1`, [`browser.up8.%.${run}@example.test`]);
  console.log(JSON.stringify({ deleted: r.rowCount }));
} else if (cmd === 'expire') {
  const r = await q(
    `UPDATE "CustomerTrial" SET "endsAt" = ${NOW} - interval '1 second' WHERE "userId" = (SELECT id FROM "User" WHERE email = $1)`,
    [email(nameArg)],
  );
  console.log(JSON.stringify({ expired: r.rowCount }));
} else {
  const hash = await argon2.hash('StrongPassword123!', { type: argon2.argon2id });
  const user = async (n, first) => (await q(`INSERT INTO "User" (id, email, "passwordHash", "firstName", "lastName", role, status, "emailVerifiedAt", "createdAt", "updatedAt") VALUES (gen_random_uuid(), $1, $2, $3, 'Test', 'CUSTOMER', 'ACTIVE', ${NOW}, ${NOW}, ${NOW}) RETURNING id`, [email(n), hash, first])).rows[0].id;
  const account = (id, n, { plan = null, tier = null, status = null, unresolved = false } = {}) =>
    q(
      `INSERT INTO "BillingAccount" (id, "userId", "stripeCustomerId", livemode, "stripeSubscriptionId", plan, tier, "priceUnresolved", "subscriptionStatus", "cancelAtPeriodEnd", "currentPeriodEnd", "syncedAt", "createdAt", "updatedAt")
       VALUES (gen_random_uuid(), $1, $2, false, $3, $4, $5::"PaidTier", $6, $7, false, ${NOW} + interval '30 days', ${NOW}, ${NOW}, ${NOW})`,
      [id, `cus_fake_up8_${n}_${run}`, status ? `sub_fake_up8_${n}_${run}` : null, plan, tier, unresolved, status],
    );
  const trial = async (id, ends = `${NOW} + interval '7 days'`, starts = NOW) =>
    (await q(`INSERT INTO "CustomerTrial" (id, "userId", "startedAt", "endsAt", "createdAt") VALUES (gen_random_uuid(), $1, ${starts}, ${ends}, ${NOW}) RETURNING id`, [id])).rows[0].id;
  const people = (id, names) => Promise.all(names.map((first) => q(`INSERT INTO "Recipient" (id, "ownerUserId", "firstName", "createdAt", "updatedAt") VALUES (gen_random_uuid(), $1, $2, ${NOW}, ${NOW})`, [id, first])));
  const used = (id, period, count) =>
    count &&
    q(`INSERT INTO "AiUsage" (id, "userId", "requestId", period, status, "expiresAt", "settledAt", "createdAt") VALUES ${Array.from({ length: count }, () => `('${randomUUID()}', '${id}', '${randomUUID()}', '${period}', 'USED', ${NOW}, ${NOW}, ${NOW})`).join(',')}`);
  const d = new Date();
  const month = `month:${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

  await user('fresh', 'Fern');

  const t = await user('trial', 'Tia');
  await people(t, ['Sofia']);
  await used(t, `trial:${await trial(t)}`, 3);

  const x = await user('expiring', 'Xan');
  await trial(x);

  const prem = await user('prem', 'Pria');
  await account(prem, 'prem', { plan: 'monthly', tier: 'PREMIUM', status: 'active' });
  await people(prem, ['Ari', 'Bea', 'Cal']);
  await used(prem, month, 12);

  const comp = await user('comp', 'Cora');
  await account(comp, 'comp', { plan: 'annual', tier: 'COMPLETE', status: 'active' });

  const exp = await user('exp', 'Eli');
  await trial(exp, `${NOW} - interval '1 day'`, `${NOW} - interval '8 days'`);
  await people(exp, ['Noor']);
  await q(`INSERT INTO "MemoryVaultItem" (id, "ownerUserId", title, category, "textContent", "createdAt", "updatedAt") VALUES (gen_random_uuid(), $1, 'Sunday pancakes', 'RECIPES', 'Two eggs, a cup of flour, and patience.', ${NOW}, ${NOW})`, [exp]);

  const unres = await user('unres', 'Una');
  await account(unres, 'unres', { plan: 'unknown', tier: 'COMPLETE', status: 'active', unresolved: true });

  const names = ['fresh', 'trial', 'expiring', 'prem', 'comp', 'exp', 'unres'];
  console.log(JSON.stringify({ run, ...Object.fromEntries(names.map((n) => [n, email(n)])), customer: { prem: `cus_fake_up8_prem_${run}`, unres: `cus_fake_up8_unres_${run}` }, sub: { prem: `sub_fake_up8_prem_${run}`, unres: `sub_fake_up8_unres_${run}` } }));
}
await db.end();
