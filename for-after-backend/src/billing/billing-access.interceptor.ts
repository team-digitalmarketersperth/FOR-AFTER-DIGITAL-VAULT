import { HttpException, HttpStatus, Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { UserRole } from '../generated/prisma/client.js';
import { REQUIRES_PLAN } from './billing-access.js';
import { BillingService } from './billing.service.js';

// Reading and DELETE (removing your own content) are never gated (docs/billing.md §3).
const WRITES = new Set(['POST', 'PUT', 'PATCH']);
export const BILLING_REQUIRED = 'Your free trial or plan has ended. Choose a plan to continue.';

/**
 * Runs after the route guards, so req.user is the session's Customer. Only
 * Customers are ever gated; billing off means nothing is gated. Reads the matched
 * route's metadata (@RequiresPlan), never the URL: Express routes case-insensitively,
 * so a URL check can be walked around with /MESSAGES.
 */
@Injectable()
export class BillingAccessInterceptor implements NestInterceptor {
  constructor(
    private readonly billing: BillingService,
    private readonly reflector: Reflector,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler) {
    const req = context.switchToHttp().getRequest<Request>();
    if (
      this.billing.policy.enabled &&
      req.user?.role === UserRole.CUSTOMER &&
      WRITES.has(req.method) &&
      this.reflector.getAllAndOverride<boolean>(REQUIRES_PLAN, [context.getHandler(), context.getClass()]) &&
      !(await this.billing.hasAccess(req.user.id))
    ) {
      throw new HttpException(BILLING_REQUIRED, HttpStatus.PAYMENT_REQUIRED);
    }
    return next.handle();
  }
}
