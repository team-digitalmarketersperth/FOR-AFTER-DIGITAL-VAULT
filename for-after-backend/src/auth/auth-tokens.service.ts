import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'node:crypto';
import {
  type AuditActor,
  type AuditEntry,
  writeAuditLog,
} from '../audit/audit-log.service.js';
import { EmailProvider } from '../email/email-provider.js';
import {
  changeEmail,
  emailChanged,
  resetPassword,
  verifyEmail,
} from '../email/email-templates.js';
import { EmailConfig } from '../email/email.module.js';
import {
  AuditActorType,
  AuditEventType,
  AuthTokenPurpose,
  Prisma,
  UserRole,
  UserStatus,
} from '../generated/prisma/client.js';
import { positiveInt } from '../media/media.service.js';
import { errorCode, PrismaService } from '../prisma/prisma.service.js';
import { maskEmail } from './dto/register.dto.js';

// 256-bit tokens need no pepper or slow hash: SHA-256 makes the stored value
// useless to anyone reading the database, and the unique index does the lookup
// (no comparison in code, so nothing to time).
const sha256 = (token: string) =>
  createHash('sha256').update(token).digest('hex');

// docs/security.md: password reset 3 per hour. Applied per account to both
// emails, counted from the token rows, so no address can be flooded however
// many IPs ask.
const SENDS_PER_HOUR = 3;

type Recipient = { id: string; email: string; firstName: string | null };
/** Who acted, for the audit row (the token's own user). */
type RequestMeta = { ip?: string; userAgent?: string };

export const authTokenSettings = (config: ConfigService) => ({
  verifyTtl: positiveInt(
    config,
    'EMAIL_VERIFICATION_TOKEN_TTL_SECONDS',
    86_400,
  ),
  resetTtl: positiveInt(config, 'PASSWORD_RESET_TOKEN_TTL_SECONDS', 3_600),
});

/**
 * Phase 04: single-use emailed links for email verification and password
 * reset. The raw token exists only in the email; PostgreSQL keeps its hash.
 * Sent straight through EmailProvider like sign-in codes (Step 24): a queued
 * job would keep the raw token in Redis job data and failed-job history.
 */
@Injectable()
export class AuthTokensService {
  private readonly logger = new Logger(AuthTokensService.name);
  readonly settings: ReturnType<typeof authTokenSettings>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailProvider,
    private readonly emailConfig: EmailConfig,
    config: ConfigService,
  ) {
    this.settings = authTokenSettings(config);
  }

  /**
   * New token for (user, purpose); any older unused one is superseded. Null
   * when the account already had SENDS_PER_HOUR this hour. The user row lock
   * serialises concurrent requests, so at most one token is ever live.
   */
  async issue(
    userId: string,
    purpose: AuthTokenPurpose,
    now = new Date(),
    extra: { newEmail?: string; audit?: AuditEntry } = {},
  ): Promise<string | null> {
    const ttl =
      purpose === AuthTokenPurpose.PASSWORD_RESET
        ? this.settings.resetTtl
        : this.settings.verifyTtl;
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId}::uuid FOR UPDATE`;
      const recent = await tx.authToken.count({
        where: {
          userId,
          purpose,
          createdAt: { gt: new Date(now.getTime() - 3_600_000) },
        },
      });
      if (recent >= SENDS_PER_HOUR) return null;
      await tx.authToken.updateMany({
        where: { userId, purpose, consumedAt: null },
        data: { consumedAt: now },
      });
      const token = randomBytes(32).toString('base64url');
      await tx.authToken.create({
        data: {
          userId,
          purpose,
          tokenHash: sha256(token),
          newEmail: extra.newEmail,
          expiresAt: new Date(now.getTime() + ttl * 1000),
        },
      });
      if (extra.audit) await writeAuditLog(tx, extra.audit);
      return token;
    });
  }

  /** Issues and emails a verification link. Never throws: failures are logged. */
  async sendVerification(user: Recipient): Promise<void> {
    await this.send(user, AuthTokenPurpose.EMAIL_VERIFICATION);
  }

  /** Issues and emails a reset link. Never throws: failures are logged. */
  async sendPasswordReset(user: Recipient): Promise<void> {
    await this.send(user, AuthTokenPurpose.PASSWORD_RESET);
  }

  private async send(user: Recipient, purpose: AuthTokenPurpose) {
    const kind =
      purpose === AuthTokenPurpose.PASSWORD_RESET
        ? 'reset-password'
        : 'verify-email';
    try {
      const token = await this.issue(user.id, purpose);
      if (!token) {
        this.logger.warn(`${kind}_capped user ${user.id}`);
        return;
      }
      const render = kind === 'reset-password' ? resetPassword : verifyEmail;
      const ttl =
        kind === 'reset-password'
          ? this.settings.resetTtl
          : this.settings.verifyTtl;
      await this.email.send({
        kind,
        to: user.email,
        ...render(
          this.emailConfig.settings.appBaseUrl,
          token,
          user.firstName,
          ttl,
        ),
      });
      this.logger.log(`${kind}_sent user ${user.id} ${maskEmail(user.email)}`);
    } catch (err) {
      // The provider already logged its safe category; the person can ask again.
      this.logger.error(
        `${kind}_failed user ${user.id} (code: ${errorCode(err)})`,
      );
    }
  }

  /**
   * Marks the token used if it is live and of this purpose; returns its user.
   * The conditional update succeeds for exactly one caller, however many race.
   */
  private async consume(
    tx: Parameters<Parameters<PrismaService['$transaction']>[0]>[0],
    token: string,
    purpose: AuthTokenPurpose,
    now: Date,
  ): Promise<{ userId: string; newEmail: string | null } | null> {
    const row = await tx.authToken.findUnique({
      where: { tokenHash: sha256(token) },
      select: { id: true, userId: true, purpose: true, newEmail: true },
    });
    if (!row || row.purpose !== purpose) return null;
    const { count } = await tx.authToken.updateMany({
      where: { id: row.id, consumedAt: null, expiresAt: { gt: now } },
      data: { consumedAt: now },
    });
    return count === 1 ? { userId: row.userId, newEmail: row.newEmail } : null;
  }

  /** Valid link → emailVerifiedAt set (kept if already set). False otherwise. */
  async verifyEmail(token: string, meta: RequestMeta): Promise<boolean> {
    const now = new Date();
    const userId = await this.prisma.$transaction(async (tx) => {
      const id = (
        await this.consume(tx, token, AuthTokenPurpose.EMAIL_VERIFICATION, now)
      )?.userId;
      if (!id) return null;
      const { count } = await tx.user.updateMany({
        where: { id, emailVerifiedAt: null },
        data: { emailVerifiedAt: now },
      });
      if (count) {
        await writeAuditLog(tx, {
          eventType: AuditEventType.EMAIL_VERIFIED,
          actor: actor(id, meta),
          subjectType: 'User',
          subjectId: id,
        });
      }
      return id;
    });
    this.logger.log(
      userId ? `email_verified user ${userId}` : 'email_verify_invalid_token',
    );
    return !!userId;
  }

  /**
   * Valid link for an ACTIVE Customer → new hash + passwordChangedAt (every
   * existing session ends, SessionAuthGuard) + audit, with the token used and
   * any other reset link superseded: all or nothing. No session is created.
   */
  async resetPassword(
    token: string,
    passwordHash: string,
    meta: RequestMeta,
  ): Promise<boolean> {
    const now = new Date();
    const userId = await this.prisma.$transaction(async (tx) => {
      const id = (
        await this.consume(tx, token, AuthTokenPurpose.PASSWORD_RESET, now)
      )?.userId;
      if (!id) return null;
      const { count } = await tx.user.updateMany({
        where: {
          id,
          role: UserRole.CUSTOMER,
          status: UserStatus.ACTIVE,
          deletedAt: null,
        },
        data: { passwordHash, passwordChangedAt: now },
      });
      if (!count) return null;
      await tx.authToken.updateMany({
        where: {
          userId: id,
          purpose: AuthTokenPurpose.PASSWORD_RESET,
          consumedAt: null,
        },
        data: { consumedAt: now },
      });
      await writeAuditLog(tx, {
        eventType: AuditEventType.PASSWORD_RESET_COMPLETED,
        actor: actor(id, meta),
        subjectType: 'User',
        subjectId: id,
      });
      return id;
    });
    this.logger.log(
      userId
        ? `password_reset_completed user ${userId}`
        : 'password_reset_invalid_token',
    );
    return !!userId;
  }

  /** A new change-email link (older ones superseded). Null when capped this hour. */
  requestEmailChange(
    userId: string,
    newEmail: string,
    meta: RequestMeta,
  ): Promise<string | null> {
    return this.issue(userId, AuthTokenPurpose.EMAIL_CHANGE, new Date(), {
      newEmail,
      audit: {
        eventType: AuditEventType.EMAIL_CHANGE_REQUESTED,
        actor: actor(userId, meta),
        subjectType: 'User',
        subjectId: userId,
      },
    });
  }

  /** The address of the live (unused, unexpired) change request, if any. */
  async pendingEmailChange(userId: string): Promise<string | null> {
    const row = await this.prisma.authToken.findFirst({
      where: {
        userId,
        purpose: AuthTokenPurpose.EMAIL_CHANGE,
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
      select: { newEmail: true },
    });
    return row?.newEmail ?? null;
  }

  /** Ends any pending request: its link stops working. */
  async cancelEmailChange(userId: string): Promise<void> {
    await this.prisma.authToken.updateMany({
      where: {
        userId,
        purpose: AuthTokenPurpose.EMAIL_CHANGE,
        consumedAt: null,
      },
      data: { consumedAt: new Date() },
    });
  }

  /** Emails the link to the NEW address. Never throws: failures are logged. */
  async sendEmailChange(
    user: { id: string; firstName: string | null },
    newEmail: string,
    token: string,
  ): Promise<void> {
    await this.deliver('change-email', user.id, newEmail, () =>
      changeEmail(
        this.emailConfig.settings.appBaseUrl,
        token,
        user.firstName,
        this.settings.verifyTtl,
      ),
    );
  }

  /** The security notice to the OLD address after a change. Best effort. */
  async sendEmailChangedNotice(
    userId: string,
    oldEmail: string,
    firstName: string | null,
  ): Promise<void> {
    await this.deliver('email-changed', userId, oldEmail, () =>
      emailChanged(firstName),
    );
  }

  private async deliver(
    kind: 'change-email' | 'email-changed',
    userId: string,
    to: string,
    render: () => { subject: string; html: string; text: string },
  ) {
    try {
      await this.email.send({ kind, to, ...render() });
      this.logger.log(`${kind}_sent user ${userId} ${maskEmail(to)}`);
    } catch (err) {
      this.logger.error(
        `${kind}_failed user ${userId} (code: ${errorCode(err)})`,
      );
    }
  }

  /**
   * Valid link for an ACTIVE Customer: User.email becomes the requested
   * address, verified (owning that inbox is what the link proves), and
   * emailChangedAt is set (every existing session ends, SessionAuthGuard), all
   * at once. The account's other change and reset links die with it: a reset
   * link still in the old inbox must not reopen the account. 'taken' when the
   * address was claimed meanwhile: the unique index decides and the whole
   * transaction, token included, rolls back.
   */
  async confirmEmailChange(
    token: string,
    meta: RequestMeta,
  ): Promise<EmailChangeResult> {
    const now = new Date();
    let outcome: EmailChangeResult;
    try {
      outcome = await this.prisma.$transaction(async (tx) => {
        const used = await this.consume(
          tx,
          token,
          AuthTokenPurpose.EMAIL_CHANGE,
          now,
        );
        if (!used?.newEmail) return { result: 'invalid' as const };
        const user = await tx.user.findFirst({
          where: {
            id: used.userId,
            role: UserRole.CUSTOMER,
            status: UserStatus.ACTIVE,
            deletedAt: null,
          },
          select: { email: true, firstName: true },
        });
        if (!user) return { result: 'invalid' as const };
        await tx.user.update({
          where: { id: used.userId },
          data: {
            email: used.newEmail,
            emailVerifiedAt: now,
            emailChangedAt: now,
          },
          select: { id: true },
        });
        await tx.authToken.updateMany({
          where: {
            userId: used.userId,
            purpose: {
              in: [
                AuthTokenPurpose.EMAIL_CHANGE,
                AuthTokenPurpose.PASSWORD_RESET,
              ],
            },
            consumedAt: null,
          },
          data: { consumedAt: now },
        });
        await writeAuditLog(tx, {
          eventType: AuditEventType.EMAIL_CHANGED,
          actor: actor(used.userId, meta),
          subjectType: 'User',
          subjectId: used.userId,
        });
        return {
          result: 'changed' as const,
          userId: used.userId,
          oldEmail: user.email,
          firstName: user.firstName,
        };
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      outcome = { result: 'taken' };
    }
    this.logger.log(
      outcome.result === 'changed'
        ? `email_changed user ${outcome.userId}`
        : `email_change_${outcome.result}`,
    );
    return outcome;
  }
}

// Phase 08: the outcome of confirming a change-email link.
export type EmailChangeResult =
  | {
      result: 'changed';
      userId: string;
      oldEmail: string;
      firstName: string | null;
    }
  | { result: 'invalid' }
  | { result: 'taken' };

const isUniqueViolation = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

const actor = (userId: string, meta: RequestMeta): AuditActor => ({
  type: AuditActorType.CUSTOMER,
  userId,
  ...meta,
});
