import { Body, Controller, Get, Headers, HttpCode, Post, Query, Req, UseGuards, type RawBodyRequest } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { AdminGuard } from '../auth/guards/admin.guard.js';
import { CustomerGuard } from '../auth/guards/customer.guard.js';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard.js';
import { AUTH } from '../config/swagger.js';
import { AuditActorType } from '../generated/prisma/client.js';
import type { SafeUser } from '../users/users.service.js';
import { BillingAdminQueryDto, CheckoutDto } from './billing.dto.js';
import { BillingService } from './billing.service.js';

const WRITE_LIMIT = { default: { limit: 10, ttl: 60_000 } };

/** The signed-in Customer's own plan (session-derived; no owner from the body). */
@ApiTags('Billing')
@ApiCookieAuth(AUTH.customer)
@Controller('billing')
@UseGuards(SessionAuthGuard, CustomerGuard)
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get()
  status(@CurrentUser() user: SafeUser) {
    return this.billing.status(user.id);
  }

  @Post('trial')
  @HttpCode(200)
  @UseGuards(ThrottlerGuard)
  @Throttle(WRITE_LIMIT)
  startTrial(@CurrentUser() user: SafeUser, @Req() req: Request) {
    return this.billing.startTrial(user.id, {
      type: AuditActorType.CUSTOMER,
      userId: user.id,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }

  @Post('checkout')
  @HttpCode(200)
  @UseGuards(ThrottlerGuard)
  @Throttle(WRITE_LIMIT)
  checkout(@CurrentUser() user: SafeUser, @Body() dto: CheckoutDto) {
    return this.billing.checkout(user.id, dto.plan);
  }

  @Post('portal')
  @HttpCode(200)
  @UseGuards(ThrottlerGuard)
  @Throttle(WRITE_LIMIT)
  portal(@CurrentUser() user: SafeUser) {
    return this.billing.portal(user.id);
  }
}

/** Stripe → For After. No session: the signature over the raw body is the only trust. */
@ApiTags('Billing')
@Controller('webhooks/stripe')
export class StripeWebhookController {
  constructor(private readonly billing: BillingService) {}

  @Post()
  @HttpCode(200)
  receive(@Req() req: RawBodyRequest<Request>, @Headers('stripe-signature') signature?: string) {
    return this.billing.webhook(req.rawBody, signature);
  }
}

/** Subscriptions & payments: read-only; SUPER_ADMIN only (docs/billing.md §6). */
@ApiTags('Admin')
@ApiCookieAuth(AUTH.admin)
@Controller('admin/billing/accounts')
@UseGuards(SessionAuthGuard, AdminGuard)
export class AdminBillingController {
  constructor(private readonly billing: BillingService) {}

  @Get()
  list(@Query() query: BillingAdminQueryDto, @Req() req: Request) {
    this.billing.assertSuperAdmin(req.user!.role);
    return this.billing.adminList(query);
  }
}
