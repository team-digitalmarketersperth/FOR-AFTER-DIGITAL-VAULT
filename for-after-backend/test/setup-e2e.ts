import { randomUUID } from 'node:crypto';
import pg from 'pg';

// Throttler counters live in Redis (Phase 04) and every e2e file signs in from
// 127.0.0.1: a namespace per file and run keeps suites (and reruns within the
// window) from spending each other's limits. Production uses the default.
process.env.THROTTLE_KEY_PREFIX = `for_after:test:${randomUUID()}:throttle:`;

// No e2e run may reach Microsoft (Entra ID or Graph), whatever .env holds: a
// real send would email a real inbox. Suites that test the Graph adapter stub
// fetch themselves (vi.stubGlobal), which replaces this guard for that file.
const MICROSOFT_HOST = /(^|\.)(microsoft\.com|microsoftonline\.com|office\.com|office365\.com|outlook\.com)$/i;
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (MICROSOFT_HOST.test(url.hostname)) {
    return Promise.reject(new Error(`e2e guard: refused a request to ${url.hostname} (no real email in tests)`));
  }
  return realFetch(input, init);
};

// Phase 24: DeadLetterJob has no foreign key, so a suite's dead letters
// outlived its deleted test users, and any worker later started on the same
// database alerted OPS_ALERT_EMAIL about them. After each file, remove the
// dead letters created during it whose entity
// is gone (only this file's cleanup can have hard-deleted those).
const fileStartedAt = new Date();
afterAll(async () => {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query(
      `DELETE FROM "DeadLetterJob" d
       WHERE d."createdAt" >= $1::timestamp AND (
         (d."entityType" = 'MessageRecipientRelease'
           AND NOT EXISTS (SELECT 1 FROM "MessageRecipientRelease" o WHERE o.id = d."entityId"))
         OR (d."entityType" = 'Message'
           AND NOT EXISTS (SELECT 1 FROM "Message" m WHERE m.id = d."entityId"))
         OR (d."entityType" = 'ReleaseNotification'
           AND NOT EXISTS (SELECT 1 FROM "ReleaseNotification" n WHERE n.id = d."entityId"))
         OR (d."entityType" = 'DeathVerificationCase'
           AND NOT EXISTS (SELECT 1 FROM "DeathVerificationCase" c WHERE c.id = d."entityId")))`,
      // "createdAt" is timestamp(3) holding UTC: compare as UTC text, never a
      // JS Date (pg would convert it to the session time zone first).
      [fileStartedAt.toISOString()],
    );
  } finally {
    await client.end();
  }
});
