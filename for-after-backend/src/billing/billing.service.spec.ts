import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../prisma/prisma.service.js';
import { BillingService } from './billing.service.js';
import { StripeGateway } from './stripe-gateway.js';

const config = (env: Record<string, string> = {}) => ({ get: (k: string) => env[k] }) as unknown as ConfigService;
// Any database use fails the test: the disabled state must not even read.
const noDb = new Proxy({}, { get: () => { throw new Error('database used'); } }) as unknown as PrismaService;

describe('BillingService launch gate', () => {
  it('off by default: everyone keeps access, no trial or checkout can start, webhooks refused', async () => {
    const billing = new BillingService(noDb, new StripeGateway(config()), config());
    expect(billing.policy).toEqual({ enabled: false, enforceFrom: null });
    await expect(billing.hasAccess('u')).resolves.toBe(true);
    await expect(billing.startTrial('u', { type: 'CUSTOMER', userId: 'u' })).rejects.toThrow(NotFoundException);
    await expect(billing.checkout('u', 'monthly')).rejects.toThrow(ServiceUnavailableException);
    await expect(billing.portal('u')).rejects.toThrow(ServiceUnavailableException);
    await expect(billing.webhook(Buffer.from('{}'), 't=1,v1=x')).rejects.toThrow(ServiceUnavailableException);
  });

  it('enabling requires an explicit enforcement date (existing accounts are never switched implicitly)', () => {
    expect(() => new BillingService(noDb, new StripeGateway(config()), config({ BILLING_ENABLED: 'true' }))).toThrow(/BILLING_ENFORCE_FROM/);
    expect(() => new BillingService(noDb, new StripeGateway(config()), config({ BILLING_ENABLED: 'true', BILLING_ENFORCE_FROM: 'soon' }))).toThrow();
  });

  it('live keys are refused at start-up until the after-death decision is recorded; test mode and billing off are unaffected', () => {
    const on = { BILLING_ENABLED: 'true', BILLING_ENFORCE_FROM: '2026-11-01T00:00:00Z', STRIPE_WEBHOOK_SECRET: 'whsec_x' };
    const build = (env: Record<string, string>) => new BillingService(noDb, new StripeGateway(config(env)), config(env));
    expect(() => build({ ...on, STRIPE_SECRET_KEY: 'sk_live_x' })).toThrow(/BILLING_AFTER_DEATH_POLICY_APPROVED/);
    expect(() => build({ ...on, STRIPE_SECRET_KEY: 'rk_live_x', BILLING_AFTER_DEATH_POLICY_APPROVED: 'yes' })).toThrow(/§7/);
    expect(build({ ...on, STRIPE_SECRET_KEY: 'sk_live_x', BILLING_AFTER_DEATH_POLICY_APPROVED: 'true' }).policy.enabled).toBe(true);
    expect(build({ ...on, STRIPE_SECRET_KEY: 'sk_test_x' }).policy.enabled).toBe(true);
    expect(build({ STRIPE_SECRET_KEY: 'sk_live_x' }).policy.enabled).toBe(false);
  });

  it('test keys are test mode; only a live key is live mode', () => {
    expect(new StripeGateway(config({ STRIPE_SECRET_KEY: 'sk_test_x' })).livemode).toBe(false);
    expect(new StripeGateway(config({ STRIPE_SECRET_KEY: 'sk_live_x' })).livemode).toBe(true);
    expect(new StripeGateway(config({ STRIPE_SECRET_KEY: 'sk_test_x' })).configured).toBe(false); // no webhook secret
  });
});
