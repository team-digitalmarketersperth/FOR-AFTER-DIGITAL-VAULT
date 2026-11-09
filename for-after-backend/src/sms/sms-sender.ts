import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import twilio from 'twilio';
import { maskMobile } from '../recipients/dto/create-recipient.dto.js';
import { twilioErrorCode } from './sms-verification.js';

/** A failed send. `code` is a safe category (e.g. twilio_21610), never a provider response. */
export class SmsSendError extends Error {
  constructor(readonly code: string) {
    super(`sms_send_failed: ${code}`);
    this.name = 'SmsSendError';
  }
}

/**
 * Transactional SMS (Twilio Programmable Messaging), e.g. Trusted Contact
 * invitations. Separate from SmsVerification (Twilio Verify, sign-in codes).
 * Knows nothing about who may receive a text: callers decide. `to` is E.164.
 */
export abstract class SmsSender {
  abstract readonly name: string;
  /** Throws SmsSendError. */
  abstract send(message: { to: string; body: string }): Promise<void>;
}

type Messages = twilio.Twilio['messages'];

export class TwilioSmsSender extends SmsSender {
  readonly name = 'twilio';

  constructor(
    private readonly messages: Pick<Messages, 'create'>,
    private readonly messagingServiceSid: string,
  ) {
    super();
  }

  async send({ to, body }: { to: string; body: string }) {
    try {
      await this.messages.create({
        to,
        body,
        messagingServiceSid: this.messagingServiceSid,
      });
    } catch (error) {
      throw new SmsSendError(twilioErrorCode(error));
    }
  }
}

/** NODE_ENV=development only: logs the text instead of sending it (local E2E). */
export class ConsoleSmsSender extends SmsSender {
  readonly name = 'console';
  private readonly logger = new Logger('SmsSender');

  send({ to, body }: { to: string; body: string }) {
    this.logger.warn(`[DEV ONLY] SMS to ${maskMobile(to)} | ${body}`);
    return Promise.resolve();
  }
}

/** No sender configured: every send fails, nothing leaves the app. */
export class DisabledSmsSender extends SmsSender {
  readonly name = 'disabled';

  send(): Promise<void> {
    return Promise.reject(new SmsSendError('sms_disabled'));
  }
}

const TWILIO_KEYS = [
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_MESSAGING_SERVICE_SID',
] as const;

/**
 * SMS_MESSAGING_PROVIDER: twilio | console | disabled. Unset → twilio when the
 * account credentials and TWILIO_MESSAGING_SERVICE_SID are set, otherwise
 * disabled. The Verify service SID is never used here. Logs no values.
 */
export const createSmsSender = (config: ConfigService): SmsSender => {
  const logger = new Logger('SmsSender');
  const missing = TWILIO_KEYS.filter((key) => !config.get<string>(key));
  const provider =
    config.get<string>('SMS_MESSAGING_PROVIDER') ||
    (missing.length ? 'disabled' : 'twilio');
  if (!['twilio', 'console', 'disabled'].includes(provider)) {
    throw new Error(
      'SMS_MESSAGING_PROVIDER must be "twilio", "console" or "disabled".',
    );
  }
  if (
    provider === 'console' &&
    config.get<string>('NODE_ENV') !== 'development'
  ) {
    throw new Error(
      'SMS_MESSAGING_PROVIDER=console is only allowed with NODE_ENV=development. It logs invitation links.',
    );
  }
  if (provider === 'console') return new ConsoleSmsSender();
  if (provider === 'disabled') {
    logger.log(
      missing.includes('TWILIO_MESSAGING_SERVICE_SID')
        ? 'SMS messaging: disabled (missing TWILIO_MESSAGING_SERVICE_SID)'
        : 'SMS messaging: disabled',
    );
    return new DisabledSmsSender();
  }
  if (missing.length) {
    throw new Error(
      `${missing.join(', ')} not set (SMS_MESSAGING_PROVIDER=twilio).`,
    );
  }
  const client = twilio(
    config.get<string>('TWILIO_ACCOUNT_SID'),
    config.get<string>('TWILIO_AUTH_TOKEN'),
    { timeout: 10_000 },
  );
  logger.log('Twilio Messaging: configured');
  return new TwilioSmsSender(
    client.messages,
    config.get<string>('TWILIO_MESSAGING_SERVICE_SID')!,
  );
};
