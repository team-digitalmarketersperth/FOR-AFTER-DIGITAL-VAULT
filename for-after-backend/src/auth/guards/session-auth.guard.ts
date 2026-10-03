import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { UserStatus } from '../../generated/prisma/client.js';
import { positiveInt } from '../../media/media.service.js';
import { UsersService } from '../../users/users.service.js';
import { ADMIN_ROLES } from './admin.guard.js';

// Re-reads the user on every request, so a suspended or deleted account is
// locked out immediately and role is never trusted from the session alone.
// A session signed in before the user's last password change is destroyed.
// Admin sessions additionally need completed MFA and expire after
// ADMIN_SESSION_IDLE_TIMEOUT_SECONDS without a request (Customers unchanged).
@Injectable()
export class SessionAuthGuard implements CanActivate {
  private readonly logger = new Logger(SessionAuthGuard.name);
  private readonly adminIdleMs: number;

  constructor(
    private readonly users: UsersService,
    config: ConfigService,
  ) {
    this.adminIdleMs =
      positiveInt(config, 'ADMIN_SESSION_IDLE_TIMEOUT_SECONDS', 1800) * 1000;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const userId = req.session?.userId;
    const found = userId ? await this.users.findById(userId) : null;
    if (!found || found.status !== UserStatus.ACTIVE) {
      throw new UnauthorizedException();
    }
    const { passwordChangedAt, ...user } = found;
    // Sessions from before Step 22 have no authenticatedAt and count as old.
    if (
      passwordChangedAt &&
      (req.session.authenticatedAt ?? 0) < passwordChangedAt.getTime()
    ) {
      await new Promise<void>((resolve) =>
        req.session.destroy(() => resolve()),
      );
      throw new UnauthorizedException();
    }
    if (ADMIN_ROLES.includes(user.role)) {
      const { adminMfaVerifiedAt, lastActivityAt } = req.session;
      const now = Date.now();
      // No MFA (e.g. a session from before Step 16, or a Customer promoted to
      // admin mid-session) or idle too long: the session is destroyed.
      if (
        !adminMfaVerifiedAt ||
        !lastActivityAt ||
        now - lastActivityAt > this.adminIdleMs
      ) {
        this.logger.warn(
          `admin_session_expired user ${user.id} reason ${adminMfaVerifiedAt ? 'idle' : 'no_mfa'}`,
        );
        await new Promise<void>((resolve) =>
          req.session.destroy(() => resolve()),
        );
        throw new UnauthorizedException();
      }
      // Saved by express-session at the end of the request.
      req.session.lastActivityAt = now;
    }
    req.user = user;
    return true;
  }
}
