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
  TRUSTED_CONTACT_SESSION_COOKIE,
  TrustedContactAuthService,
  type TrustedContactPrincipal,
} from './trusted-contact-auth.service.js';

export const readTrustedContactSessionId = (req: Request): string | undefined =>
  readCookie(req, TRUSTED_CONTACT_SESSION_COOKIE);

/**
 * Trusted Contact routes only. Reads the Trusted Contact cookie (never the
 * Customer or Recipient one) and sets req.trustedContact, never req.user or
 * req.recipient, so principals cannot be mixed up.
 */
@Injectable()
export class TrustedContactSessionAuthGuard implements CanActivate {
  constructor(private readonly auth: TrustedContactAuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const sessionId = readTrustedContactSessionId(req);
    const principal = sessionId ? await this.auth.getSession(sessionId) : null;
    if (!principal) throw new UnauthorizedException();
    req.trustedContact = principal;
    return true;
  }
}

/** The principal loaded by TrustedContactSessionAuthGuard. Only use on guarded routes. */
export const CurrentTrustedContact = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): TrustedContactPrincipal =>
    ctx.switchToHttp().getRequest<Request>().trustedContact!,
);
