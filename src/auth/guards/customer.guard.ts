import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { UserRole } from '../../generated/prisma/client.js';

// Use after SessionAuthGuard, which loads req.user. Vault features are
// Customer-only (docs/authorization.md), so admins get 403 here.
@Injectable()
export class CustomerGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    return req.user?.role === UserRole.CUSTOMER;
  }
}
