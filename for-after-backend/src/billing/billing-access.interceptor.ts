import { HttpException, HttpStatus, Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { UserRole } from '../generated/prisma/client.js';
import { noAccessCode, REQUIRES_PLAN } from './billing-access.js';
import { BillingService } from './billing.service.js';

// Reading and DELETE (removing your own content) are never gated (docs/billing.md §3).
const WRITES = new Set(['POST', 'PUT', 'PATCH']);
export const BILLING_REQUIRED = 'Your free trial or plan has ended. Choose a plan to continue.';
// Updated Plans Step 6: the subscription exists but its price matches no plan. Never "choose a plan" (no second purchase).
export const PLAN_UNRESOLVED_MESSAGE = 'We couldn’t match your subscription to a plan yet, so creating and editing are paused. Please contact support.';

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
      this.reflector.getAllAndOverride<boolean>(REQUIRES_PLAN, [context.getHandler(), context.getClass()])
    ) {
      // Checked at the write itself (server time), so a form opened before the trial ended is refused when sent after.
      const access = await this.billing.writeAccess(req.user.id);
      if (!access.hasAccess) {
        throw new HttpException(
          { statusCode: HttpStatus.PAYMENT_REQUIRED, error: 'Payment Required', code: noAccessCode(access.state), message: access.state === 'plan_unresolved' ? PLAN_UNRESOLVED_MESSAGE : BILLING_REQUIRED },
          HttpStatus.PAYMENT_REQUIRED,
        );
      }
    }
    return next.handle();
  }
}
