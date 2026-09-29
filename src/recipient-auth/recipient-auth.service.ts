import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CookieOptions } from 'express';
import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto';
import { maskEmail } from '../auth/dto/register.dto.js';
import { MessageStatus, Prisma } from '../generated/prisma/client.js';
import { positiveInt } from '../media/media.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RedisService } from '../redis/redis.service.js';
import { RecipientOtpDelivery } from './recipient-otp-delivery.js';

// Never for_after_session: the two principals must not be confused.
export const RECIPIENT_SESSION_COOKIE = 'for_after_recipient_session';
export const OTP_REQUESTED =
  'If released content is available for this email, a verification code has been sent.';
// Same for wrong, expired, reused, exhausted and no-access.
export const INVALID_CODE =
  'The code is invalid or has expired. Request a new code.';
export const TOO_MANY = 'Too many requests. Please try again later.';

/** Everything a Recipient session holds. Authorization is re-checked in PostgreSQL. */
export type RecipientPrincipal = { emailNormalized: string };

/**
 * The only grants that authorize anything: snapshot email matches, Message
 * RELEASED and not deleted. MessageRecipient alone never counts.
 */
export const eligibleGrant = (emailNormalized: string) =>
  ({
    recipientEmailNormalized: emailNormalized,
    message: { status: MessageStatus.RELEASED, deletedAt: null },
  }) satisfies Prisma.RecipientMessageAccessGrantWhereInput;

const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');
// Session and rate-limit keys are hashed, so a Redis dump holds no usable
// session token and no email address in key names.
const keys = {
  challenge: (id: string) => `for_after:recipient_otp:${id}`,
  session: (id: string) => `for_after:recipient_sess:${sha256(id)}`,
  rate: (scope: string, id: string) =>
    `for_after:recipient_rl:${scope}:${sha256(id)}`,
};
const token = () => randomBytes(32).toString('base64url');
// Challenge ids are secrets too; logs get a short prefix only.
const ref = (challengeId: string) => challengeId.slice(0, 8);

/**
 * Recipient Portal passwordless email OTP and opaque Redis sessions. A
 * Recipient is never a User: no password, role or account. Plaintext codes
 * are never stored or logged (except the development console delivery).
 */
@Injectable()
export class RecipientAuthService {
  private readonly logger = new Logger(RecipientAuthService.name);
  private readonly pepper: string;
  private readonly isProd: boolean;
  readonly settings: ReturnType<typeof recipientAuthSettings>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly delivery: RecipientOtpDelivery,
    private readonly config: ConfigService,
  ) {
    const pepper = config.get<string>('RECIPIENT_OTP_PEPPER');
    if (!pepper || pepper.length < 32) {
      throw new Error(
        'RECIPIENT_OTP_PEPPER is not set or too short. Add a random value of at least 32 characters to .env.',
      );
    }
    this.pepper = pepper;
    this.isProd = config.get<string>('NODE_ENV') === 'production';
    this.settings = recipientAuthSettings(config);
  }

  /**
   * Same response for every valid email, known or not. A code is only sent
   * when the email has released content, and sending is not awaited, so the
   * response time does not reveal that either.
   */
  async requestOtp(
    emailNormalized: string,
    ip = 'unknown',
  ): Promise<{ challengeId: string; message: string }> {
    const { otpTtl, requestLimit, ipRequestLimit } = this.settings;
    if (
      (await this.overLimit('request-ip', ip, ipRequestLimit)) ||
      (await this.overLimit('request-email', emailNormalized, requestLimit))
    ) {
      this.logger.warn(
        `recipient_otp_rate_limited request ${maskEmail(emailNormalized)}`,
      );
      throw new HttpException(TOO_MANY, HttpStatus.TOO_MANY_REQUESTS);
    }

    const challengeId = token();
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const eligible = await this.hasAccess(emailNormalized);
    const key = keys.challenge(challengeId);
    await this.redis.client
      .multi()
      .hSet(key, {
        email: emailNormalized,
        otpHash: this.hash(challengeId, code),
        attempts: 0,
      })
      .expire(key, otpTtl)
      .exec();
    this.logger.log(
      `recipient_otp_requested challenge ${ref(challengeId)} ${maskEmail(emailNormalized)} eligible ${eligible}`,
    );
    if (eligible) {
      this.delivery
        .sendOtp({ email: emailNormalized, code, expiresInSeconds: otpTtl })
        .catch(() =>
          this.logger.error(
            `recipient_otp_delivery_failed challenge ${ref(challengeId)}`,
          ),
        );
    }
    return { challengeId, message: OTP_REQUESTED };
  }

  /** Valid code → the challenge is consumed and a new session id returned. */
  async verifyOtp(
    challengeId: string,
    code: string,
    ip = 'unknown',
  ): Promise<{ sessionId: string; principal: RecipientPrincipal }> {
    const { maxAttempts, verifyIpLimit } = this.settings;
    if (await this.overLimit('verify-ip', ip, verifyIpLimit)) {
      this.logger.warn(`recipient_otp_rate_limited verify`);
      throw new HttpException(TOO_MANY, HttpStatus.TOO_MANY_REQUESTS);
    }
    const key = keys.challenge(challengeId);
    const fail = async (reason: string, consume: boolean) => {
      if (consume) await this.redis.client.del(key);
      this.logger.warn(
        `recipient_otp_invalid challenge ${ref(challengeId)}: ${reason}`,
      );
      return new UnauthorizedException(INVALID_CODE);
    };

    // Count the attempt before comparing, atomically with the read.
    const [attempts, challenge] = (await this.redis.client
      .multi()
      .hIncrBy(key, 'attempts', 1)
      .hGetAll(key)
      .exec()) as unknown as [number, Record<string, string>];
    // Expired/unknown: HINCRBY just created a stray key; remove it.
    if (!challenge.otpHash) throw await fail('unknown or expired', true);
    if (attempts > maxAttempts) throw await fail('attempts exhausted', true);
    const expected = Buffer.from(challenge.otpHash, 'hex');
    const actual = Buffer.from(this.hash(challengeId, code), 'hex');
    if (!timingSafeEqual(expected, actual)) {
      throw await fail('wrong code', attempts >= maxAttempts);
    }
    // Single use: only the request that deletes the key may continue.
    if ((await this.redis.client.del(key)) !== 1) {
      throw await fail('already used', false);
    }
    // Re-checked now: access may have changed since the code was requested.
    if (!(await this.hasAccess(challenge.email))) {
      throw await fail('no eligible access', false);
    }

    this.logger.log(
      `recipient_otp_verified challenge ${ref(challengeId)} ${maskEmail(challenge.email)}`,
    );
    const principal = { emailNormalized: challenge.email };
    return { sessionId: await this.createSession(principal), principal };
  }

  async createSession(principal: RecipientPrincipal): Promise<string> {
    const sessionId = token();
    await this.redis.client.set(
      keys.session(sessionId),
      JSON.stringify({ ...principal, authenticatedAt: new Date() }),
      { expiration: { type: 'EX', value: this.settings.sessionTtl } },
    );
    this.logger.log(
      `recipient_session_created ${maskEmail(principal.emailNormalized)}`,
    );
    return sessionId;
  }

  async getSession(sessionId: string): Promise<RecipientPrincipal | null> {
    const raw = await this.redis.client.get(keys.session(sessionId));
    if (!raw) return null;
    const { emailNormalized } = JSON.parse(raw) as RecipientPrincipal;
    return typeof emailNormalized === 'string' ? { emailNormalized } : null;
  }

  async destroySession(sessionId: string): Promise<void> {
    if (await this.redis.client.del(keys.session(sessionId))) {
      this.logger.log('recipient_session_logout');
    }
  }

  /** Mirrors the Customer cookie: HttpOnly, Lax, Secure in production. */
  cookieOptions(): CookieOptions {
    return {
      httpOnly: true,
      secure: this.isProd,
      sameSite: 'lax',
      path: '/',
      // Unset on localhost (host-only cookie).
      domain: this.config.get<string>('RECIPIENT_COOKIE_DOMAIN') || undefined,
      maxAge: this.settings.sessionTtl * 1000,
    };
  }

  private async hasAccess(emailNormalized: string): Promise<boolean> {
    return (
      (await this.prisma.recipientMessageAccessGrant.count({
        where: eligibleGrant(emailNormalized),
        take: 1,
      })) > 0
    );
  }

  // HMAC with a server-side pepper: a 6-digit code has too little entropy
  // for a bare hash, and binding the challenge id stops hash reuse.
  private hash(challengeId: string, code: string): string {
    return createHmac('sha256', this.pepper)
      .update(`${challengeId}:${code}`)
      .digest('hex');
  }

  // Fixed window per key, shared by every API instance through Redis.
  private async overLimit(scope: string, id: string, limit: number) {
    const key = keys.rate(scope, id);
    const [count] = (await this.redis.client
      .multi()
      .incr(key)
      .expire(key, this.settings.requestWindow, 'NX')
      .exec()) as unknown as [number];
    return count > limit;
  }
}

export const recipientAuthSettings = (config: ConfigService) => ({
  otpTtl: positiveInt(config, 'RECIPIENT_OTP_TTL_SECONDS', 600),
  maxAttempts: positiveInt(config, 'RECIPIENT_OTP_MAX_ATTEMPTS', 5),
  requestLimit: positiveInt(config, 'RECIPIENT_OTP_REQUEST_LIMIT', 5),
  requestWindow: positiveInt(
    config,
    'RECIPIENT_OTP_REQUEST_WINDOW_SECONDS',
    900,
  ),
  ipRequestLimit: positiveInt(config, 'RECIPIENT_OTP_IP_REQUEST_LIMIT', 20),
  verifyIpLimit: positiveInt(config, 'RECIPIENT_OTP_VERIFY_IP_LIMIT', 30),
  sessionTtl: positiveInt(config, 'RECIPIENT_SESSION_TTL_SECONDS', 604800),
});
