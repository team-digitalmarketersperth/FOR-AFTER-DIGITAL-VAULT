import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
// Same DTOs as the Recipient Portal: email in, then challengeId + 6 digits.
import {
  RequestRecipientOtpDto as RequestOtpDto,
  VerifyRecipientOtpDto as VerifyOtpDto,
} from '../recipient-auth/dto/recipient-otp.dto.js';
import {
  TRUSTED_CONTACT_SESSION_COOKIE,
  TrustedContactAuthService,
  type TrustedContactPrincipal,
} from './trusted-contact-auth.service.js';
import {
  CurrentTrustedContact,
  readTrustedContactSessionId,
  TrustedContactSessionAuthGuard,
} from './trusted-contact-session.guard.js';
import { AUTH } from '../config/swagger.js';

type TrustedContactMe = { authenticated: true; email: string };

// Trusted Contact sign-in. Separate from /auth (Customers) and
// /recipient-auth: own cookie, own Redis sessions, no password, no User.
@ApiTags('Trusted Contact auth')
@Controller('trusted-contact-auth')
export class TrustedContactAuthController {
  constructor(private readonly auth: TrustedContactAuthService) {}

  @Post('request-otp')
  @HttpCode(202)
  requestOtp(@Body() dto: RequestOtpDto, @Req() req: Request) {
    return this.auth.requestOtp(dto.email, req.ip);
  }

  @Post('verify-otp')
  @HttpCode(200)
  async verifyOtp(
    @Body() dto: VerifyOtpDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TrustedContactMe> {
    const { sessionId, principal } = await this.auth.verifyOtp(
      dto.challengeId,
      dto.code,
      req.ip,
    );
    // Never keep a session id the browser brought along (fixation).
    const previous = readTrustedContactSessionId(req);
    if (previous) await this.auth.destroySession(previous);
    res.cookie(
      TRUSTED_CONTACT_SESSION_COOKIE,
      sessionId,
      this.auth.cookieOptions(),
    );
    return { authenticated: true, email: principal.emailNormalized };
  }

  @ApiCookieAuth(AUTH.trustedContact)
  @Get('me')
  @UseGuards(TrustedContactSessionAuthGuard)
  me(
    @CurrentTrustedContact() contact: TrustedContactPrincipal,
  ): TrustedContactMe {
    return { authenticated: true, email: contact.emailNormalized };
  }

  // Safe to call with or without a valid session.
  @ApiCookieAuth(AUTH.trustedContact)
  @Post('logout')
  @HttpCode(204)
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const sessionId = readTrustedContactSessionId(req);
    if (sessionId) await this.auth.destroySession(sessionId);
    // Same path/domain/flags as when set, or the browser keeps the cookie.
    const { maxAge: _omit, ...options } = this.auth.cookieOptions();
    res.clearCookie(TRUSTED_CONTACT_SESSION_COOKIE, options);
  }
}
