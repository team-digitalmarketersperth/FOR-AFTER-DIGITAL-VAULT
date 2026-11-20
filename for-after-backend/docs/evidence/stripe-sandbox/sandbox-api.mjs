// Stripe SANDBOX checkout test: starts the isolated API (:4001, test DB for_after_p24, Redis :6390) with Stripe test
// credentials, and `stripe listen` forwarding signed events to it. Secrets are never printed, logged or written:
//  - STRIPE_SECRET_KEY, STRIPE_PRICE_MONTHLY, STRIPE_PRICE_ANNUAL come from for-after-backend/.env.stripe-sandbox.local
//    (git-ignored by the root `.env*` rule), filled in by the person, not by this script;
//  - STRIPE_WEBHOOK_SECRET comes from `stripe listen --print-secret` at start-up and lives only in the child's env.
// Refuses: live keys, a key/CLI pair on different accounts, prices that aren't active recurring prices on that account.
// Run from for-after-backend:  node docs/evidence/stripe-sandbox/sandbox-api.mjs
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const FILE = new URL('../../../.env.stripe-sandbox.local', import.meta.url);
const WEBHOOK = 'http://localhost:4001/api/v1/webhooks/stripe'; // StripeWebhookController + global prefix api/v1
const EVENTS =
  'checkout.session.completed,customer.subscription.created,customer.subscription.updated,customer.subscription.deleted,invoice.paid,invoice.payment_failed';
const fail = (m) => {
  console.error(`[sandbox] refused: ${m}`);
  process.exit(2);
};
if (!existsSync(FILE))
  fail('for-after-backend/.env.stripe-sandbox.local is missing');
const env = Object.fromEntries(
  readFileSync(FILE, 'utf8')
    .split(/\r?\n/)
    .filter((l) => /^\w+=/.test(l))
    .map((l) => [
      l.slice(0, l.indexOf('=')),
      l
        .slice(l.indexOf('=') + 1)
        .trim()
        .replace(/^"|"$/g, ''),
    ]),
);
const key = env.STRIPE_SECRET_KEY ?? '';
if (!/^(sk|rk)_test_/.test(key))
  fail('STRIPE_SECRET_KEY must be a test-mode key (sk_test_… or rk_test_…)');
const prices = {
  STRIPE_PRICE_MONTHLY: env.STRIPE_PRICE_MONTHLY ?? '',
  STRIPE_PRICE_ANNUAL: env.STRIPE_PRICE_ANNUAL ?? '',
};
if (!Object.values(prices).some(Boolean))
  fail('set at least one of STRIPE_PRICE_MONTHLY / STRIPE_PRICE_ANNUAL');

const api = async (path) => {
  const r = await fetch(`https://api.stripe.com${path}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  const body = await r.json();
  if (!r.ok)
    fail(
      `Stripe ${path.split('?')[0]} answered ${r.status} (${body?.error?.code ?? 'error'})`,
    );
  return body;
};
const account = await api('/v1/account');
for (const [name, id] of Object.entries(prices)) {
  if (!id) continue;
  const p = await api(`/v1/prices/${encodeURIComponent(id)}`);
  if (p.livemode || !p.active || !p.recurring)
    fail(`${name} is not an active recurring test-mode price`);
  console.log(
    `[sandbox] ${name}: ${p.id} ${p.unit_amount} ${p.currency}/${p.recurring.interval} (active, test mode)`,
  );
}
// The CLI must be logged in to the same account, or the forwarded events would come from elsewhere.
const cliAccount = JSON.parse(
  execFileSync('stripe', ['get', '/v1/account'], { encoding: 'utf8' }),
).id;
if (cliAccount !== account.id)
  fail(
    `the Stripe CLI is logged in to ${cliAccount}, the key belongs to ${account.id}`,
  );
console.log(
  `[sandbox] account ${account.id} (${account.settings?.dashboard?.display_name ?? 'unnamed'}), livemode false; CLI matches`,
);

const whsec = execFileSync('stripe', ['listen', '--print-secret'], {
  encoding: 'utf8',
}).trim();
if (!whsec.startsWith('whsec_'))
  fail('stripe listen did not return a signing secret');

const childEnv = {
  ...process.env,
  PORT: '4001',
  FRONTEND_URL: 'http://localhost:3001',
  EMAIL_PROVIDER: 'disabled',
  TWILIO_ACCOUNT_SID: '',
  TWILIO_AUTH_TOKEN: '',
  TWILIO_VERIFY_SERVICE_SID: '',
  TWILIO_MESSAGING_SERVICE_SID: '',
  OBSERVE_APP_KEY: '',
  OBSERVE_APP_SECRET: '',
  STRIPE_SECRET_KEY: key,
  STRIPE_WEBHOOK_SECRET: whsec,
  ...prices,
};
const procs = [
  spawn(
    'node',
    ['scripts/phase24/isolated-env.mjs', '--', 'node', 'dist/main'],
    { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] },
  ),
  spawn('stripe', ['listen', '--forward-to', WEBHOOK, '--events', EVENTS], {
    stdio: ['ignore', 'pipe', 'pipe'],
  }),
];
// Only lines that carry no secret: Nest start-up/errors and the CLI's per-event delivery lines ("--> event [evt_…]").
const show = (tag) => (buf) =>
  String(buf)
    .split(/\r?\n/)
    .filter(
      (l) =>
        /API started|ERROR|EADDRINUSE|-->|<--|Ready!/.test(l) &&
        !/whsec_|sk_test_|rk_test_/.test(l),
    )
    .forEach((l) =>
      console.log(`[${tag}] ${l.replace(/\x1b\[[0-9;]*m/g, '')}`),
    );
procs[0].stdout.on('data', show('api'));
procs[0].stderr.on('data', show('api'));
procs[1].stdout.on('data', show('listen'));
procs[1].stderr.on('data', show('listen'));
const stop = () => procs.forEach((p) => p.kill());
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
