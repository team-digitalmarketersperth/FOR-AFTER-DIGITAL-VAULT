// Seeds two synthetic, verified Customers in the ISOLATED test DB (run through scripts/phase24/isolated-env.mjs):
// "trial" (enforced active trial) and "paid" (trial dates + active subscription). Prints their emails as JSON.
// `node seed.mjs cleanup <run>` deletes them again (cascades).
import { createRequire } from 'node:module';
const require = createRequire('D:/FOR-AFTER-DIGITAL-VAULT/for-after-backend/package.json');
const pg = require('pg');
const argon2 = require('argon2');

const url = new URL(process.env.DATABASE_URL);
if (!/_(p24|test)$/.test(url.pathname)) throw new Error(`refusing: not an isolated test database (${url.pathname})`);
const client = new pg.Client({ connectionString: url.href });
await client.connect();
const [cmd, runArg] = process.argv.slice(2);
const run = runArg ?? String(Date.now());
const email = (n) => `browser.trialq.${n}.${run}@example.test`;
if (cmd === 'cleanup') {
  const r = await client.query(`DELETE FROM "User" WHERE email LIKE $1`, [`browser.trialq.%.${run}@example.test`]);
  console.log(JSON.stringify({ deleted: r.rowCount }));
} else {
  const hash = await argon2.hash('StrongPassword123!', { type: argon2.argon2id });
  const ids = {};
  for (const n of ['trial', 'paid']) {
    const { rows } = await client.query(
      `INSERT INTO "User" (id, email, "passwordHash", "firstName", "lastName", role, status, "emailVerifiedAt", "createdAt", "updatedAt")
       VALUES (gen_random_uuid(), $1, $2, $3, 'Test', 'CUSTOMER', 'ACTIVE', (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC')) RETURNING id`,
      [email(n), hash, n === 'trial' ? 'Tia' : 'Pat'],
    );
    ids[n] = rows[0].id;
    await client.query(
      `INSERT INTO "CustomerTrial" (id, "userId", "startedAt", "endsAt", "createdAt")
       VALUES (gen_random_uuid(), $1, (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC') + interval '7 days', (now() AT TIME ZONE 'UTC'))`,
      [ids[n]],
    );
    const mem = await client.query(
      `INSERT INTO "MemoryVaultItem" (id, "ownerUserId", title, category, "textContent", "createdAt", "updatedAt")
       VALUES (gen_random_uuid(), $1, 'Beach days', 'OTHER', 'A synthetic memory.', (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC')) RETURNING id`,
      [ids[n]],
    );
    if (n === 'trial') {
      // A paid-era answer with words and a linked memory (childhood.home): one slot used at the start.
      const ans = await client.query(
        `INSERT INTO "MyStoryResponse" (id, "ownerUserId", "promptKey", "promptTextSnapshot", "promptVersion", "textContent", "createdAt", "updatedAt")
         VALUES (gen_random_uuid(), $1, 'childhood.home', 'What was the place you grew up in like?', 1, 'A house by the sea.', (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC')) RETURNING id`,
        [ids[n]],
      );
      await client.query(`INSERT INTO "MyStoryMemoryLink" ("myStoryResponseId", "memoryVaultItemId", "createdAt") VALUES ($1, $2, (now() AT TIME ZONE 'UTC'))`, [ans.rows[0].id, mem.rows[0].id]);
    }
  }
  await client.query(
    `INSERT INTO "BillingAccount" (id, "userId", "stripeCustomerId", livemode, plan, "subscriptionStatus", "cancelAtPeriodEnd", "currentPeriodEnd", "createdAt", "updatedAt")
     VALUES (gen_random_uuid(), $1, $2, false, 'monthly', 'active', false, (now() AT TIME ZONE 'UTC') + interval '30 days', (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC'))`,
    [ids.paid, `cus_fictional_browser_${run}`],
  );
  console.log(JSON.stringify({ run, trial: email('trial'), paid: email('paid') }));
}
await client.end();
