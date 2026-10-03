import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';
import { maskEmail } from '../auth/dto/register.dto.js';
import { positiveInt } from '../media/media.service.js';

/** The four transactional emails For After sends (Step 24). Nothing else. */
export type EmailKind =
  'recipient-otp' | 'trusted-contact-otp' | 'message-released' | 'death-safety';

export type EmailMessage = {
  kind: EmailKind;
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Same key → the provider sends once (Resend keeps keys for 24 hours). */
  idempotencyKey?: string;
};

/**
 * A failed send. `code` is a short, safe category (never a provider response
 * body); `retryable` says whether trying again later can help.
 */
export class EmailSendError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(`email_send_failed: ${code}`);
    this.name = 'EmailSendError';
  }
}

/**
 * The one way the app sends email. Business code (OTP, release, death
 * verification) depends on this, never on Resend, so the provider can change
 * without touching them. Implementations throw EmailSendError on failure.
 */
export abstract class EmailProvider {
  abstract readonly name: string;
  abstract send(
    message: EmailMessage,
  ): Promise<{ providerMessageId: string | null }>;
}

// Resend error names that a later attempt can fix; everything else (bad key,
// unverified sender, invalid address, …) is permanent and must not be retried.
const RETRYABLE = new Set([
  'rate_limit_exceeded',
  'daily_quota_exceeded',
  'concurrent_idempotent_requests',
  'application_error',
  'internal_server_error',
]);

/** Production. Logs ids and categories only: never the key, body or code. */
export class ResendEmailProvider extends EmailProvider {
  readonly name = 'resend';
  private readonly logger = new Logger('ResendEmailProvider');

  constructor(
    private readonly client: Pick<Resend, 'emails'>,
    private readonly from: string,
    private readonly timeoutMs: number,
  ) {
    super();
  }

  async send(message: EmailMessage) {
    const { kind, to, subject, html, text, idempotencyKey } = message;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new EmailSendError('timeout', true)),
        this.timeoutMs,
      );
    });
    try {
      const { data, error } = await Promise.race([
        this.client.emails.send(
          {
            from: this.from,
            to,
            subject,
            html,
            text,
            tags: [{ name: 'kind', value: kind.replaceAll('-', '_') }],
          },
          idempotencyKey ? { idempotencyKey } : undefined,
        ),
        timeout,
      ]);
      if (error) {
        const retryable =
          error.statusCode === null || RETRYABLE.has(error.name);
        throw new EmailSendError(error.name, retryable);
      }
      this.logger.log(`email_sent ${kind} to ${maskEmail(to)} id ${data?.id}`);
      return { providerMessageId: data?.id ?? null };
    } catch (err) {
      const failure =
        err instanceof EmailSendError
          ? err
          : new EmailSendError('network_error', true);
      this.logger.warn(
        `email_send_failed ${kind} to ${maskEmail(to)} (code: ${failure.code}, retryable: ${failure.retryable})`,
      );
      throw failure;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Local development only (refused unless NODE_ENV=development): prints the
 * plain-text email, sign-in codes included, so codes can be read from the API
 * console or a teed log. Nothing is sent.
 */
export class ConsoleEmailProvider extends EmailProvider {
  readonly name = 'console';
  private readonly logger = new Logger('EmailProvider');

  send({ kind, to, subject, text }: EmailMessage) {
    this.logger.warn(
      `[DEV ONLY] Email (${kind}) to ${maskEmail(to)} | ${subject} | ${text.replace(/\s+/g, ' ').trim()}`,
    );
    return Promise.resolve({ providerMessageId: null });
  }
}

/** No provider configured: every send fails permanently, nothing leaves. */
export class DisabledEmailProvider extends EmailProvider {
  readonly name = 'disabled';

  send(): Promise<{ providerMessageId: string | null }> {
    return Promise.reject(new EmailSendError('email_disabled', false));
  }
}

const URL_RE = /^https?:\/\/[^\s/]+(:\d+)?$/;

/** Server-side only. Validated at startup; secrets are never logged. */
export const emailSettings = (config: ConfigService) => {
  const nodeEnv = config.get<string>('NODE_ENV');
  const provider = config.get<string>('EMAIL_PROVIDER') || 'disabled';
  if (!['resend', 'console', 'disabled'].includes(provider)) {
    throw new Error(
      'EMAIL_PROVIDER must be "resend", "console" or "disabled".',
    );
  }
  if (nodeEnv === 'production' && provider !== 'resend') {
    throw new Error('EMAIL_PROVIDER must be "resend" in production.');
  }
  if (provider === 'console' && nodeEnv !== 'development') {
    throw new Error(
      'EMAIL_PROVIDER=console is only allowed with NODE_ENV=development. It logs sign-in codes.',
    );
  }
  const appBaseUrl = (config.get<string>('APP_BASE_URL') || '').replace(
    /\/+$/,
    '',
  );
  if (provider !== 'disabled' && !URL_RE.test(appBaseUrl)) {
    throw new Error(
      'APP_BASE_URL must be the app origin, e.g. http://localhost:3000 (no path).',
    );
  }
  if (nodeEnv === 'production' && !appBaseUrl.startsWith('https://')) {
    throw new Error('APP_BASE_URL must use https in production.');
  }
  return {
    provider,
    appBaseUrl,
    fromName: config.get<string>('EMAIL_FROM_NAME') || 'For After',
    fromAddress: config.get<string>('EMAIL_FROM_ADDRESS') || '',
    timeoutMs: positiveInt(config, 'EMAIL_SEND_TIMEOUT_MS', 10_000),
  };
};
export type EmailSettings = ReturnType<typeof emailSettings>;

export const createEmailProvider = (config: ConfigService): EmailProvider => {
  const settings = emailSettings(config);
  if (settings.provider === 'console') return new ConsoleEmailProvider();
  if (settings.provider === 'disabled') return new DisabledEmailProvider();
  const apiKey = config.get<string>('RESEND_API_KEY');
  if (!apiKey)
    throw new Error('RESEND_API_KEY is not set (EMAIL_PROVIDER=resend).');
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(settings.fromAddress)) {
    throw new Error(
      'EMAIL_FROM_ADDRESS must be a sender address on a domain verified in Resend.',
    );
  }
  // Name quoted, so a comma or angle bracket in it can't change the header.
  const from = `"${settings.fromName.replace(/["\\<>\r\n]/g, '')}" <${settings.fromAddress}>`;
  return new ResendEmailProvider(new Resend(apiKey), from, settings.timeoutMs);
};
