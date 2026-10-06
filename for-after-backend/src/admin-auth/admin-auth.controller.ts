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
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { AdminGuard } from '../auth/guards/admin.guard.js';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard.js';
import {
  ADMIN_SESSION_COOKIE,
  endSession,
  establishSession,
} from '../config/app.setup.js';
import type { SafeUser } from '../users/users.service.js';
import { AdminMfaService } from './admin-mfa.service.js';
import {
  AdminMfaChallengeDto,
  AdminRecoveryCodeDto,
  AdminTotpCodeDto,
} from './dto/admin-mfa.dto.js';
import { AUTH } from '../config/swagger.js';

const context = (req: Request) => ({
  ip: req.ip,
  userAgent: req.headers['user-agent'],
});

const adminMe = (user: SafeUser, req: Request) => ({
  id: user.id,
  email: user.email,
  firstName: user.firstName,
  lastName: user.lastName,
  role: user.role,
  mfaEnabled: user.twoFactorEnabled,
  mfaVerified: !!req.session.adminMfaVerifiedAt,
  mfaVerifiedAt: req.session.adminMfaVerifiedAt
    ? new Date(req.session.adminMfaVerifiedAt)
    : null,
});

/**
 * Admin second factor (Step 16). Every POST here needs the challengeId from an
 * admin's POST /auth/login; Customers, Recipients and Trusted Contacts never
 * get one, so they always get 401. Only a successful confirm/verify creates the
 * admin session (for_after_admin_session, never the Customer cookie).
 */
@ApiTags('Admin auth')
@Controller('admin-auth')
export class AdminAuthController {
  constructor(private readonly mfa: AdminMfaService) {}

  @Post('totp/setup')
  @HttpCode(200)
  setup(@Body() dto: AdminMfaChallengeDto) {
    return this.mfa.setup(dto.challengeId);
  }

  @Post('totp/confirm')
  @HttpCode(200)
  async confirm(@Body() dto: AdminTotpCodeDto, @Req() req: Request) {
    const { user, recoveryCodes } = await this.mfa.confirm(
      dto.challengeId,
      dto.code,
      context(req),
    );
    await this.startSession(req, user);
    // Shown once. Only hashes are stored.
    return { ...adminMe(user, req), mfaEnabled: true, recoveryCodes };
  }

  @Post('totp/verify')
  @HttpCode(200)
  async verify(@Body() dto: AdminTotpCodeDto, @Req() req: Request) {
    const user = await this.mfa.verifyTotp(
      dto.challengeId,
      dto.code,
      context(req),
    );
    await this.startSession(req, user);
    return adminMe(user, req);
  }

  @Post('recovery/verify')
  @HttpCode(200)
  async recover(@Body() dto: AdminRecoveryCodeDto, @Req() req: Request) {
    const { user, remainingRecoveryCodes } = await this.mfa.verifyRecoveryCode(
      dto.challengeId,
      dto.recoveryCode,
      context(req),
    );
    await this.startSession(req, user);
    return { ...adminMe(user, req), remainingRecoveryCodes };
  }

  @ApiCookieAuth(AUTH.admin)
  @Get('me')
  @UseGuards(SessionAuthGuard, AdminGuard)
  me(@CurrentUser() user: SafeUser, @Req() req: Request) {
    return adminMe(user, req);
  }

  // Admin session only; a Customer session in the same browser stays. Safe
  // without a session (the audit row is written only for a real one).
  @ApiCookieAuth(AUTH.admin)
  @Post('logout')
  @HttpCode(200)
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ success: true }> {
    const { userId, role, adminMfaVerifiedAt } = await endSession(
      req,
      res,
      ADMIN_SESSION_COOKIE,
    );
    if (userId && role && adminMfaVerifiedAt) {
      await this.mfa.recordLogout({ id: userId, role }, context(req));
    }
    return { success: true };
  }

  private async startSession(req: Request, user: SafeUser) {
    const now = Date.now();
    await establishSession(req, {
      userId: user.id,
      role: user.role,
      adminMfaVerifiedAt: now,
      lastActivityAt: now,
    });
    await this.mfa.recordLogin(user, context(req));
  }
}
