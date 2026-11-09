// Counts DeadLetterJob rows by queue and whether their entity still exists (no content printed).
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pg = require('pg');
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const { rows } = await c.query(`
  select current_database() db, d."queueName", d."entityType", d."alertStatus", count(*)::int n,
    count(*) filter (where coalesce(m.id, n.id, k.id) is null)::int orphaned
  from "DeadLetterJob" d
  left join "Message" m on d."entityType" = 'Message' and m.id = d."entityId"
  left join "ReleaseNotification" n on d."entityType" = 'ReleaseNotification' and n.id = d."entityId"
  left join "DeathVerificationCase" k on d."entityType" = 'DeathVerificationCase' and k.id = d."entityId"
  group by 1,2,3,4 order by 2,3,4`);
console.table(rows);
await c.end();
