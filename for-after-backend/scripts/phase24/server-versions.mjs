// Prints the PostgreSQL server version and Redis version of the current env (no credentials).
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pg = require('pg');
const { createClient } = require('redis');
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const { rows } = await c.query('show server_version');
await c.end();
const r = createClient({ url: process.env.REDIS_URL });
await r.connect();
const redis = /redis_version:(\S+)/.exec(await r.info('server'))[1];
await r.quit();
console.log({ postgres: rows[0].server_version, redis });
