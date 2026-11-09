import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';

/**
 * The only place Stripe is called (docs/billing.md §4). Replaced by a fake in
 * tests; no live call is made without keys. Keys and secrets never leave here
 * and are never logged.
 */
@Injectable()
export class StripeGateway {
  private readonly stripe: Stripe | null;
  private readonly webhookSecret: string;
  /** sk_live_… = live; anything else = test. Events from the other mode are rejected. */
  readonly livemode: boolean;

  constructor(config: ConfigService) {
    const key = config.get<string>('STRIPE_SECRET_KEY')?.trim() ?? '';
    this.webhookSecret = config.get<string>('STRIPE_WEBHOOK_SECRET')?.trim() ?? '';
    this.livemode = key.startsWith('sk_live_') || key.startsWith('rk_live_');
    this.stripe = key ? new Stripe(key, { maxNetworkRetries: 1, timeout: 20_000 }) : null;
  }

  get configured() {
    return !!this.stripe && !!this.webhookSecret;
  }

  private client() {
    if (!this.stripe) throw new Error('Stripe is not configured');
    return this.stripe;
  }

  /** Verifies the Stripe-Signature over the exact raw body; throws on any mismatch. */
  constructEvent(rawBody: Buffer, signature: string) {
    return Stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
  }

  createCustomer(userId: string) {
    // Metadata only: Checkout collects the email itself. Idempotent per account.
    return this.client().customers.create({ metadata: { forAfterUserId: userId } }, { idempotencyKey: `customer-${userId}` });
  }

  createCheckout(input: { customer: string; price: string; userId: string; successUrl: string; cancelUrl: string; idempotencyKey: string }) {
    return this.client().checkout.sessions.create(
      {
        mode: 'subscription',
        customer: input.customer,
        client_reference_id: input.userId,
        line_items: [{ price: input.price, quantity: 1 }],
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
      },
      { idempotencyKey: input.idempotencyKey },
    );
  }

  createPortal(customer: string, returnUrl: string) {
    return this.client().billingPortal.sessions.create({ customer, return_url: returnUrl });
  }

  retrieveSubscription(id: string) {
    return this.client().subscriptions.retrieve(id);
  }

  /** Newest first, every status. shortcut: first 100 only, far more than one customer should ever hold. */
  async listSubscriptions(customer: string) {
    return (await this.client().subscriptions.list({ customer, status: 'all', limit: 100 })).data;
  }
}
