import { Body, ConflictException, Controller, Get, HttpCode, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';
import { adminActor } from '../audit/audit-log.service.js';
import { AUTH } from '../config/swagger.js';
import { establishSession } from '../config/app.setup.js';
import { positiveInt } from '../media/media.service.js';
import { UpdateProfileDto } from '../users/dto/update-profile.dto.js';
import { type SafeUser, UsersService } from '../users/users.service.js';
import { AuthService } from './auth.service.js';
import { CurrentUser } from './decorators/current-user.decorator.js';
import { ChangePasswordDto } from './dto/change-password.dto.js';
import { AdminGuard } from './guards/admin.guard.js';
import { SessionAuthGuard } from './guards/session-auth.guard.js';

const TEN_PER_MINUTE = { default: { limit: 10, ttl: 60_000 } };
const FIVE_PER_MINUTE = { default: { limit: 5, ttl: 60_000 } };
const THREE_PER_HOUR = { default: { limit: 3, ttl: 3_600_000 } };

/**
 * The signed-in administrator's OWN account (ADMIN and SUPER_ADMIN): name,
 * password, a link to verify the current email, and a read-only security and
 * session summary. Path under /admin, so only the admin session cookie applies;
 * the account is always the session's (no id is accepted anywhere). Guards:
 * session (ACTIVE, idle timeout, completed MFA) + AdminGuard; global Origin
 * check and no-store. Not here on purpose: email change (Customer-only policy),
 * MFA reset or removal (operations procedure), role/status changes, and a session
 * list (sessions are not indexed per account).
 */
@ApiTags('Admin')
@ApiCookieAuth(AUTH.admin)
@Controller('admin/account')
@UseGuards(SessionAuthGuard, AdminGuard)
export class AdminAccountController {
  private readonly idleTimeoutMinutes: number;

  constructor(
    private readonly auth: AuthService,
    private readonly users: UsersService,
    config: ConfigService,
  ) {
    this.idleTimeoutMinutes = Math.round(positiveInt(config, 'ADMIN_SESSION_IDLE_TIMEOUT_SECONDS', 1800) / 60);
  }

  /** Explicit fields only: never hashes, TOTP secrets, recovery codes, session ids or cookies. */
  @Get()
  async get(@CurrentUser() user: SafeUser, @Req() req: Request) {
    const { twoFactorEnabledAt, recoveryCodesRemaining, passwordChangedAt, signIns } = await this.users.adminSecurity(user.id);
    const at = (ms?: number) => (ms ? new Date(ms) : null);
    return {
      profile: {
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        emailVerified: !!user.emailVerifiedAt,
        role: user.role,
      },
      security: {
        twoFactorEnabled: !!twoFactorEnabledAt,
        twoFactorEnabledAt,
        recoveryCodesRemaining,
        passwordChangedAt,
      },
      session: {
        signedInAt: at(req.session.authenticatedAt),
        twoFactorAt: at(req.session.adminMfaVerifiedAt),
        idleTimeoutMinutes: this.idleTimeoutMinutes,
        expiresAt: req.session.cookie?.expires ?? null,
      },
      recentSignIns: signIns.map((s) => ({ at: s.createdAt, network: s.ipPrefix, device: s.userAgent })),
    };
  }

  /** Name only (the shared DTO; anything else → 400 via forbidNonWhitelisted). */
  @Patch('profile')
  @UseGuards(ThrottlerGuard)
  @Throttle(TEN_PER_MINUTE)
  async updateProfile(@CurrentUser() user: SafeUser, @Body() dto: UpdateProfileDto) {
    const saved = await this.users.updateProfile(user.id, dto);
    return { firstName: saved.firstName, lastName: saved.lastName };
  }

  /**
   * The existing password change (current password, policy, Argon2id,
   * PASSWORD_CHANGED audit). Every other session of this account ends; this
   * browser gets a new session id and keeps the two-factor it completed.
   */
  @Post('password')
  @HttpCode(200)
  @UseGuards(ThrottlerGuard)
  @Throttle(FIVE_PER_MINUTE)
  async changePassword(@CurrentUser() user: SafeUser, @Body() dto: ChangePasswordDto, @Req() req: Request) {
    await this.auth.changePassword(user.id, dto, adminActor(req));
    const { adminMfaVerifiedAt } = req.session;
    await establishSession(req, { userId: user.id, role: user.role, adminMfaVerifiedAt, lastActivityAt: Date.now() });
    return { success: true };
  }

  /** The existing verification link, to this account's own current address only. */
  @Post('verification')
  @HttpCode(202)
  @UseGuards(ThrottlerGuard)
  @Throttle(THREE_PER_HOUR)
  async sendVerification(@CurrentUser() user: SafeUser) {
    if (user.emailVerifiedAt) throw new ConflictException('Your email address is already verified.');
    await this.auth.resendVerification(user.email);
    return { sent: true };
  }
}
