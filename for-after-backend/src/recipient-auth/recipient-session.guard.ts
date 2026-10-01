import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { readCookie } from '../otp-auth/otp-auth.service.js';
import {
  RECIPIENT_SESSION_COOKIE,
  RecipientAuthService,
  type RecipientPrincipal,
} from './recipient-auth.service.js';

export const readRecipientSessionId = (req: Request): string | undefined =>
  readCookie(req, RECIPIENT_SESSION_COOKIE);

/**
 * Recipient Portal only. Reads the Recipient cookie (never the Customer
 * session) and loads the Redis session. Sets req.recipient, never req.user,
 * so the two principals cannot be mixed up.
 */
@Injectable()
export class RecipientSessionAuthGuard implements CanActivate {
  constructor(private readonly auth: RecipientAuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const sessionId = readRecipientSessionId(req);
    const principal = sessionId ? await this.auth.getSession(sessionId) : null;
    if (!principal) throw new UnauthorizedException();
    req.recipient = principal;
    return true;
  }
}

/** The principal loaded by RecipientSessionAuthGuard. Only use on guarded routes. */
export const CurrentRecipient = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): RecipientPrincipal =>
    ctx.switchToHttp().getRequest<Request>().recipient!,
);
