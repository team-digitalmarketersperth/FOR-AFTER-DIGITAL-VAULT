// Step 7 browser fixtures in the ISOLATED test DB only (run through scripts/phase24/isolated-env.mjs).
// Accounts: act (active trial, one memory used), fresh (active trial, no memory), exp (ended trial: a My Story answer
// with two linked memories from a paid era, and a scheduled message), drf (active trial, for the local draft check),
// paid (active subscription). `cleanup <run>` deletes them; `expire <run>` ends drf's trial; `pay <run>` gives drf a
// subscription (simulating an upgrade).
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
const email = (n) => `browser.s7.${n}.${run}@example.test`;
const NOW = `(now() AT TIME ZONE 'UTC')`;
const ENDED = { start: '2026-11-03T00:00:00', end: '2026-11-10T00:00:00' };
const q = (sql, args) => db.query(sql, args);
const idOf = async (n) => (await q(`SELECT id FROM "User" WHERE email = $1`, [email(n)])).rows[0].id;
const subscribe = (userId) =>
  q(
    `INSERT INTO "BillingAccount" (id, "userId", "stripeCustomerId", livemode, plan, "subscriptionStatus", "cancelAtPeriodEnd", "currentPeriodEnd", "createdAt", "updatedAt")
     VALUES (gen_random_uuid(), $1, $2, false, 'monthly', 'active', false, ${NOW} + interval '30 days', ${NOW}, ${NOW})`,
    [userId, `cus_fictional_browser_s7_${userId}`],
  );
const memory = async (owner, title) =>
  (await q(`INSERT INTO "MemoryVaultItem" (id, "ownerUserId", title, category, "textContent", "createdAt", "updatedAt") VALUES (gen_random_uuid(), $1, $2, 'OTHER', 'A synthetic memory.', ${NOW}, ${NOW}) RETURNING id`, [owner, title])).rows[0].id;

if (cmd === 'cleanup') {
  const r = await q(`DELETE FROM "User" WHERE email LIKE $1`, [`browser.s7.%.${run}@example.test`]);
  console.log(JSON.stringify({ deleted: r.rowCount }));
} else if (cmd === 'expire') {
  const r = await q(`UPDATE "CustomerTrial" SET "startedAt" = $2::timestamp, "endsAt" = $3::timestamp WHERE "userId" = $1`, [await idOf('drf'), ENDED.start, ENDED.end]);
  console.log(JSON.stringify({ expired: r.rowCount }));
} else if (cmd === 'pay') {
  await subscribe(await idOf('drf'));
  console.log(JSON.stringify({ paid: 1 }));
} else {
  const hash = await argon2.hash('StrongPassword123!', { type: argon2.argon2id });
  const ids = {};
  for (const n of ['act', 'fresh', 'exp', 'drf', 'paid']) {
    ids[n] = (
      await q(
        `INSERT INTO "User" (id, email, "passwordHash", "firstName", "lastName", role, status, "emailVerifiedAt", "createdAt", "updatedAt")
         VALUES (gen_random_uuid(), $1, $2, $3, 'Test', 'CUSTOMER', 'ACTIVE', ${NOW}, ${NOW}, ${NOW}) RETURNING id`,
        [email(n), hash, { act: 'Ari', fresh: 'Fen', exp: 'Eva', drf: 'Dru', paid: 'Pat' }[n]],
      )
    ).rows[0].id;
  }
  for (const n of ['act', 'fresh', 'drf', 'paid']) {
    await q(`INSERT INTO "CustomerTrial" (id, "userId", "startedAt", "endsAt", "createdAt") VALUES (gen_random_uuid(), $1, ${NOW}, ${NOW} + interval '7 days', ${NOW})`, [ids[n]]);
  }
  await q(`INSERT INTO "CustomerTrial" (id, "userId", "startedAt", "endsAt", "createdAt") VALUES (gen_random_uuid(), $1, $2::timestamp, $3::timestamp, ${NOW})`, [ids.exp, ENDED.start, ENDED.end]);
  await subscribe(ids.paid);
  const actMemory = await memory(ids.act, 'Beach days');
  await memory(ids.paid, 'Paid memory');
  // exp: an answer with two memories linked in a paid era, and a scheduled (on death) message.
  const linked = [await memory(ids.exp, 'Beach days'), await memory(ids.exp, 'Old house')];
  const answer = (
    await q(
      `INSERT INTO "MyStoryResponse" (id, "ownerUserId", "promptKey", "promptTextSnapshot", "promptVersion", "textContent", "createdAt", "updatedAt")
       VALUES (gen_random_uuid(), $1, 'childhood.earliest-memory', 'What is your earliest memory?', 1, 'A house by the sea.', ${NOW}, ${NOW}) RETURNING id`,
      [ids.exp],
    )
  ).rows[0].id;
  for (const m of linked) await q(`INSERT INTO "MyStoryMemoryLink" ("myStoryResponseId", "memoryVaultItemId", "createdAt") VALUES ($1, $2, ${NOW})`, [answer, m]);
  const recipient = (await q(`INSERT INTO "Recipient" (id, "ownerUserId", "firstName", "createdAt", "updatedAt") VALUES (gen_random_uuid(), $1, 'Sofia', ${NOW}, ${NOW}) RETURNING id`, [ids.exp])).rows[0].id;
  const message = (await q(`INSERT INTO "Message" (id, "ownerUserId", title, "textContent", status, "createdAt", "updatedAt") VALUES (gen_random_uuid(), $1, 'For Sofia', 'Dear Sofia, a synthetic message.', 'SCHEDULED', ${NOW}, ${NOW}) RETURNING id`, [ids.exp])).rows[0].id;
  await q(`INSERT INTO "MessageRecipient" (id, "messageId", "recipientId", "createdAt") VALUES (gen_random_uuid(), $1, $2, ${NOW})`, [message, recipient]);
  await q(`INSERT INTO "MessageSchedule" (id, "messageId", "triggerType", "createdAt", "updatedAt") VALUES (gen_random_uuid(), $1, 'ON_DEATH', ${NOW}, ${NOW})`, [message]);
  await q(
    `INSERT INTO "MyWishResponse" (id, "ownerUserId", "promptKey", "promptTextSnapshot", "promptVersion", "textContent", "createdAt", "updatedAt")
     VALUES (gen_random_uuid(), $1, 'ceremony.style', 'What kind of ceremony would you like?', 1, 'Something small.', ${NOW}, ${NOW})`,
    [ids.drf],
  );
  console.log(JSON.stringify({ run, actMemory, message, linked, act: email('act'), fresh: email('fresh'), exp: email('exp'), drf: email('drf'), paid: email('paid') }));
}
await db.end();
