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
import {
  RequestRecipientOtpDto,
  RequestRecipientSmsOtpDto,
  VerifyRecipientOtpDto,
  VerifyRecipientSmsOtpDto,
} from './dto/recipient-otp.dto.js';
import {
  RECIPIENT_SESSION_COOKIE,
  RecipientAuthService,
  type RecipientPrincipal,
} from './recipient-auth.service.js';
import {
  CurrentRecipient,
  readRecipientSessionId,
  RecipientSessionAuthGuard,
} from './recipient-session.guard.js';
import { AUTH } from '../config/swagger.js';
import { maskMobile } from '../recipients/dto/create-recipient.dto.js';

// Email session → the email; SMS session → the mobile, masked.
type RecipientMe =
  | { authenticated: true; email: string }
  | { authenticated: true; mobile: string };
const toMe = (principal: RecipientPrincipal): RecipientMe =>
  'mobile' in principal
    ? { authenticated: true, mobile: maskMobile(principal.mobile) }
    : { authenticated: true, email: principal.emailNormalized };

// Recipient Portal sign-in by email code or SMS code. Separate from /auth
// (Customers): own cookie, own Redis sessions, no password, no User record.
@ApiTags('Recipient auth')
@Controller('recipient-auth')
export class RecipientAuthController {
  constructor(private readonly auth: RecipientAuthService) {}

  @Post('request-otp')
  @HttpCode(202)
  requestOtp(@Body() dto: RequestRecipientOtpDto, @Req() req: Request) {
    return this.auth.requestOtp(dto.email, req.ip);
  }

  @Post('verify-otp')
  @HttpCode(200)
  async verifyOtp(
    @Body() dto: VerifyRecipientOtpDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RecipientMe> {
    const signedIn = await this.auth.verifyOtp(
      dto.challengeId,
      dto.code,
      req.ip,
    );
    return this.startSession(req, res, signedIn);
  }

  // Same generic 202 for every valid mobile; only eligible ones get an SMS.
  @Post('request-sms-otp')
  @HttpCode(202)
  requestSmsOtp(@Body() dto: RequestRecipientSmsOtpDto, @Req() req: Request) {
    return this.auth.requestSmsOtp(dto.mobile, req.ip);
  }

  @Post('verify-sms-otp')
  @HttpCode(200)
  async verifySmsOtp(
    @Body() dto: VerifyRecipientSmsOtpDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RecipientMe> {
    const signedIn = await this.auth.verifySmsOtp(dto.mobile, dto.code, req.ip);
    return this.startSession(req, res, signedIn);
  }

  @ApiCookieAuth(AUTH.recipient)
  @Get('me')
  @UseGuards(RecipientSessionAuthGuard)
  me(@CurrentRecipient() recipient: RecipientPrincipal): RecipientMe {
    return toMe(recipient);
  }

  // Safe to call with or without a valid session.
  @ApiCookieAuth(AUTH.recipient)
  @Post('logout')
  @HttpCode(204)
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const sessionId = readRecipientSessionId(req);
    if (sessionId) await this.auth.destroySession(sessionId);
    // Same path/domain/flags as when set, or the browser keeps the cookie.
    const { maxAge: _omit, ...options } = this.auth.cookieOptions();
    res.clearCookie(RECIPIENT_SESSION_COOKIE, options);
  }

  // Email and SMS sign-in end here: one cookie, one session store.
  private async startSession(
    req: Request,
    res: Response,
    { sessionId, principal }: { sessionId: string; principal: RecipientPrincipal },
  ): Promise<RecipientMe> {
    // Never keep a session id the browser brought along (fixation).
    const previous = readRecipientSessionId(req);
    if (previous) await this.auth.destroySession(previous);
    res.cookie(RECIPIENT_SESSION_COOKIE, sessionId, this.auth.cookieOptions());
    return toMe(principal);
  }
}
