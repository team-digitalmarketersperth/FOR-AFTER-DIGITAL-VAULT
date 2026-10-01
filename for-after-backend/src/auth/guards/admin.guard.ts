import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { UserRole } from '../../generated/prisma/client.js';

export const ADMIN_ROLES: UserRole[] = [UserRole.ADMIN, UserRole.SUPER_ADMIN];

// Use after SessionAuthGuard, which re-reads the user (ACTIVE only), enforces
// the admin idle timeout and requires completed MFA for admin sessions. This
// checks it again here, so an admin route can never be reached on role alone.
// Customers get 403. There is no way to register as an admin.
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    return (
      !!req.user &&
      ADMIN_ROLES.includes(req.user.role) &&
      !!req.session?.adminMfaVerifiedAt
    );
  }
}
