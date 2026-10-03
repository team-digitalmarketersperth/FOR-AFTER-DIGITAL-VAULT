import {
  HttpException,
  HttpStatus,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CookieOptions, Request } from 'express';
import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto';
import { maskEmail } from '../auth/dto/register.dto.js';
import { EmailProvider } from '../email/email-provider.js';
import {
  recipientSignInCode,
  trustedContactSignInCode,
} from '../email/email-templates.js';
import { positiveInt } from '../media/media.service.js';
import type { RedisService } from '../redis/redis.service.js';

// Shared passwordless email OTP + opaque Redis session engine. Each principal
// type (Recipient, Trusted Contact) subclasses it with its own env prefix,
// Redis namespace, cookie, pepper and eligibility rule, so one principal's
// challenge or session can never authenticate another.

// Same for wrong, expired, reused, exhausted and no-access.
export const INVALID_CODE =
  'The code is invalid or has expired. Request a new code.';
export const TOO_MANY = 'Too many requests. Please try again later.';

/** Everything an OTP session holds. Authorization is re-checked in PostgreSQL. */
export type OtpPrincipal = { emailNormalized: string };

export type OtpDeliveryInput = {
  email: string;
  code: string;
  expiresInSeconds: number;
};

/**
 * Provider-neutral OTP delivery. Each principal module binds its own token
 * (tests bind a fake). Production delivery is EmailOtpDelivery.
 */
export abstract class OtpDelivery {
  abstract sendOtp(input: OtpDeliveryInput): Promise<void>;
}

/**
 * Sends the code by email (Step 24) straight through the EmailProvider, not a
 * queue: a queued job would keep the plaintext code in Redis job data and
 * failed-job history, where only its hash may live, and a retry after the
 * code expires is useless (the person asks for a new one). requestOtp calls
 * this without awaiting it, so timing never reveals eligibility.
 */
export class EmailOtpDelivery extends OtpDelivery {
  constructor(
    private readonly email: EmailProvider,
    private readonly kind: 'recipient-otp' | 'trusted-contact-otp',
  ) {
    super();
  }

  async sendOtp({ email, code, expiresInSeconds }: OtpDeliveryInput) {
    const render =
      this.kind === 'recipient-otp'
        ? recipientSignInCode
        : trustedContactSignInCode;
    await this.email.send({
      kind: this.kind,
      to: email,
      ...render(code, Math.max(1, Math.round(expiresInSeconds / 60))),
    });
  }
}

// express-session only parses its own cookie, so read ours from the header.
export const readCookie = (req: Request, name: string): string | undefined => {
  const prefix = `${name}=`;
  const found = req.headers.cookie
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix));
  return found?.slice(prefix.length) || undefined;
};

export const otpAuthSettings = (config: ConfigService, prefix: string) => ({
  otpTtl: positiveInt(config, `${prefix}_OTP_TTL_SECONDS`, 600),
  maxAttempts: positiveInt(config, `${prefix}_OTP_MAX_ATTEMPTS`, 5),
  requestLimit: positiveInt(config, `${prefix}_OTP_REQUEST_LIMIT`, 5),
  requestWindow: positiveInt(
    config,
    `${prefix}_OTP_REQUEST_WINDOW_SECONDS`,
    900,
  ),
  ipRequestLimit: positiveInt(config, `${prefix}_OTP_IP_REQUEST_LIMIT`, 20),
  verifyIpLimit: positiveInt(config, `${prefix}_OTP_VERIFY_IP_LIMIT`, 30),
  sessionTtl: positiveInt(config, `${prefix}_SESSION_TTL_SECONDS`, 604800),
});

export type OtpAuthOptions = {
  /** Env prefix, e.g. RECIPIENT → RECIPIENT_OTP_PEPPER. */
  prefix: string;
  /** Redis namespace and log category prefix, e.g. recipient_otp_requested. */
  kind: string;
  /** Generic request-otp message; identical for known and unknown emails. */
  requestedMessage: string;
};

const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('base64url');
// Challenge ids are secrets too; logs get a short prefix only.
const ref = (challengeId: string) => challengeId.slice(0, 8);

/**
 * Plaintext codes are never stored or logged (except the development console
 * delivery). Session and rate-limit keys are hashed, so a Redis dump holds
 * no usable session token and no email address in key names.
 */
export abstract class OtpAuthService {
  protected readonly logger: Logger;
  private readonly pepper: string;
  private readonly isProd: boolean;
  private readonly keys: {
    challenge: (id: string) => string;
    session: (id: string) => string;
    rate: (scope: string, id: string) => string;
  };
  readonly settings: ReturnType<typeof otpAuthSettings>;

  constructor(
    private readonly redis: RedisService,
    private readonly delivery: OtpDelivery,
    private readonly config: ConfigService,
    private readonly options: OtpAuthOptions,
  ) {
    const { prefix, kind } = options;
    this.logger = new Logger(new.target.name);
    const pepper = config.get<string>(`${prefix}_OTP_PEPPER`);
    if (!pepper || pepper.length < 32) {
      throw new Error(
        `${prefix}_OTP_PEPPER is not set or too short. Add a random value of at least 32 characters to .env.`,
      );
    }
    this.pepper = pepper;
    this.isProd = config.get<string>('NODE_ENV') === 'production';
    this.settings = otpAuthSettings(config, prefix);
    this.keys = {
      challenge: (id) => `for_after:${kind}_otp:${id}`,
      session: (id) => `for_after:${kind}_sess:${sha256(id)}`,
      rate: (scope, id) => `for_after:${kind}_rl:${scope}:${sha256(id)}`,
    };
  }

  /** Whether this email may currently sign in. Checked at request and verify. */
  protected abstract hasAccess(emailNormalized: string): Promise<boolean>;

  /**
   * Same response for every valid email, known or not. A code is only sent
   * when the email is eligible, and sending is not awaited, so the response
   * time does not reveal that either.
   */
  async requestOtp(
    emailNormalized: string,
    ip = 'unknown',
  ): Promise<{ challengeId: string; message: string }> {
    const { kind } = this.options;
    const { otpTtl, requestLimit, ipRequestLimit } = this.settings;
    if (
      (await this.overLimit('request-ip', ip, ipRequestLimit)) ||
      (await this.overLimit('request-email', emailNormalized, requestLimit))
    ) {
      this.logger.warn(
        `${kind}_otp_rate_limited request ${maskEmail(emailNormalized)}`,
      );
      throw new HttpException(TOO_MANY, HttpStatus.TOO_MANY_REQUESTS);
    }

    const challengeId = token();
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const eligible = await this.hasAccess(emailNormalized);
    const key = this.keys.challenge(challengeId);
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
      `${kind}_otp_requested challenge ${ref(challengeId)} ${maskEmail(emailNormalized)} eligible ${eligible}`,
    );
    if (eligible) {
      this.delivery
        .sendOtp({ email: emailNormalized, code, expiresInSeconds: otpTtl })
        .catch(() =>
          this.logger.error(
            `${kind}_otp_delivery_failed challenge ${ref(challengeId)}`,
          ),
        );
    }
    return { challengeId, message: this.options.requestedMessage };
  }

  /** Valid code → the challenge is consumed and a new session id returned. */
  async verifyOtp(
    challengeId: string,
    code: string,
    ip = 'unknown',
  ): Promise<{ sessionId: string; principal: OtpPrincipal }> {
    const { kind } = this.options;
    const { maxAttempts, verifyIpLimit } = this.settings;
    if (await this.overLimit('verify-ip', ip, verifyIpLimit)) {
      this.logger.warn(`${kind}_otp_rate_limited verify`);
      throw new HttpException(TOO_MANY, HttpStatus.TOO_MANY_REQUESTS);
    }
    const key = this.keys.challenge(challengeId);
    const fail = async (reason: string, consume: boolean) => {
      if (consume) await this.redis.client.del(key);
      this.logger.warn(
        `${kind}_otp_invalid challenge ${ref(challengeId)}: ${reason}`,
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
      `${kind}_otp_verified challenge ${ref(challengeId)} ${maskEmail(challenge.email)}`,
    );
    const principal = { emailNormalized: challenge.email };
    return { sessionId: await this.createSession(principal), principal };
  }

  async createSession(principal: OtpPrincipal): Promise<string> {
    const sessionId = token();
    await this.redis.client.set(
      this.keys.session(sessionId),
      JSON.stringify({ ...principal, authenticatedAt: new Date() }),
      { expiration: { type: 'EX', value: this.settings.sessionTtl } },
    );
    this.logger.log(
      `${this.options.kind}_session_created ${maskEmail(principal.emailNormalized)}`,
    );
    return sessionId;
  }

  async getSession(sessionId: string): Promise<OtpPrincipal | null> {
    const raw = await this.redis.client.get(this.keys.session(sessionId));
    if (!raw) return null;
    const { emailNormalized } = JSON.parse(raw) as OtpPrincipal;
    return typeof emailNormalized === 'string' ? { emailNormalized } : null;
  }

  async destroySession(sessionId: string): Promise<void> {
    if (await this.redis.client.del(this.keys.session(sessionId))) {
      this.logger.log(`${this.options.kind}_session_logout`);
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
      domain:
        this.config.get<string>(`${this.options.prefix}_COOKIE_DOMAIN`) ||
        undefined,
      maxAge: this.settings.sessionTtl * 1000,
    };
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
    const key = this.keys.rate(scope, id);
    const [count] = (await this.redis.client
      .multi()
      .incr(key)
      .expire(key, this.settings.requestWindow, 'NX')
      .exec()) as unknown as [number];
    return count > limit;
  }
}
