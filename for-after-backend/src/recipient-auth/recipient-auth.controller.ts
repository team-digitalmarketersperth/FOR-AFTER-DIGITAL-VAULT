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
  VerifyRecipientOtpDto,
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

type RecipientMe = { authenticated: true; email: string };

// Recipient Portal sign-in. Separate from /auth (Customers): own cookie, own
// Redis sessions, no password, no User record.
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
    const { sessionId, principal } = await this.auth.verifyOtp(
      dto.challengeId,
      dto.code,
      req.ip,
    );
    // Never keep a session id the browser brought along (fixation).
    const previous = readRecipientSessionId(req);
    if (previous) await this.auth.destroySession(previous);
    res.cookie(RECIPIENT_SESSION_COOKIE, sessionId, this.auth.cookieOptions());
    return { authenticated: true, email: principal.emailNormalized };
  }

  @ApiCookieAuth(AUTH.recipient)
  @Get('me')
  @UseGuards(RecipientSessionAuthGuard)
  me(@CurrentRecipient() recipient: RecipientPrincipal): RecipientMe {
    return { authenticated: true, email: recipient.emailNormalized };
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
}
