// Development only: removes dead letters and failed email-delivery jobs whose
// record no longer exists (leftovers from e2e runs against the dev database).
// Never touches delayed/waiting jobs, so scheduled releases are untouched.
//
// Usage: node scripts/dev-clean-orphan-queue-data.mjs
import { Queue } from 'bullmq';
import pg from 'pg';

process.loadEnvFile('.env');
const url = new URL(process.env.DATABASE_URL ?? 'invalid://');
if (
  process.env.NODE_ENV !== 'development' ||
  !['localhost', '127.0.0.1'].includes(url.hostname)
) {
  console.error('Refusing: NODE_ENV must be development and DATABASE_URL local.');
  process.exit(1);
}
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const queue = new Queue(process.env.EMAIL_QUEUE_NAME || 'email-delivery', {
  connection: { url: process.env.REDIS_URL },
});
try {
  const { rowCount } = await client.query(`
    DELETE FROM "DeadLetterJob" d
    WHERE (d."entityType" = 'ReleaseNotification'
           AND NOT EXISTS (SELECT 1 FROM "ReleaseNotification" n WHERE n.id = d."entityId"))
       OR (d."entityType" = 'Message'
           AND NOT EXISTS (SELECT 1 FROM "Message" m WHERE m.id = d."entityId"))`);
  console.log(`dead letters removed: ${rowCount}`);
  for (const job of await queue.getFailed(0, 1000)) {
    const { rowCount: exists } = await client.query(
      'SELECT 1 FROM "ReleaseNotification" WHERE id = $1',
      [job.data?.notificationId],
    );
    if (!exists) {
      await job.remove();
      console.log(`failed job removed: ${job.id}`);
    }
  }
} finally {
  await queue.close();
  await client.end();
}
