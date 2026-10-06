import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';
import { maskEmail } from '../auth/dto/register.dto.js';
import { positiveInt } from '../media/media.service.js';

/** The transactional emails For After sends (Step 24, Phase 04). Nothing else. */
export type EmailKind =
  | 'recipient-otp'
  | 'trusted-contact-otp'
  | 'message-released'
  | 'death-safety'
  | 'verify-email'
  | 'reset-password'
  | 'change-email'
  | 'email-changed'
  | 'trusted-contact-invitation';

export type EmailMessage = {
  kind: EmailKind;
  to: string;
  subject: string;
  html: string;
  text: string;
  /**
   * Same key → the provider sends once where it supports keys (Brevo:
   * `Idempotency-Key` email header; Resend: 24 hours). The app's own guards
   * (SENT rows, claimed attempts) come first.
   */
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
 * verification) depends on this, never on Brevo or Resend, so the provider can change
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

/** Optional, not active. Logs ids and categories only: never the key, body or code. */
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

export const BREVO_SEND_URL = 'https://api.brevo.com/v3/smtp/email';

// Brevo `code` values on a 4xx that a later attempt can fix. Everything else
// on a 4xx (invalid_parameter, missing_parameter, unauthorized, unverified
// sender, insufficient_credits, duplicate_request, …) is permanent.
const BREVO_RETRYABLE_CODES = new Set(['too_many_requests']);
const SAFE_CODE = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * Brevo transactional email over its REST API (no SDK). Logs ids and
 * categories only: never the key, body or code. One attempt per call; retries
 * belong to the caller (BullMQ backoff, the death-verification reconciler).
 */
export class BrevoEmailProvider extends EmailProvider {
  readonly name = 'brevo';
  private readonly logger = new Logger('BrevoEmailProvider');

  constructor(
    private readonly apiKey: string,
    private readonly sender: { name: string; email: string },
    private readonly timeoutMs: number,
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    super();
  }

  async send(message: EmailMessage) {
    const { kind, to, subject, html, text, idempotencyKey } = message;
    try {
      let res: Response;
      try {
        res = await this.fetchFn(BREVO_SEND_URL, {
          method: 'POST',
          headers: {
            'api-key': this.apiKey,
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: JSON.stringify({
            sender: this.sender,
            to: [{ email: to }],
            subject,
            htmlContent: html,
            textContent: text,
            tags: [kind.replaceAll('-', '_')],
            // Brevo reads the idempotency key from the email headers object.
            ...(idempotencyKey
              ? { headers: { 'Idempotency-Key': idempotencyKey } }
              : {}),
          }),
          signal: AbortSignal.timeout(this.timeoutMs),
          redirect: 'error',
        });
      } catch (err) {
        const timedOut =
          err instanceof Error &&
          (err.name === 'TimeoutError' || err.name === 'AbortError');
        throw new EmailSendError(timedOut ? 'timeout' : 'network_error', true);
      }
      const body = (await res.json().catch(() => null)) as {
        messageId?: unknown;
        code?: unknown;
      } | null;
      if (!res.ok) throw brevoError(res.status, body?.code);
      const id = typeof body?.messageId === 'string' ? body.messageId : null;
      this.logger.log(`email_sent ${kind} to ${maskEmail(to)} id ${id}`);
      return { providerMessageId: id };
    } catch (err) {
      const failure =
        err instanceof EmailSendError
          ? err
          : new EmailSendError('network_error', true);
      this.logger.warn(
        `email_send_failed ${kind} to ${maskEmail(to)} (code: ${failure.code}, retryable: ${failure.retryable})`,
      );
      throw failure;
    }
  }
}

/** Status + Brevo's short `code` only; the message text is never kept. */
const brevoError = (status: number, code: unknown): EmailSendError => {
  const safe =
    typeof code === 'string' && SAFE_CODE.test(code) ? code : `http_${status}`;
  if (status === 429) return new EmailSendError('rate_limit_exceeded', true);
  if (status >= 500) return new EmailSendError(safe, true);
  return new EmailSendError(safe, BREVO_RETRYABLE_CODES.has(safe));
};

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
const ADDRESS_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
/** Providers that really deliver; production must use one of them. */
const REAL_PROVIDERS = ['brevo', 'resend'];

/** Server-side only. Validated at startup; secrets are never logged. */
export const emailSettings = (config: ConfigService) => {
  const nodeEnv = config.get<string>('NODE_ENV');
  const provider = config.get<string>('EMAIL_PROVIDER') || 'disabled';
  if (![...REAL_PROVIDERS, 'console', 'disabled'].includes(provider)) {
    throw new Error(
      'EMAIL_PROVIDER must be "brevo", "resend", "console" or "disabled".',
    );
  }
  if (nodeEnv === 'production' && !REAL_PROVIDERS.includes(provider)) {
    throw new Error(
      'EMAIL_PROVIDER must be "brevo" or "resend" in production.',
    );
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
  // Only the selected provider's key is required.
  const keyName =
    settings.provider === 'brevo' ? 'BREVO_API_KEY' : 'RESEND_API_KEY';
  const apiKey = config.get<string>(keyName);
  if (!apiKey)
    throw new Error(
      `${keyName} is not set (EMAIL_PROVIDER=${settings.provider}).`,
    );
  if (!ADDRESS_RE.test(settings.fromAddress)) {
    throw new Error(
      settings.provider === 'brevo'
        ? 'EMAIL_FROM_ADDRESS must be a sender verified in Brevo (Senders, Domains & Dedicated IPs).'
        : 'EMAIL_FROM_ADDRESS must be a sender address on a domain verified in Resend.',
    );
  }
  const fromName = settings.fromName.replace(/["\\<>\r\n]/g, '');
  if (settings.provider === 'brevo') {
    return new BrevoEmailProvider(
      apiKey,
      { name: fromName, email: settings.fromAddress },
      settings.timeoutMs,
    );
  }
  // Name quoted, so a comma or angle bracket in it can't change the header.
  const from = `"${fromName}" <${settings.fromAddress}>`;
  return new ResendEmailProvider(new Resend(apiKey), from, settings.timeoutMs);
};
