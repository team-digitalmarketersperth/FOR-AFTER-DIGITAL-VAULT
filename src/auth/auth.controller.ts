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
import { SESSION_COOKIE } from '../config/app.setup.js';
import type { SafeUser } from '../users/users.service.js';
import { AuthService } from './auth.service.js';
import { CurrentUser } from './decorators/current-user.decorator.js';
import { LoginDto } from './dto/login.dto.js';
import { RegisterDto } from './dto/register.dto.js';
import { SessionAuthGuard } from './guards/session-auth.guard.js';

// Matches docs/api.md (login: 5/min). ponytail: counted in memory per
// instance; move throttler storage to Redis once the API runs >1 instance.
const FIVE_PER_MINUTE = { default: { limit: 5, ttl: 60_000 } };

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('register')
  @UseGuards(ThrottlerGuard)
  @Throttle(FIVE_PER_MINUTE)
  register(@Body() dto: RegisterDto): Promise<SafeUser> {
    return this.auth.register(dto);
  }

  @Post('login')
  @HttpCode(200)
  @UseGuards(ThrottlerGuard)
  @Throttle(FIVE_PER_MINUTE)
  async login(@Body() dto: LoginDto, @Req() req: Request): Promise<SafeUser> {
    const user = await this.auth.validateLogin(dto);
    // New session ID on login prevents session fixation.
    await new Promise<void>((resolve, reject) =>
      req.session.regenerate((err) => (err ? reject(err) : resolve())),
    );
    req.session.userId = user.id;
    req.session.role = user.role;
    await new Promise<void>((resolve, reject) =>
      req.session.save((err) => (err ? reject(err) : resolve())),
    );
    return user;
  }

  @Get('me')
  @UseGuards(SessionAuthGuard)
  me(@CurrentUser() user: SafeUser): SafeUser {
    return user;
  }

  // Safe to call with or without a valid session.
  @Post('logout')
  @HttpCode(200)
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ success: true }> {
    const { path, domain, httpOnly, sameSite, secure } = req.session.cookie;
    await new Promise<void>((resolve, reject) =>
      req.session.destroy((err) => (err ? reject(err) : resolve())),
    );
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
