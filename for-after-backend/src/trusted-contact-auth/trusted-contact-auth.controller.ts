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
// Same DTOs as the Recipient Portal: email in, then challengeId + 6 digits;
// or an E.164 mobile, then mobile + 6 digits.
import {
  RequestRecipientOtpDto as RequestOtpDto,
  RequestRecipientSmsOtpDto as RequestSmsOtpDto,
  VerifyRecipientOtpDto as VerifyOtpDto,
  VerifyRecipientSmsOtpDto as VerifySmsOtpDto,
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
import { maskMobile } from '../recipients/dto/create-recipient.dto.js';

// Email session -> the email; SMS session -> the mobile, masked.
type TrustedContactMe =
  | { authenticated: true; email: string }
  | { authenticated: true; mobile: string };
const toMe = (principal: TrustedContactPrincipal): TrustedContactMe =>
  'mobile' in principal
    ? { authenticated: true, mobile: maskMobile(principal.mobile) }
    : { authenticated: true, email: principal.emailNormalized };

// Trusted Contact sign-in by email code or SMS code. Separate from /auth
// (Customers) and /recipient-auth: own cookie, own Redis sessions, no
// password, no User.
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
    const signedIn = await this.auth.verifyOtp(
      dto.challengeId,
      dto.code,
      req.ip,
    );
    return this.startSession(req, res, signedIn);
  }

  // Same generic 202 for every valid mobile; only active contacts get an SMS.
  @Post('request-sms-otp')
  @HttpCode(202)
  requestSmsOtp(@Body() dto: RequestSmsOtpDto, @Req() req: Request) {
    return this.auth.requestSmsOtp(dto.mobile, req.ip);
  }

  @Post('verify-sms-otp')
  @HttpCode(200)
  async verifySmsOtp(
    @Body() dto: VerifySmsOtpDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TrustedContactMe> {
    const signedIn = await this.auth.verifySmsOtp(dto.mobile, dto.code, req.ip);
    return this.startSession(req, res, signedIn);
  }

  @ApiCookieAuth(AUTH.trustedContact)
  @Get('me')
  @UseGuards(TrustedContactSessionAuthGuard)
  me(
    @CurrentTrustedContact() contact: TrustedContactPrincipal,
  ): TrustedContactMe {
    return toMe(contact);
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

  // Email and SMS sign-in end here: one cookie, one session store.
  private async startSession(
    req: Request,
    res: Response,
    {
      sessionId,
      principal,
    }: { sessionId: string; principal: TrustedContactPrincipal },
  ): Promise<TrustedContactMe> {
    // Never keep a session id the browser brought along (fixation).
    const previous = readTrustedContactSessionId(req);
    if (previous) await this.auth.destroySession(previous);
    res.cookie(
      TRUSTED_CONTACT_SESSION_COOKIE,
      sessionId,
      this.auth.cookieOptions(),
    );
    return toMe(principal);
  }
}
