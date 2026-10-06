import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import type { AuditActor } from '../audit/audit-log.service.js';
import { UserRole, UserStatus } from '../generated/prisma/client.js';
import { SafeUser, UsersService } from '../users/users.service.js';
import { AuthTokensService } from './auth-tokens.service.js';
import { ChangeEmailDto } from './dto/account-token.dto.js';
import { ChangePasswordDto } from './dto/change-password.dto.js';
import { LoginDto } from './dto/login.dto.js';
import { maskEmail, RegisterDto } from './dto/register.dto.js';

const INVALID_CREDENTIALS = 'Invalid email or password.';
// One answer for a wrong, expired, used or superseded link.
export const INVALID_LINK = 'This link is invalid or has expired.';
const EMAIL_TAKEN = 'An account with this email already exists.';
type RequestMeta = { ip?: string; userAgent?: string };
const argon2id = (password: string) =>
  argon2.hash(password, { type: argon2.argon2id });

@Injectable()
export class AuthService {
  // Verified against when the email is unknown, so "no such user" costs the
  // same time as "wrong password" and timing does not reveal which emails exist.
  private readonly dummyHash = argon2.hash(randomBytes(32), {
    type: argon2.argon2id,
  });

  constructor(
    private readonly users: UsersService,
    private readonly tokens: AuthTokensService,
  ) {}

  async register(dto: RegisterDto): Promise<SafeUser> {
    if (await this.users.findByEmail(dto.email)) {
      throw new ConflictException('An account with this email already exists.');
    }
    const user = await this.users.createUser({
      email: dto.email,
      passwordHash: await argon2id(dto.password),
      firstName: dto.firstName,
      lastName: dto.lastName,
    });
    // Phase 04: the verification email goes out in the background; signing in
    // does not depend on it (no documented policy requires verification).
    void this.tokens.sendVerification(user);
    return user;
  }

  /**
   * Answers nothing about the email: callers do not await it, so neither the
   * response nor its timing depends on whether an account exists.
   */
  async resendVerification(email: string): Promise<void> {
    const user = await this.users.findByEmail(email);
    if (user?.status === UserStatus.ACTIVE && !user.emailVerifiedAt) {
      await this.tokens.sendVerification(user);
    }
  }

  /** Same contract as resendVerification. Customers only: admins recover through ops. */
  async requestPasswordReset(email: string): Promise<void> {
    const user = await this.users.findByEmail(email);
    if (user?.status === UserStatus.ACTIVE && user.role === UserRole.CUSTOMER) {
      await this.tokens.sendPasswordReset(user);
    }
  }

  async verifyEmail(
    token: string,
    meta: { ip?: string; userAgent?: string },
  ): Promise<void> {
    if (!(await this.tokens.verifyEmail(token, meta))) {
      throw new BadRequestException(INVALID_LINK);
    }
  }

  /** No session is created: the Customer signs in with the new password. */
  async resetPassword(
    token: string,
    newPassword: string,
    meta: { ip?: string; userAgent?: string },
  ): Promise<void> {
    const hash = await argon2id(newPassword);
    if (!(await this.tokens.resetPassword(token, hash, meta))) {
      throw new BadRequestException(INVALID_LINK);
    }
  }

  async validateLogin(dto: LoginDto): Promise<SafeUser> {
    const found = await this.users.findByEmail(dto.email);
    const valid = await argon2.verify(
      found?.passwordHash ?? (await this.dummyHash),
      dto.password,
    );
    if (!found || !valid) throw new UnauthorizedException(INVALID_CREDENTIALS);

    const { passwordHash: _omit, ...user } = found;
    // Status is checked only after the password, so it cannot be probed without it.
    // Deny by default: only ACTIVE may sign in. PASSED access is an open
    // business decision, so it is refused alongside SUSPENDED and DELETED.
    if (user.status !== UserStatus.ACTIVE) {
      throw new ForbiddenException('This account cannot sign in.');
    }
    return user;
  }

  /**
   * Re-authenticates with the current password, then stores the new Argon2id
   * hash. The caller (already ACTIVE via SessionAuthGuard) re-issues its own
   * session; every other session ends through passwordChangedAt. A wrong
   * current password is 400, not 401: 401 means "your session ended" here.
   */
  async changePassword(
    userId: string,
    dto: ChangePasswordDto,
    actor: AuditActor,
  ): Promise<void> {
    await this.verifyCurrentPassword(userId, dto.currentPassword);
    if (dto.newPassword === dto.currentPassword) {
      throw new BadRequestException(
        'Choose a new password that is different from your current one.',
      );
    }
    await this.users.updatePassword(
      userId,
      await argon2id(dto.newPassword),
      actor,
    );
  }

  /**
   * Re-authentication for sensitive changes (password, email): the one check
   * against the stored Argon2id hash. 400, not 401: 401 means "your session
   * ended" to the app.
   */
  private async verifyCurrentPassword(userId: string, password: string) {
    const hash = await this.users.findPasswordHash(userId);
    if (!hash || !(await argon2.verify(hash, password))) {
      throw new BadRequestException('Your current password is incorrect.');
    }
  }

  /**
   * Phase 08. Password first, so nothing about the new address can be probed
   * without it. User.email is not touched here: the link sent to the new
   * address carries the change. Answers with the masked pending address.
   */
  async requestEmailChange(
    user: SafeUser,
    dto: ChangeEmailDto,
    meta: RequestMeta,
  ): Promise<{ pendingEmail: string }> {
    await this.verifyCurrentPassword(user.id, dto.currentPassword);
    if (dto.newEmail === user.email) {
      throw new BadRequestException('This is already your email address.');
    }
    return this.issueEmailChange(user, dto.newEmail, meta);
  }

  /** A fresh link for the pending address (the old link stops working). */
  async resendEmailChange(
    user: SafeUser,
    meta: RequestMeta,
  ): Promise<{ pendingEmail: string }> {
    const pending = await this.tokens.pendingEmailChange(user.id);
    if (!pending) {
      throw new BadRequestException(
        'There is no email change waiting to be verified.',
      );
    }
    return this.issueEmailChange(user, pending, meta);
  }

  private async issueEmailChange(
    user: SafeUser,
    newEmail: string,
    meta: RequestMeta,
  ): Promise<{ pendingEmail: string }> {
    // A courtesy check; the unique index decides at confirmation.
    if (await this.users.findByEmail(newEmail)) {
      throw new ConflictException(EMAIL_TAKEN);
    }
    const token = await this.tokens.requestEmailChange(user.id, newEmail, meta);
    if (!token) {
      throw new HttpException(
        'Too many email change requests. Please try again later.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    void this.tokens.sendEmailChange(user, newEmail, token);
    return { pendingEmail: maskEmail(newEmail) };
  }

  async cancelEmailChange(userId: string): Promise<void> {
    await this.tokens.cancelEmailChange(userId);
  }

  /**
   * The link alone authorizes this one change (no session needed). Every
   * session of the account ends; the old address is told, in the background.
   */
  async confirmEmailChange(token: string, meta: RequestMeta): Promise<void> {
    const outcome = await this.tokens.confirmEmailChange(token, meta);
    if (outcome.result === 'invalid') {
      throw new BadRequestException(INVALID_LINK);
    }
    if (outcome.result === 'taken') {
      throw new ConflictException(EMAIL_TAKEN);
    }
    void this.tokens.sendEmailChangedNotice(
      outcome.userId,
      outcome.oldEmail,
      outcome.firstName,
    );
  }
}
