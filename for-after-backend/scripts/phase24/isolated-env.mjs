// Phase 24: run a command against the dedicated test PostgreSQL database and
// Redis only, never the development database or the shared Redis.
//
//   node scripts/phase24/isolated-env.mjs setup          create DB + migrate + mark Redis
//   node scripts/phase24/isolated-env.mjs -- <command…>  run with the test env
//   node scripts/phase24/isolated-env.mjs teardown       drop the test DB
//
// Targets: PostgreSQL database P24_DB_NAME (default for_after_p24) on the same
// local server as .env's DATABASE_URL (credentials reused, never printed), and
// Redis P24_REDIS_URL (default redis://127.0.0.1:6390, the
// for-after-redis-p24 container). Both must be on localhost; the database name
// must end in _p24 or _test; Redis must not be port 6379 (the shared dev Redis)
// and must carry the marker key written by `setup`.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pg = require('pg');
const { createClient } = require('redis');

const MARKER = 'for_after:p24:dedicated-test-redis';
const LOCAL = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

const envFile = Object.fromEntries(
  readFileSync(new URL('../../.env', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter((l) => /^\w+=/.test(l))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')];
    }),
);

const dbName = process.env.P24_DB_NAME || 'for_after_p24';
const devUrl = new URL(envFile.DATABASE_URL);
const testDbUrl = new URL(devUrl);
testDbUrl.pathname = `/${dbName}`;
const adminDbUrl = new URL(devUrl);
adminDbUrl.pathname = '/postgres';
const redisUrl = new URL(process.env.P24_REDIS_URL || 'redis://127.0.0.1:6390');

const fail = (msg) => {
  console.error(`[p24-env] refused: ${msg}`);
  process.exit(2);
};

function checkTargets() {
  if (!LOCAL.has(testDbUrl.hostname)) fail('PostgreSQL is not on localhost');
  if (!/_(p24|test)$/.test(dbName)) fail(`database name ${dbName} must end in _p24 or _test`);
  if (dbName === devUrl.pathname.slice(1)) fail('test database equals the development database');
  if (!LOCAL.has(redisUrl.hostname)) fail('Redis is not on localhost');
  if ((redisUrl.port || '6379') === '6379') fail('Redis port 6379 is the shared development Redis');
}

async function redisMarked() {
  const c = createClient({ url: redisUrl.href });
  await c.connect();
  try {
    return (await c.get(MARKER)) === '1';
  } finally {
    await c.quit();
  }
}

async function setup() {
  checkTargets();
  const admin = new pg.Client({ connectionString: adminDbUrl.href });
  await admin.connect();
  const exists = (await admin.query('select 1 from pg_database where datname = $1', [dbName])).rowCount;
  if (!exists) await admin.query(`create database "${dbName}"`);
  await admin.end();
  console.log(`[p24-env] database ${dbName} ${exists ? 'exists' : 'created'}`);
  await run(['npx', 'prisma', 'migrate', 'deploy']);
  const c = createClient({ url: redisUrl.href });
  await c.connect();
  // Only an empty Redis may become the dedicated one.
  if (!(await c.get(MARKER)) && (await c.dbSize()) > 0) {
    await c.quit();
    fail('Redis is not empty and has no Phase 24 marker; refusing to adopt it');
  }
  await c.set(MARKER, '1');
  await c.quit();
  console.log(`[p24-env] Redis ${redisUrl.host} marked as dedicated`);
}

async function teardown() {
  checkTargets();
  const admin = new pg.Client({ connectionString: adminDbUrl.href });
  await admin.connect();
  await admin.query(`drop database if exists "${dbName}" with (force)`);
  await admin.end();
  console.log(`[p24-env] database ${dbName} dropped (Redis container: docker rm -f for-after-redis-p24)`);
}

function run(argv) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env: {
        ...process.env,
        DATABASE_URL: testDbUrl.href,
        REDIS_URL: redisUrl.href,
        QUEUE_REDIS_URL: redisUrl.href,
        P24_ISOLATED: '1',
      },
    });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(Object.assign(new Error(`exit ${code}`), { code }))));
  });
}

const [cmd, ...rest] = process.argv.slice(2);
try {
  if (cmd === 'setup') await setup();
  else if (cmd === 'teardown') await teardown();
  else if (cmd === '--') {
    checkTargets();
    if (!(await redisMarked())) fail('Redis has no Phase 24 marker; run `setup` first');
    await run(rest);
  } else fail('usage: setup | teardown | -- <command>');
} catch (err) {
  console.error(`[p24-env] ${err.message}`);
  process.exit(err.code ?? 1);
}
