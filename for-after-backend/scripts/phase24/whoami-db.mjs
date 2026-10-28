// Prints which PostgreSQL database and Redis the current env points at (no credentials).
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pg = require('pg');
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const { rows } = await c.query(`select current_database() as db, (select count(*) from information_schema.tables where table_schema = 'public')::int as tables`);
await c.end();
console.log({ ...rows[0], redis: new URL(process.env.REDIS_URL).host });
