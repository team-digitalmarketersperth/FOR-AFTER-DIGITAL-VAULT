// Development only: puts ONE fictional OPEN dead letter (Phase 17A) into the
// local PostgreSQL so the Admin Portal's Dead letters section, View and Retry
// can be tested in a real browser (frontend e2e/admin.spec.ts,
// E2E_ADMIN_DEAD_LETTER).
//
// Safe by construction:
// - refuses unless NODE_ENV=development and DATABASE_URL is localhost;
// - the entity is a random message id with no database row, so Retry finds
//   nothing to run and resolves it as "stale": no job, release or email;
// - no queue, worker or alert is involved.
//
// Usage: node scripts/dev-dead-letter-fixture.mjs   (prints the id)
// Remove: node scripts/dev-dead-letter-fixture.mjs --remove <id>
import { randomUUID } from 'node:crypto';
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
try {
  if (process.argv[2] === '--remove') {
    const { rowCount } = await client.query(
      'DELETE FROM "DeadLetterJob" WHERE id = $1',
      [process.argv[3]],
    );
    console.log(rowCount ? `removed ${process.argv[3]}` : 'no such dead letter');
  } else {
    const id = randomUUID();
    const messageId = randomUUID();
    await client.query(
      `INSERT INTO "DeadLetterJob" (id, "queueName", "jobId", "jobName", "entityType", "entityId",
         "attemptsMade", "errorCode", "errorMessage", "failedAt", "alertStatus", "updatedAt")
       VALUES ($1, 'message-release', $2, 'release', 'Message', $3, 5, 'ECONNREFUSED',
         'E2E fixture: connect ECONNREFUSED [url]', now(), 'NOT_CONFIGURED', now())`,
      [id, `message-release-${messageId}`, messageId],
    );
    console.log(id);
  }
} finally {
  await client.end();
}
