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
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import {
  type AdminMfaChallenge,
  AdminMfaService,
} from '../admin-auth/admin-mfa.service.js';
import { establishSession, SESSION_COOKIE } from '../config/app.setup.js';
import { AuditActorType } from '../generated/prisma/client.js';
import type { SafeUser } from '../users/users.service.js';
import { AuthService } from './auth.service.js';
import { CurrentUser } from './decorators/current-user.decorator.js';
import { ChangePasswordDto } from './dto/change-password.dto.js';
import { LoginDto } from './dto/login.dto.js';
import { RegisterDto } from './dto/register.dto.js';
import { ADMIN_ROLES } from './guards/admin.guard.js';
import { CustomerGuard } from './guards/customer.guard.js';
import { SessionAuthGuard } from './guards/session-auth.guard.js';

// Matches docs/api.md (login: 5/min). ponytail: counted in memory per
// instance; move throttler storage to Redis once the API runs >1 instance.
const FIVE_PER_MINUTE = { default: { limit: 5, ttl: 60_000 } };

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

  // Safe to call with or without a valid session. Also the admin logout.
  @Post('logout')
  @HttpCode(200)
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ success: true }> {
    const { userId, role, adminMfaVerifiedAt } = req.session;
    const { path, domain, httpOnly, sameSite, secure } = req.session.cookie;
    await new Promise<void>((resolve, reject) =>
      req.session.destroy((err) => (err ? reject(err) : resolve())),
    );
    if (userId && role && adminMfaVerifiedAt) {
      await this.adminMfa.recordLogout(
        { id: userId, role },
        { ip: req.ip, userAgent: req.headers['user-agent'] },
      );
    }
    // Same path/domain/flags as when set, or the browser keeps the cookie.
    res.clearCookie(SESSION_COOKIE, {
      path,
      domain,
      httpOnly,
      sameSite,
      secure: secure === true,
    });
    return { success: true };
  }
}
