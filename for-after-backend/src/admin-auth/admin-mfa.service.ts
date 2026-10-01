import {
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  InternalServerErrorException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'node:crypto';
import { generateSecret, generateURI, verify } from 'otplib';
import {
  actorTypeFor,
  type AuditActor,
  writeAuditLog,
} from '../audit/audit-log.service.js';
import { ADMIN_ROLES } from '../auth/guards/admin.guard.js';
import {
  AuditEventType,
  UserStatus,
  type UserRole,
} from '../generated/prisma/client.js';
import { positiveInt } from '../media/media.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RedisService } from '../redis/redis.service.js';
import type { SafeUser } from '../users/users.service.js';
import {
  decryptSecret,
  encryptSecret,
  generateRecoveryCode,
  hashRecoveryCode,
  parseTotpKey,
} from './admin-mfa-crypto.js';

// Same for wrong, expired, reused, replayed and exhausted: nothing to probe.
export const INVALID_MFA =
  'The verification code is invalid or has expired. Sign in again if this continues.';
export const TOO_MANY = 'Too many requests. Please try again later.';
export const RECOVERY_CODE_COUNT = 10;
// ±30 s = the current 30 s step and one either side (RFC 6238 §5.2 allows
// one step of network delay). Passed to otplib as epochTolerance, in seconds.
export const TOTP_EPOCH_TOLERANCE_SECONDS = 30;
const RATE_WINDOW_SECONDS = 900;
const PURPOSE = 'admin_login';

export type AdminMfaChallenge = {
  mfaRequired: true;
  mfaSetupRequired: boolean;
  challengeId: string;
  expiresInSeconds: number;
};

type Context = { ip?: string; userAgent?: string };

const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');
// Challenge ids are secrets; logs get a short prefix only.
const ref = (challengeId: string) => challengeId.slice(0, 8);

export const adminMfaSettings = (config: ConfigService) => ({
  challengeTtl: positiveInt(config, 'ADMIN_TOTP_CHALLENGE_TTL_SECONDS', 300),
  maxAttempts: positiveInt(config, 'ADMIN_TOTP_MAX_ATTEMPTS', 5),
  verifyIpLimit: positiveInt(config, 'ADMIN_TOTP_VERIFY_IP_LIMIT', 20),
  issuer: config.get<string>('ADMIN_TOTP_ISSUER') || 'For After',
});

/**
 * Admin second factor (Step 16). A correct admin password only creates a
 * short-lived Redis challenge { userId, purpose, attempts, createdAt }; the
 * full for_after_session is created by the controller after a TOTP or
 * recovery code succeeds here. The admin is re-read from PostgreSQL at every
 * step. Secrets, codes and challenge ids are never logged or audited.
 */
@Injectable()
export class AdminMfaService {
  private readonly logger = new Logger(AdminMfaService.name);
  private readonly key: Buffer;
  readonly settings: ReturnType<typeof adminMfaSettings>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    config: ConfigService,
  ) {
    // Fails startup (clearly, without echoing the value) if missing or weak.
    this.key = parseTotpKey(config.get<string>('ADMIN_TOTP_ENCRYPTION_KEY'));
    this.settings = adminMfaSettings(config);
  }

  /** After a correct admin password. No session is created here. */
  async startChallenge(
    user: SafeUser,
    ctx: Context,
  ): Promise<AdminMfaChallenge> {
    const challengeId = randomBytes(32).toString('base64url');
    const key = this.challengeKey(challengeId);
    await this.redis.client
      .multi()
      .hSet(key, {
        userId: user.id,
        purpose: PURPOSE,
        attempts: 0,
        createdAt: new Date().toISOString(),
      })
      .expire(key, this.settings.challengeTtl)
      .exec();
    const enrolled = await this.isEnrolled(user.id);
    await writeAuditLog(this.prisma, {
      eventType: AuditEventType.ADMIN_PASSWORD_AUTH_SUCCEEDED,
      actor: this.actor(user, ctx),
      subjectType: 'User',
      subjectId: user.id,
    });
    this.logger.log(
      `admin_mfa_challenge_created challenge ${ref(challengeId)} user ${user.id} setup_required ${!enrolled}`,
    );
    return {
      mfaRequired: true,
      mfaSetupRequired: !enrolled,
      challengeId,
      expiresInSeconds: this.settings.challengeTtl,
    };
  }

  /**
   * First-time enrollment: a new secret, stored encrypted and not yet enabled.
   * Returned once; calling again before confirm replaces it.
   */
  async setup(challengeId: string) {
    const challenge = await this.readChallenge(challengeId);
    const admin = await this.loadAdmin(challenge.userId, challengeId);
    if (admin.credential?.enabledAt) {
      throw new ConflictException(
        'Two-factor authentication is already set up.',
      );
    }
    const secret = generateSecret();
    const totpSecretEncrypted = encryptSecret(this.key, secret);
    await this.prisma.adminMfaCredential.upsert({
      where: { userId: admin.id },
      create: { userId: admin.id, totpSecretEncrypted },
      update: { totpSecretEncrypted, lastUsedTimeStep: null },
    });
    this.logger.log(`admin_mfa_setup_started user ${admin.id}`);
    return {
      secret,
      otpauthUri: generateURI({
        issuer: this.settings.issuer,
        label: admin.email,
        secret,
      }),
    };
  }

  /**
   * First valid code enables TOTP and issues recovery codes (plaintext
   * returned once; only hashes stored). Consumes the challenge.
   */
  async confirm(challengeId: string, code: string, ctx: Context) {
    const { admin, timeStep } = await this.checkTotp(
      challengeId,
      code,
      ctx,
      false,
    );
    const recoveryCodes = Array.from(
      { length: RECOVERY_CODE_COUNT },
      generateRecoveryCode,
    );
    const enabled = await this.prisma.$transaction(async (tx) => {
      // Conditional: a concurrent confirm, or a replay, loses here.
      const { count } = await tx.adminMfaCredential.updateMany({
        where: { userId: admin.id, enabledAt: null },
        data: { enabledAt: new Date(), lastUsedTimeStep: timeStep },
      });
      if (!count) return false;
      await tx.adminMfaRecoveryCode.deleteMany({ where: { userId: admin.id } });
      await tx.adminMfaRecoveryCode.createMany({
        data: recoveryCodes.map((c) => ({
          userId: admin.id,
          codeHash: hashRecoveryCode(c),
        })),
      });
      await tx.user.update({
        where: { id: admin.id },
        data: { twoFactorEnabled: true },
      });
      await writeAuditLog(tx, {
        eventType: AuditEventType.ADMIN_MFA_SETUP_COMPLETED,
        actor: this.actor(admin, ctx),
        subjectType: 'User',
        subjectId: admin.id,
      });
      return true;
    });
    if (!enabled) throw await this.failed(admin, ctx, 'totp', 'replay');
    this.logger.log(`admin_mfa_setup_completed user ${admin.id}`);
    return { user: admin.user, recoveryCodes };
  }

  /** Normal sign-in for an enrolled admin. Consumes the challenge. */
  async verifyTotp(challengeId: string, code: string, ctx: Context) {
    const { admin, timeStep } = await this.checkTotp(
      challengeId,
      code,
      ctx,
      true,
    );
    // Atomic replay guard: only a strictly newer time step may win.
    const { count } = await this.prisma.adminMfaCredential.updateMany({
      where: {
        userId: admin.id,
        enabledAt: { not: null },
        OR: [
          { lastUsedTimeStep: null },
          { lastUsedTimeStep: { lt: timeStep } },
        ],
      },
      data: { lastUsedTimeStep: timeStep },
    });
    if (!count) throw await this.failed(admin, ctx, 'totp', 'replay');
    await writeAuditLog(this.prisma, {
      eventType: AuditEventType.ADMIN_MFA_VERIFIED,
      actor: this.actor(admin, ctx),
      subjectType: 'User',
      subjectId: admin.id,
      metadata: { method: 'totp' },
    });
    this.logger.log(`admin_mfa_verified user ${admin.id} method totp`);
    return admin.user;
  }

  /** A one-time recovery code instead of TOTP. Consumes the challenge. */
  async verifyRecoveryCode(
    challengeId: string,
    recoveryCode: string,
    ctx: Context,
  ) {
    const { admin, attempts } = await this.attempt(challengeId, ctx);
    if (!admin.credential?.enabledAt) {
      throw new ConflictException('Two-factor setup is required.');
    }
    const used = await this.prisma.$transaction(async (tx) => {
      // Conditional: each code works exactly once, even under concurrency.
      const { count } = await tx.adminMfaRecoveryCode.updateMany({
        where: {
          userId: admin.id,
          codeHash: hashRecoveryCode(recoveryCode),
          usedAt: null,
        },
        data: { usedAt: new Date() },
      });
      if (!count) return null;
      const remaining = await tx.adminMfaRecoveryCode.count({
        where: { userId: admin.id, usedAt: null },
      });
      await writeAuditLog(tx, {
        eventType: AuditEventType.ADMIN_RECOVERY_CODE_USED,
        actor: this.actor(admin, ctx),
        subjectType: 'User',
        subjectId: admin.id,
        metadata: { remaining },
      });
      return { remaining };
    });
    if (!used) {
      throw await this.failed(
        admin,
        ctx,
        'recovery',
        'wrong_code',
        this.lastAttempt(attempts, challengeId),
      );
    }
    await this.consume(challengeId, admin, ctx, 'recovery');
    this.logger.warn(
      `admin_recovery_code_used user ${admin.id} remaining ${used.remaining}`,
    );
    return { user: admin.user, remainingRecoveryCodes: used.remaining };
  }

  /** After the controller created the session. */
  recordLogin(user: SafeUser, ctx: Context) {
    this.logger.log(`admin_login_success user ${user.id}`);
    return writeAuditLog(this.prisma, {
      eventType: AuditEventType.ADMIN_LOGIN,
      actor: this.actor(user, ctx),
      subjectType: 'User',
      subjectId: user.id,
    });
  }

  recordLogout(user: { id: string; role: UserRole }, ctx: Context) {
    this.logger.log(`admin_logout user ${user.id}`);
    return writeAuditLog(this.prisma, {
      eventType: AuditEventType.ADMIN_LOGOUT,
      actor: this.actor(user, ctx),
      subjectType: 'User',
      subjectId: user.id,
    });
  }

  async isEnrolled(userId: string): Promise<boolean> {
    const found = await this.prisma.adminMfaCredential.findUnique({
      where: { userId },
      select: { enabledAt: true },
    });
    return !!found?.enabledAt;
  }

  // ─── internals ──────────────────────────────────────────────────────────

  // Shared by confirm (enrolled = false) and verify (enrolled = true):
  // counts the attempt, checks the code, consumes the challenge.
  private async checkTotp(
    challengeId: string,
    code: string,
    ctx: Context,
    enrolled: boolean,
  ) {
    const { admin, attempts } = await this.attempt(challengeId, ctx);
    const credential = admin.credential;
    if (!credential || !!credential.enabledAt !== enrolled) {
      throw new ConflictException(
        enrolled
          ? 'Two-factor setup is required.'
          : 'Two-factor authentication is already set up.',
      );
    }
    let secret: string;
    try {
      secret = decryptSecret(this.key, credential.totpSecretEncrypted);
    } catch {
      // Wrong/rotated key or tampered row. Never log the value.
      this.logger.error(`admin_mfa_secret_unreadable user ${admin.id}`);
      throw new InternalServerErrorException();
    }
    const result = await verify({
      secret,
      token: code,
      epochTolerance: TOTP_EPOCH_TOLERANCE_SECONDS,
    });
    // The union also covers HOTP results; a TOTP match always has timeStep.
    if (!result.valid || !('timeStep' in result)) {
      throw await this.failed(
        admin,
        ctx,
        'totp',
        'wrong_code',
        this.lastAttempt(attempts, challengeId),
      );
    }
    await this.consume(challengeId, admin, ctx, 'totp');
    return { admin, timeStep: BigInt(result.timeStep) };
  }

  // Rate limit by IP, then count the attempt atomically with the read.
  private async attempt(challengeId: string, ctx: Context) {
    if (await this.overIpLimit(ctx.ip ?? 'unknown')) {
      this.logger.warn('admin_mfa_rate_limited');
      throw new HttpException(TOO_MANY, HttpStatus.TOO_MANY_REQUESTS);
    }
    const key = this.challengeKey(challengeId);
    const [attempts, challenge] = (await this.redis.client
      .multi()
      .hIncrBy(key, 'attempts', 1)
      .hGetAll(key)
      .exec()) as unknown as [number, Record<string, string>];
    if (challenge.purpose !== PURPOSE || !challenge.userId) {
      // Unknown/expired: HINCRBY just created a stray key; remove it.
      await this.redis.client.del(key);
      this.logger.warn(
        `admin_mfa_failed challenge ${ref(challengeId)}: unknown or expired`,
      );
      throw new UnauthorizedException(INVALID_MFA);
    }
    const admin = await this.loadAdmin(challenge.userId, challengeId);
    if (attempts > this.settings.maxAttempts) {
      throw await this.failed(
        admin,
        ctx,
        'challenge',
        'attempts_exhausted',
        challengeId,
      );
    }
    return { admin, attempts };
  }

  private async readChallenge(challengeId: string) {
    const challenge = await this.redis.client.hGetAll(
      this.challengeKey(challengeId),
    );
    if (challenge.purpose !== PURPOSE || !challenge.userId) {
      this.logger.warn(
        `admin_mfa_failed challenge ${ref(challengeId)}: unknown or expired`,
      );
      throw new UnauthorizedException(INVALID_MFA);
    }
    return challenge as { userId: string };
  }

  // Re-checked at every step: the role or status may have changed since the
  // password was accepted.
  private async loadAdmin(userId: string, challengeId: string) {
    const found = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        status: true,
        emailVerifiedAt: true,
        twoFactorEnabled: true,
        createdAt: true,
        adminMfaCredential: {
          select: {
            totpSecretEncrypted: true,
            enabledAt: true,
          },
        },
      },
    });
    if (
      !found ||
      found.status !== UserStatus.ACTIVE ||
      !ADMIN_ROLES.includes(found.role)
    ) {
      await this.redis.client.del(this.challengeKey(challengeId));
      this.logger.warn(
        `admin_mfa_failed challenge ${ref(challengeId)}: account not eligible`,
      );
      throw new UnauthorizedException(INVALID_MFA);
    }
    const { adminMfaCredential: credential, ...user } = found;
    return { ...user, user, credential };
  }

  // Single use: only the request that deletes the key may continue.
  private async consume(
    challengeId: string,
    admin: { id: string; role: UserRole },
    ctx: Context,
    method: string,
  ) {
    if ((await this.redis.client.del(this.challengeKey(challengeId))) !== 1) {
      throw await this.failed(admin, ctx, method, 'already_used');
    }
  }

  /**
   * Audits and logs one failed second factor; returns the generic 401. With
   * consumeChallengeId the challenge is deleted (attempts used up), so the
   * admin must enter the password again.
   */
  private async failed(
    admin: { id: string; role: UserRole },
    ctx: Context,
    method: string,
    reason: string,
    consumeChallengeId?: string,
  ) {
    if (consumeChallengeId) {
      await this.redis.client.del(this.challengeKey(consumeChallengeId));
      reason += '_challenge_invalidated';
    }
    await writeAuditLog(this.prisma, {
      eventType: AuditEventType.ADMIN_MFA_FAILED,
      actor: this.actor(admin, ctx),
      subjectType: 'User',
      subjectId: admin.id,
      metadata: { method, reason },
    });
    this.logger.warn(`admin_mfa_failed user ${admin.id} ${method}: ${reason}`);
    return new UnauthorizedException(INVALID_MFA);
  }

  // The challenge id to invalidate when this was the last allowed attempt.
  private lastAttempt(attempts: number, challengeId: string) {
    return attempts >= this.settings.maxAttempts ? challengeId : undefined;
  }

  private actor(
    user: { id: string; role: UserRole },
    ctx: Context,
  ): AuditActor {
    return { type: actorTypeFor(user.role), userId: user.id, ...ctx };
  }

  private challengeKey(challengeId: string) {
    return `for_after:admin_auth:challenge:${challengeId}`;
  }

  // Fixed window per IP, shared by every API instance through Redis.
  private async overIpLimit(ip: string) {
    const key = `for_after:admin_auth:rl:verify-ip:${sha256(ip)}`;
    const [count] = (await this.redis.client
      .multi()
      .incr(key)
      .expire(key, RATE_WINDOW_SECONDS, 'NX')
      .exec()) as unknown as [number];
    return count > this.settings.verifyIpLimit;
  }
}
