import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { UsersModule } from '../users/users.module.js';
import { BillingAccessInterceptor } from './billing-access.interceptor.js';
import { AdminBillingController, BillingController, StripeWebhookController } from './billing.controller.js';
import { BillingService } from './billing.service.js';
import { StripeGateway } from './stripe-gateway.js';

// Step 10 billing (docs/billing.md). Global so Admin → Users can read the same
// access state; the interceptor gates Customer writes app-wide when enabled.
@Global()
@Module({
  imports: [UsersModule],
  controllers: [BillingController, StripeWebhookController, AdminBillingController],
  providers: [BillingService, StripeGateway, { provide: APP_INTERCEPTOR, useClass: BillingAccessInterceptor }],
  exports: [BillingService],
})
export class BillingModule {}
