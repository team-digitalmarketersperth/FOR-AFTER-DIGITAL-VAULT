import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomInt } from 'node:crypto';
import twilio from 'twilio';
import { maskMobile } from '../recipients/dto/create-recipient.dto.js';

/**
 * A failed provider call. `code` is a short, safe category (e.g. twilio_60200),
 * never a provider response, SID or credential.
 */
export class SmsVerificationError extends Error {
  constructor(readonly code: string) {
    super(`sms_verification_failed: ${code}`);
    this.name = 'SmsVerificationError';
  }
}

/**
 * The one way the app verifies a mobile by SMS code. The provider (Twilio
 * Verify) generates, sends and checks the code; For After never sees or
 * stores it. Knows nothing about Recipients or Trusted Contacts: callers
 * decide who may receive a code. Numbers are E.164.
 */
export abstract class SmsVerification {
  abstract readonly name: string;
  /** Texts a new code to `to`. Throws SmsVerificationError. */
  abstract send(to: string): Promise<void>;
  /**
   * true only when the provider approved `code` for `to` (it is then used
   * up). Wrong, expired or already used → false. Throws SmsVerificationError
   * when the provider cannot answer.
   */
  abstract check(to: string, code: string): Promise<boolean>;
}

type VerifyService = ReturnType<twilio.Twilio['verify']['v2']['services']>;

/** A safe category for a Twilio failure: its numeric code only, never its message. */
export const twilioErrorCode = (error: unknown) => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? `twilio_${code}` : 'twilio_unreachable';
};

const providerError = (error: unknown) =>
  new SmsVerificationError(twilioErrorCode(error));

// Twilio: 404 = no pending verification (expired, approved or never sent);
// 60202 = this verification's check attempts are used up.
const isNotApproved = (error: unknown) => {
  const { status, code } = (error ?? {}) as { status?: unknown; code?: unknown };
  return status === 404 || code === 20404 || code === 60202;
};

export class TwilioSmsVerification extends SmsVerification {
  readonly name = 'twilio';

  constructor(
    private readonly service: Pick<
      VerifyService,
      'verifications' | 'verificationChecks'
    >,
  ) {
    super();
  }

  async send(to: string) {
    try {
      await this.service.verifications.create({ to, channel: 'sms' });
    } catch (error) {
      throw providerError(error);
    }
  }

  async check(to: string, code: string) {
    try {
      const { status } = await this.service.verificationChecks.create({
        to,
        code,
      });
      return status === 'approved';
    } catch (error) {
      if (isNotApproved(error)) return false;
      throw providerError(error);
    }
  }
}

/**
 * NODE_ENV=development only, like EMAIL_PROVIDER=console: logs the code
 * instead of texting it, so local E2E never sends a real SMS.
 */
export class ConsoleSmsVerification extends SmsVerification {
  readonly name = 'console';
  private readonly logger = new Logger('SmsVerification');
  // ponytail: in-memory and without expiry, one dev process only; Twilio holds real codes.
  private readonly codes = new Map<string, string>();

  send(to: string) {
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    this.codes.set(to, code);
    this.logger.warn(
      `[DEV ONLY] SMS to ${maskMobile(to)} | Your For After code is ${code}`,
    );
    return Promise.resolve();
  }

  check(to: string, code: string) {
    const approved = this.codes.get(to) === code;
    if (approved) this.codes.delete(to);
    return Promise.resolve(approved);
  }
}

/** Not configured: nothing is ever sent or approved. */
export class DisabledSmsVerification extends SmsVerification {
  readonly name = 'disabled';

  send(): Promise<void> {
    return Promise.reject(new SmsVerificationError('sms_disabled'));
  }

  check(): Promise<boolean> {
    return Promise.reject(new SmsVerificationError('sms_disabled'));
  }
}

const TWILIO_KEYS = [
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_VERIFY_SERVICE_SID',
] as const;

/**
 * SMS_VERIFY_PROVIDER: twilio | console | disabled. Unset → twilio when all
 * TWILIO_* are set, otherwise disabled. Validated at startup; logs only the
 * provider and missing variable names, never a value.
 */
export const createSmsVerification = (
  config: ConfigService,
): SmsVerification => {
  const logger = new Logger('SmsVerification');
  const missing = TWILIO_KEYS.filter((key) => !config.get<string>(key));
  const provider =
    config.get<string>('SMS_VERIFY_PROVIDER') ||
    (missing.length ? 'disabled' : 'twilio');
  if (!['twilio', 'console', 'disabled'].includes(provider)) {
    throw new Error(
      'SMS_VERIFY_PROVIDER must be "twilio", "console" or "disabled".',
    );
  }
  if (
    provider === 'console' &&
    config.get<string>('NODE_ENV') !== 'development'
  ) {
    throw new Error(
      'SMS_VERIFY_PROVIDER=console is only allowed with NODE_ENV=development. It logs sign-in codes.',
    );
  }
  if (provider === 'console') return new ConsoleSmsVerification();
  if (provider === 'disabled') {
    logger.log(
      missing.length && missing.length < TWILIO_KEYS.length
        ? `SMS verification: disabled (missing ${missing.join(', ')})`
        : 'SMS verification: disabled',
    );
    return new DisabledSmsVerification();
  }
  if (missing.length) {
    throw new Error(
      `${missing.join(', ')} not set (SMS_VERIFY_PROVIDER=twilio).`,
    );
  }
  const client = twilio(
    config.get<string>('TWILIO_ACCOUNT_SID'),
    config.get<string>('TWILIO_AUTH_TOKEN'),
    { timeout: 10_000 },
  );
  logger.log('Twilio Verify: configured');
  return new TwilioSmsVerification(
    client.verify.v2.services(config.get<string>('TWILIO_VERIFY_SERVICE_SID')!),
  );
};
