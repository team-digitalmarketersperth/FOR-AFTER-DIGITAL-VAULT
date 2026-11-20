// Step 6 browser fixtures in the ISOLATED test DB only (run through scripts/phase24/isolated-env.mjs).
// Accounts: exp (trial ended at a fixed past time, with content), act (active trial), nos (no trial), paid (ended trial +
// active subscription). `node seed.mjs cleanup <run>` deletes them; `node seed.mjs expire <run>` ends act's trial
// (fixed past time) to simulate expiry while a form is open.
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
const email = (n) => `browser.s6.${n}.${run}@example.test`;
const NOW = `(now() AT TIME ZONE 'UTC')`;
// Fixed fixture times (not the machine clock): the ended trial ran 2026-11-03 → 2026-11-10.
const ENDED = { start: '2026-11-03T00:00:00', end: '2026-11-10T00:00:00' };
const q = (sql, args) => db.query(sql, args);

if (cmd === 'cleanup') {
  const r = await q(`DELETE FROM "User" WHERE email LIKE $1`, [`browser.s6.%.${run}@example.test`]);
  console.log(JSON.stringify({ deleted: r.rowCount }));
} else if (cmd === 'expire') {
  const r = await q(
    `UPDATE "CustomerTrial" SET "startedAt" = $2::timestamp, "endsAt" = $3::timestamp WHERE "userId" = (SELECT id FROM "User" WHERE email = $1)`,
    [email('act'), ENDED.start, ENDED.end],
  );
  console.log(JSON.stringify({ expired: r.rowCount }));
} else {
  const hash = await argon2.hash('StrongPassword123!', { type: argon2.argon2id });
  const ids = {};
  for (const n of ['exp', 'act', 'nos', 'paid']) {
    ids[n] = (
      await q(
        `INSERT INTO "User" (id, email, "passwordHash", "firstName", "lastName", role, status, "emailVerifiedAt", "createdAt", "updatedAt")
         VALUES (gen_random_uuid(), $1, $2, $3, 'Test', 'CUSTOMER', 'ACTIVE', ${NOW}, ${NOW}, ${NOW}) RETURNING id`,
        [email(n), hash, { exp: 'Eva', act: 'Ari', nos: 'Noa', paid: 'Pat' }[n]],
      )
    ).rows[0].id;
  }
  for (const n of ['exp', 'paid']) {
    await q(`INSERT INTO "CustomerTrial" (id, "userId", "startedAt", "endsAt", "createdAt") VALUES (gen_random_uuid(), $1, $2::timestamp, $3::timestamp, ${NOW})`, [ids[n], ENDED.start, ENDED.end]);
  }
  await q(`INSERT INTO "CustomerTrial" (id, "userId", "startedAt", "endsAt", "createdAt") VALUES (gen_random_uuid(), $1, ${NOW}, ${NOW} + interval '7 days', ${NOW})`, [ids.act]);
  await q(
    `INSERT INTO "BillingAccount" (id, "userId", "stripeCustomerId", livemode, plan, "subscriptionStatus", "cancelAtPeriodEnd", "currentPeriodEnd", "createdAt", "updatedAt")
     VALUES (gen_random_uuid(), $1, $2, false, 'monthly', 'active', false, ${NOW} + interval '30 days', ${NOW}, ${NOW})`,
    [ids.paid, `cus_fictional_browser_s6_${run}`],
  );
  // exp's content from the trial.
  const recipient = (await q(`INSERT INTO "Recipient" (id, "ownerUserId", "firstName", "createdAt", "updatedAt") VALUES (gen_random_uuid(), $1, 'Sofia', ${NOW}, ${NOW}) RETURNING id`, [ids.exp])).rows[0].id;
  const message = (await q(`INSERT INTO "Message" (id, "ownerUserId", title, "textContent", "createdAt", "updatedAt") VALUES (gen_random_uuid(), $1, 'For Sofia', 'Dear Sofia, a synthetic message.', ${NOW}, ${NOW}) RETURNING id`, [ids.exp])).rows[0].id;
  await q(`INSERT INTO "MessageRecipient" (id, "messageId", "recipientId", "createdAt") VALUES (gen_random_uuid(), $1, $2, ${NOW})`, [message, recipient]);
  const memories = [];
  for (const title of ['Beach days', 'First house']) {
    memories.push((await q(`INSERT INTO "MemoryVaultItem" (id, "ownerUserId", title, category, "textContent", "createdAt", "updatedAt") VALUES (gen_random_uuid(), $1, $2, 'OTHER', 'A synthetic memory.', ${NOW}, ${NOW}) RETURNING id`, [ids.exp, title])).rows[0].id);
  }
  await q(
    `INSERT INTO "MyWishResponse" (id, "ownerUserId", "promptKey", "promptTextSnapshot", "promptVersion", "textContent", "createdAt", "updatedAt")
     VALUES (gen_random_uuid(), $1, 'ceremony.style', 'What kind of ceremony would you like?', 1, 'Something small, by the sea.', ${NOW}, ${NOW})`,
    [ids.exp],
  );
  console.log(JSON.stringify({ run, message, memory: memories[0], memoryToDelete: memories[1], exp: email('exp'), act: email('act'), nos: email('nos'), paid: email('paid') }));
}
await db.end();
