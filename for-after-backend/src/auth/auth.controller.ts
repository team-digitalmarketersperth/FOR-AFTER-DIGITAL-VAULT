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
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import {
  type AdminMfaChallenge,
  AdminMfaService,
} from '../admin-auth/admin-mfa.service.js';
import {
  endSession,
  establishSession,
  SESSION_COOKIE,
} from '../config/app.setup.js';
import { AuditActorType } from '../generated/prisma/client.js';
import type { SafeUser } from '../users/users.service.js';
import { AuthService } from './auth.service.js';
import { CurrentUser } from './decorators/current-user.decorator.js';
import {
  AccountEmailDto,
  ChangeEmailDto,
  EmailTokenDto,
  ResetPasswordDto,
} from './dto/account-token.dto.js';
import { ChangePasswordDto } from './dto/change-password.dto.js';
import { LoginDto } from './dto/login.dto.js';
import { RegisterDto } from './dto/register.dto.js';
import { ADMIN_ROLES } from './guards/admin.guard.js';
import { CustomerGuard } from './guards/customer.guard.js';
import { SessionAuthGuard } from './guards/session-auth.guard.js';
import { AUTH } from '../config/swagger.js';

// Matches docs/api.md (login: 5/min). Counted in Redis (Phase 04), so the
// limit holds across API instances. Per IP, like every throttled route here.
const FIVE_PER_MINUTE = { default: { limit: 5, ttl: 60_000 } };
const TEN_PER_MINUTE = { default: { limit: 10, ttl: 60_000 } };
// Emailing routes: per IP here; each account also gets at most 3 emails an
// hour (AuthTokensService), so one inbox cannot be flooded from many IPs.
const TEN_PER_HOUR = { default: { limit: 10, ttl: 3_600_000 } };

const SENT_IF_EXISTS =
  'If an account exists for that email, password reset instructions have been sent.';
const VERIFICATION_SENT =
  'If that account still needs verifying, we have sent a new link.';
const meta = (req: Request) => ({
  ip: req.ip,
  userAgent: req.headers['user-agent'],
});

@ApiTags('Customer auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly adminMfa: AdminMfaService,
  ) {}

  @Post('register')
  @UseGuards(ThrottlerGuard)
  @Throttle(FIVE_PER_MINUTE)
  register(@Body() dto: RegisterDto): Promise<SafeUser> {
    return this.auth.register(dto);
  }

  // Phase 04. Signing in does not require a verified email (no documented
  // policy does); emailVerifiedAt is on GET /auth/me.
  @Post('verify-email')
  @HttpCode(200)
  @UseGuards(ThrottlerGuard)
  @Throttle(TEN_PER_MINUTE)
  async verifyEmail(
    @Body() dto: EmailTokenDto,
    @Req() req: Request,
  ): Promise<{ verified: true }> {
    await this.auth.verifyEmail(dto.token, meta(req));
    return { verified: true };
  }

  // Same answer for any email, sent before any lookup (not awaited).
  @Post('resend-verification')
  @HttpCode(202)
  @UseGuards(ThrottlerGuard)
  @Throttle(TEN_PER_HOUR)
  resendVerification(@Body() dto: AccountEmailDto): { message: string } {
    void this.auth.resendVerification(dto.email).catch(() => undefined);
    return { message: VERIFICATION_SENT };
  }

  @Post('forgot-password')
  @HttpCode(202)
  @UseGuards(ThrottlerGuard)
  @Throttle(TEN_PER_HOUR)
  forgotPassword(@Body() dto: AccountEmailDto): { message: string } {
    void this.auth.requestPasswordReset(dto.email).catch(() => undefined);
    return { message: SENT_IF_EXISTS };
  }

  // Ends every existing session of the Customer; creates none.
  @Post('reset-password')
  @HttpCode(200)
  @UseGuards(ThrottlerGuard)
  @Throttle(FIVE_PER_MINUTE)
  async resetPassword(
    @Body() dto: ResetPasswordDto,
    @Req() req: Request,
  ): Promise<{ success: true }> {
    await this.auth.resetPassword(dto.token, dto.newPassword, meta(req));
    return { success: true };
  }

  /**
   * Customer: session created, user returned (unchanged since Step 2).
   * ADMIN / SUPER_ADMIN: the password only opens an MFA challenge; no session
   * is created until /admin-auth/totp/* or /admin-auth/recovery/verify succeeds.
   */
  @Post('login')
  @HttpCode(200)
  @UseGuards(ThrottlerGuard)
  @Throttle(FIVE_PER_MINUTE)
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
  ): Promise<SafeUser | AdminMfaChallenge> {
    const user = await this.auth.validateLogin(dto);
    if (ADMIN_ROLES.includes(user.role)) {
      return this.adminMfa.startChallenge(user, {
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
    }
    await establishSession(req, { userId: user.id, role: user.role });
    return user;
  }

  @ApiCookieAuth(AUTH.customer)
  @Get('me')
  @UseGuards(SessionAuthGuard)
  me(@CurrentUser() user: SafeUser): SafeUser {
    return user;
  }

  /**
   * Customer only (Step 22). This browser stays signed in on a new session id;
   * every other session of this Customer gets 401 on its next request.
   * Recipient and Trusted Contact sessions are separate and unaffected.
   */
  @ApiCookieAuth(AUTH.customer)
  @Post('change-password')
  @HttpCode(200)
  @UseGuards(SessionAuthGuard, CustomerGuard, ThrottlerGuard)
  @Throttle(FIVE_PER_MINUTE)
  async changePassword(
    @CurrentUser() user: SafeUser,
    @Body() dto: ChangePasswordDto,
    @Req() req: Request,
  ): Promise<{ success: true }> {
    await this.auth.changePassword(user.id, dto, {
      type: AuditActorType.CUSTOMER,
      userId: user.id,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    await establishSession(req, { userId: user.id, role: user.role });
    return { success: true };
  }

  // Phase 08: change email. User.email changes only when the link sent to the
  // new address is confirmed; then every session of the account ends.
  @ApiCookieAuth(AUTH.customer)
  @Post('change-email')
  @HttpCode(202)
  @UseGuards(SessionAuthGuard, CustomerGuard, ThrottlerGuard)
  @Throttle(FIVE_PER_MINUTE)
  requestEmailChange(
    @CurrentUser() user: SafeUser,
    @Body() dto: ChangeEmailDto,
    @Req() req: Request,
  ): Promise<{ pendingEmail: string }> {
    return this.auth.requestEmailChange(user, dto, meta(req));
  }

  @ApiCookieAuth(AUTH.customer)
  @Post('change-email/resend')
  @HttpCode(202)
  @UseGuards(SessionAuthGuard, CustomerGuard, ThrottlerGuard)
  @Throttle(TEN_PER_HOUR)
  resendEmailChange(
    @CurrentUser() user: SafeUser,
    @Req() req: Request,
  ): Promise<{ pendingEmail: string }> {
    return this.auth.resendEmailChange(user, meta(req));
  }

  @ApiCookieAuth(AUTH.customer)
  @Post('change-email/cancel')
  @HttpCode(200)
  @UseGuards(SessionAuthGuard, CustomerGuard)
  async cancelEmailChange(
    @CurrentUser() user: SafeUser,
  ): Promise<{ success: true }> {
    await this.auth.cancelEmailChange(user.id);
    return { success: true };
  }

  // Public: the emailed token authorizes only this change, signed in or not.
  @Post('change-email/confirm')
  @HttpCode(200)
  @UseGuards(ThrottlerGuard)
  @Throttle(TEN_PER_MINUTE)
  async confirmEmailChange(
    @Body() dto: EmailTokenDto,
    @Req() req: Request,
  ): Promise<{ changed: true }> {
    await this.auth.confirmEmailChange(dto.token, meta(req));
    return { changed: true };
  }

  // Customer session only (for_after_session); safe without one. Admins sign
  // out with POST /admin-auth/logout, so neither ends the other's session.
  @ApiCookieAuth(AUTH.customer)
  @Post('logout')
  @HttpCode(200)
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ success: true }> {
    await endSession(req, res, SESSION_COOKIE);
    return { success: true };
  }
}
