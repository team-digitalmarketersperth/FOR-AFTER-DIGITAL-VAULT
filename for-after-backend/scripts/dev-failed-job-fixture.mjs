// Development only: puts ONE fictional failed job on the local message-release
// queue so the Admin Portal's failed-job list and Retry can be tested in a real
// browser (frontend e2e/admin.spec.ts, E2E_ADMIN_FAILED_JOB).
//
// Safe by construction:
// - refuses unless NODE_ENV=development (read from .env, like the API);
// - the payload is a random message id with no database row, so a retry runs
//   the normal worker, which finds no message, logs "stale" and completes: it
//   can never release anything or touch a death-verification case;
// - it uses BullMQ's documented manual processing (getNextJob + moveToFailed)
//   and refuses to run while any worker is connected or any job is waiting or
//   active, so it can only ever fail its own job. Start the API afterwards.
//
// Usage (API stopped):  node scripts/dev-failed-job-fixture.mjs
// Prints the job id. Remove it with --remove <jobId>.
import { Queue, Worker } from 'bullmq';
import { randomUUID } from 'node:crypto';

process.loadEnvFile('.env');
if (process.env.NODE_ENV !== 'development') {
  console.error('Refusing: NODE_ENV must be development.');
  process.exit(1);
}
const name = process.env.RELEASE_QUEUE_NAME || 'message-release';
const connection = { url: process.env.REDIS_URL };
const queue = new Queue(name, { connection });

try {
  if (process.argv[2] === '--remove') {
    const job = await queue.getJob(process.argv[3]);
    await job?.remove();
    console.log(job ? `removed ${job.id}` : 'no such job');
  } else {
    const [workers, waiting, active] = await Promise.all([
      queue.getWorkers(),
      queue.getWaitingCount(),
      queue.getActiveCount(),
    ]);
    if (workers.length || waiting || active) {
      throw new Error(
        `Refusing: ${workers.length} worker(s), ${waiting} waiting, ${active} active on ${name}. Stop the API first.`,
      );
    }
    const messageId = randomUUID();
    const jobId = `message-release-${messageId}`;
    await queue.add('release', { messageId }, { jobId, attempts: 1 });
    const worker = new Worker(name, null, { connection, autorun: false });
    const token = randomUUID();
    const job = await worker.getNextJob(token);
    if (job?.id !== jobId) {
      throw new Error(`Unexpected job ${job?.id}; nothing was failed.`);
    }
    await job.moveToFailed(
      new Error('E2E fixture: fictional failure for the retry test'),
      token,
    );
    await worker.close();
    console.log(jobId);
  }
} finally {
  await queue.close();
}
