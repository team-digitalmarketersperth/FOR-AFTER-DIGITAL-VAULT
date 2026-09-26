import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { UserStatus } from '../../generated/prisma/client.js';
import { UsersService } from '../../users/users.service.js';

// Re-reads the user on every request, so a suspended or deleted account is
// locked out immediately and role is never trusted from the session alone.
@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(private readonly users: UsersService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const userId = req.session?.userId;
    const user = userId ? await this.users.findById(userId) : null;
    if (!user || user.status !== UserStatus.ACTIVE) {
      throw new UnauthorizedException();
    }
    req.user = user;
    return true;
  }
}
