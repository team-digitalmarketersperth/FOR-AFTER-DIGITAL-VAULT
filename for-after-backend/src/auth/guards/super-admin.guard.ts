import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { UserRole } from '../../generated/prisma/client.js';

// Use after SessionAuthGuard and AdminGuard (session, ACTIVE, completed MFA):
// this only narrows an admin route to SUPER_ADMIN, on the role re-read per request.
@Injectable()
export class SuperAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (req.user?.role !== UserRole.SUPER_ADMIN) throw new ForbiddenException('Only a super admin can do this.');
    return true;
  }
}
