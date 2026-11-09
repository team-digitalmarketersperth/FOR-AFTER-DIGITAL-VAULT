// Development only: promotes ONE existing, active ADMIN to SUPER_ADMIN.
// There is no API or startup path for this (no self-promotion); it is an
// operator command for a local database, idempotent and audited.
//
// Usage (Node 22.18+, runs TypeScript directly):
//   node scripts/dev-promote-super-admin.ts --id <user uuid> --email <email>
//
// Refuses unless NODE_ENV=development and DATABASE_URL points at localhost.
// Both the id and the email must match the same ACTIVE ADMIN. Existing sessions
// end (passwordChangedAt is the established revocation time, SessionAuthGuard),
// so the account signs in again with its existing password and two-factor.
// Password, email verification and MFA enrolment are not touched.
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import pg from 'pg';

type Query = (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
export type PromoteResult = 'promoted' | 'already_super_admin';

export const isLocalDevelopment = (nodeEnv: string | undefined, databaseUrl: string | undefined) => {
  try {
    return nodeEnv === 'development' && ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(databaseUrl ?? '').hostname);
  } catch {
    return false;
  }
};

/** The whole change in one transaction; throws (and changes nothing) on any mismatch. */
export async function promoteSuperAdmin(query: Query, input: { id: string; email: string }, now = new Date()): Promise<PromoteResult> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.id)) throw new Error('Refusing: --id is not a UUID.');
  const email = input.email.trim().toLowerCase();
  // Prisma stores UTC in these timestamp-without-time-zone columns; a JS Date
  // through pg would be written in local time (hours "in the future" east of
  // UTC, revoking every new session). Write the same UTC wall-clock text Prisma does.
  const at = now.toISOString().replace('Z', '');
  await query('BEGIN');
  try {
    const { rows } = await query('SELECT id, email, role, status, "deletedAt" FROM "User" WHERE id = $1 FOR UPDATE', [input.id]);
    const user = rows[0];
    if (!user || String(user.email).toLowerCase() !== email) throw new Error('Refusing: no account matches both this id and this email.');
    if (user.status !== 'ACTIVE' || user.deletedAt) throw new Error('Refusing: the account is not active.');
    if (user.role === 'SUPER_ADMIN') {
      await query('ROLLBACK');
      return 'already_super_admin';
    }
    if (user.role !== 'ADMIN') throw new Error('Refusing: only an existing ADMIN can be promoted.');
    await query('UPDATE "User" SET role = \'SUPER_ADMIN\', "passwordChangedAt" = $2, "updatedAt" = $2 WHERE id = $1 AND role = \'ADMIN\'', [input.id, at]);
    await query(
      `INSERT INTO "AuditLog" (id, "eventType", "actorType", "actorUserId", "subjectType", "subjectId", metadata, "createdAt")
       VALUES ($1, 'SUPER_ADMIN_BOOTSTRAPPED', 'SYSTEM', NULL, 'User', $2, $3, $4)`,
      [randomUUID(), input.id, JSON.stringify({ previousRole: 'ADMIN', newRole: 'SUPER_ADMIN', via: 'local maintenance script', host: hostname().slice(0, 100) }), at],
    );
    await query('COMMIT');
    return 'promoted';
  } catch (err) {
    await query('ROLLBACK').catch(() => undefined);
    throw err;
  }
}

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

if (process.argv[1]?.endsWith('dev-promote-super-admin.ts')) {
  process.loadEnvFile('.env');
  if (!isLocalDevelopment(process.env.NODE_ENV, process.env.DATABASE_URL)) {
    console.error('Refusing: NODE_ENV must be development and DATABASE_URL local.');
    process.exit(1);
  }
  const id = arg('id');
  const email = arg('email');
  if (!id || !email) {
    console.error('Usage: node scripts/dev-promote-super-admin.ts --id <uuid> --email <email>');
    process.exit(1);
  }
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const result = await promoteSuperAdmin((text, values) => client.query(text, values), { id, email });
    const { rows } = await client.query('SELECT role FROM "User" WHERE id = $1', [id]);
    console.log(result === 'promoted' ? `Promoted. Stored role: ${String(rows[0]?.role)}. Existing sessions are ended; sign in again.` : 'Already SUPER_ADMIN. Nothing changed.');
  } catch (err) {
    console.error(err instanceof Error ? err.message : 'Failed.');
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}
