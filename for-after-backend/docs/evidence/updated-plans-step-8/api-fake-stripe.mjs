// Updated Plans Step 8, LOCAL browser evidence only. Boots the compiled API (dist) like src/main.ts with the
// StripeGateway replaced by a fake (as ../updated-plans-step-6/api-fake-stripe.mjs), plus subscription reads served
// from a local JSON file (FAKE_SUBS_FILE) so a locally signed webhook (fake STRIPE_WEBHOOK_SECRET) can drive the real
// sync code. No request can reach Stripe. Run through scripts/phase24/isolated-env.mjs. NOT payment evidence.
import { readFileSync } from 'node:fs';
import { Test } from '@nestjs/testing';
import { RedisStore } from 'connect-redis';

const dist = (p) => new URL(`../../../dist/${p}`, import.meta.url).href;
const { AppModule } = await import(dist('app.module.js'));
const { configureApp } = await import(dist('config/app.setup.js'));
const { RedisService } = await import(dist('redis/redis.service.js'));
const { StripeGateway } = await import(dist('billing/stripe-gateway.js'));
const { ConfigService } = await import('@nestjs/config');

const APP = (process.env.FRONTEND_URL ?? 'http://localhost:3001').split(',')[0];
const SUBS = process.env.FAKE_SUBS_FILE;
const subs = () => {
  try {
    return JSON.parse(readFileSync(SUBS, 'utf8'));
  } catch {
    return {};
  }
};
const fake = {
  createCustomer: async (userId) => ({ id: `cus_fake_${userId.slice(0, 8)}`, livemode: false }),
  retrievePrice: async (id) => ({ id, active: true, livemode: false, type: 'recurring', recurring: { interval: id.endsWith('_year') ? 'year' : 'month', interval_count: 1, usage_type: 'licensed' } }),
  // Stands in for Stripe-hosted Checkout: straight back to the app's success URL, with no payment and no webhook.
  createCheckout: async (input) => {
    console.log(`[fake-stripe] checkout created for price ${input.price}`);
    return { url: input.successUrl };
  },
  createPortal: async () => ({ url: `${APP}/settings/plan` }),
  listSubscriptions: async (customer) => Object.values(subs()).filter((s) => s.customer === customer),
  retrieveSubscription: async (id) => {
    const s = subs()[id];
    if (!s) throw new Error(`fake Stripe: no subscription ${id}`);
    return s;
  },
};

const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
  .overrideProvider(StripeGateway)
  .useFactory({ factory: (config) => Object.assign(new StripeGateway(config), fake), inject: [ConfigService] })
  .compile();
const app = moduleRef.createNestApplication({ rawBody: true });
const redis = app.get(RedisService).client;
configureApp(app, new RedisStore({ client: redis, prefix: 'for_after:sess:' }), new RedisStore({ client: redis, prefix: 'for_after:admin_sess:' }));
app.enableShutdownHooks();
await app.listen(process.env.PORT ?? 4001);
console.log('[fake-stripe] API started (Stripe faked, subscriptions from file)');
