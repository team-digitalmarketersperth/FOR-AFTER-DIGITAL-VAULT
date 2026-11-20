// Updated Plans Step 4 browser fixtures, ISOLATED test DB only (run through scripts/phase24/isolated-env.mjs).
// prem: entitled mapped PREMIUM; comp: entitled mapped COMPLETE. Synthetic tiers set directly (nothing maps Stripe yet).
// Each has a MIXED draft message; prem also has a VIDEO draft with a READY video (from "before") and a My Story answer
// with a READY video and photo. `cleanup <run>` deletes the accounts.
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
const email = (n) => `browser.up4.${n}.${run}@example.test`;
const NOW = `(now() AT TIME ZONE 'UTC')`;
const q = (sql, args) => db.query(sql, args);
const STORY = 'childhood.earliest-memory';

if (cmd === 'tier') {
  // tier <run> <name> <PREMIUM|COMPLETE>: a synthetic plan change mid-session.
  const [name, tier] = process.argv.slice(4); // after: node, script, cmd, run
  const r = await q(`UPDATE "BillingAccount" SET tier = $2::"PaidTier" WHERE "userId" = (SELECT id FROM "User" WHERE email = $1)`, [email(name), tier]);
  console.log(JSON.stringify({ updated: r.rowCount }));
} else if (cmd === 'cleanup') {
  const r = await q(`DELETE FROM "User" WHERE email LIKE $1`, [`browser.up4.%.${run}@example.test`]);
  console.log(JSON.stringify({ deleted: r.rowCount }));
} else {
  const hash = await argon2.hash('StrongPassword123!', { type: argon2.argon2id });
  const out = { run, prem: email('prem'), comp: email('comp'), trial: email('trial') };
  // trial: an enforced active trial with a MIXED draft (Trial Step 4 controls must be unchanged).
  {
    const id = (await q(`INSERT INTO "User" (id, email, "passwordHash", "firstName", "lastName", role, status, "emailVerifiedAt", "createdAt", "updatedAt") VALUES (gen_random_uuid(), $1, $2, 'Tia', 'Test', 'CUSTOMER', 'ACTIVE', ${NOW}, ${NOW}, ${NOW}) RETURNING id`, [email('trial'), hash])).rows[0].id;
    await q(`INSERT INTO "CustomerTrial" (id, "userId", "startedAt", "endsAt", "createdAt") VALUES (gen_random_uuid(), $1, ${NOW}, ${NOW} + interval '7 days', ${NOW})`, [id]);
    out.trialMixed = (await q(`INSERT INTO "Message" (id, "ownerUserId", title, "contentType", "textContent", status, "createdAt", "updatedAt") VALUES (gen_random_uuid(), $1, 'Trial draft', 'MIXED', 'Words.', 'DRAFT', ${NOW}, ${NOW}) RETURNING id`, [id])).rows[0].id;
  }
  for (const [n, tier] of [['prem', 'PREMIUM'], ['comp', 'COMPLETE']]) {
    const id = (await q(`INSERT INTO "User" (id, email, "passwordHash", "firstName", "lastName", role, status, "emailVerifiedAt", "createdAt", "updatedAt") VALUES (gen_random_uuid(), $1, $2, $3, 'Test', 'CUSTOMER', 'ACTIVE', ${NOW}, ${NOW}, ${NOW}) RETURNING id`, [email(n), hash, n === 'prem' ? 'Pria' : 'Cole'])).rows[0].id;
    await q(
      `INSERT INTO "BillingAccount" (id, "userId", "stripeCustomerId", livemode, plan, tier, "subscriptionStatus", "cancelAtPeriodEnd", "currentPeriodEnd", "createdAt", "updatedAt")
       VALUES (gen_random_uuid(), $1, $2, false, 'monthly', $3::"PaidTier", 'active', false, ${NOW} + interval '30 days', ${NOW}, ${NOW})`,
      [id, `cus_fictional_up4_${n}_${run}`, tier],
    );
    const recipient = (await q(`INSERT INTO "Recipient" (id, "ownerUserId", "firstName", "createdAt", "updatedAt") VALUES (gen_random_uuid(), $1, 'Sofia', ${NOW}, ${NOW}) RETURNING id`, [id])).rows[0].id;
    const message = async (title, type, text) => {
      const m = (await q(`INSERT INTO "Message" (id, "ownerUserId", title, "contentType", "textContent", status, "createdAt", "updatedAt") VALUES (gen_random_uuid(), $1, $2, $3::"MessageContentType", $4, 'DRAFT', ${NOW}, ${NOW}) RETURNING id`, [id, title, type, text])).rows[0].id;
      await q(`INSERT INTO "MessageRecipient" (id, "messageId", "recipientId", "createdAt") VALUES (gen_random_uuid(), $1, $2, ${NOW})`, [m, recipient]);
      return m;
    };
    out[`${n}Mixed`] = await message('A mixed message', 'MIXED', 'Dear Sofia, words and pictures.');
    if (n === 'prem') {
      out.premVideo = await message('A video from before', 'VIDEO', null);
      const file = (kind, mime, ext) => [kind, `test/up4/${run}/${randomUUID()}.${ext}`, `fake_${randomUUID()}`, `kept.${ext}`, mime];
      const [k, key, pid, name, mime] = file('VIDEO', 'video/mp4', 'mp4');
      await q(`INSERT INTO "MediaAsset" (id, "ownerUserId", "messageId", kind, status, "storageKey", "providerFileId", "originalFileName", "mimeType", "sizeBytes", "uploadedAt", "createdAt", "updatedAt") VALUES (gen_random_uuid(), $1, $2, $3::"MediaKind", 'READY', $4, $5, $6, $7, 1000, ${NOW}, ${NOW}, ${NOW})`, [id, out.premVideo, k, key, pid, name, mime]);
      const answer = (await q(`INSERT INTO "MyStoryResponse" (id, "ownerUserId", "promptKey", "promptTextSnapshot", "promptVersion", "textContent", "createdAt", "updatedAt") VALUES (gen_random_uuid(), $1, $2, 'What is your earliest memory?', 1, 'A house by the sea.', ${NOW}, ${NOW}) RETURNING id`, [id, STORY])).rows[0].id;
      for (const [kk, mm, ee, nn] of [['VIDEO', 'video/mp4', 'mp4', 'train.mp4'], ['PHOTO', 'image/jpeg', 'jpg', 'platform.jpg']]) {
        await q(`INSERT INTO "MyStoryMediaAsset" (id, "ownerUserId", "myStoryResponseId", kind, status, "storageKey", "providerFileId", "originalFileName", "mimeType", "sizeBytes", "uploadedAt", "createdAt", "updatedAt") VALUES (gen_random_uuid(), $1, $2, $3::"MediaKind", 'READY', $4, $5, $6, $7, 1000, ${NOW}, ${NOW}, ${NOW})`, [id, answer, kk, `test/up4/${run}/${randomUUID()}.${ee}`, `fake_${randomUUID()}`, nn, mm]);
      }
    }
  }
  out.story = STORY;
  console.log(JSON.stringify(out));
}
await db.end();
