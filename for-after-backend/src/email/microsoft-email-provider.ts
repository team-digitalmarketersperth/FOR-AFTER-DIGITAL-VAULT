import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import {
  ConfidentialClientApplication,
  type Configuration,
  LogLevel,
} from '@azure/msal-node';
import { maskEmail } from '../auth/dto/register.dto.js';
import {
  ADDRESS_RE,
  EmailProvider,
  type EmailMessage,
  EmailSendError,
  type EmailSettings,
} from './email-provider.js';

export const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';
export const graphSendMailUrl = (mailbox: string) =>
  `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/sendMail`;

/** What the adapter needs from MSAL: an app-only token, cached and renewed by MSAL. */
export type GraphTokenSource = Pick<
  ConfidentialClientApplication,
  'acquireTokenByClientCredential'
>;

// Token errors that another attempt cannot fix: wrong secret, client id,
// tenant, or a consent that was never granted.
const AUTH_REJECTED = new Set([
  'invalid_client',
  'unauthorized_client',
  'invalid_request',
  'invalid_scope',
  'invalid_grant',
  'invalid_resource',
]);
const GRAPH_CODE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/**
 * Microsoft Graph `sendMail` as the signed-in app (client credentials, scope
 * GRAPH_SCOPE). MSAL keeps the token in memory and renews it before expiry;
 * each send asks MSAL, which only goes to Entra ID when needed.
 *
 * 202 Accepted means Exchange Online accepted the message for delivery, not
 * that it was delivered. Graph has no idempotency key: a send that was
 * accepted but whose response was lost (timeout, crash) can be sent again by
 * a retry. Logs kinds, masked addresses, statuses and Graph request ids only:
 * never the secret, token, body or code.
 */
export class MicrosoftGraphEmailProvider extends EmailProvider {
  readonly name = 'microsoft';
  private readonly logger = new Logger('MicrosoftGraphEmailProvider');

  constructor(
    private readonly tokens: GraphTokenSource,
    private readonly mailbox: string,
    private readonly from: { name: string; address: string },
    private readonly timeoutMs: number,
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    super();
  }

  async send({ kind, to, subject, html }: EmailMessage) {
    // One deadline for the token and the send together.
    const deadline = AbortSignal.timeout(this.timeoutMs);
    // Our id for this attempt; Graph echoes it, so a log line matches Microsoft's records.
    const clientRequestId = randomUUID();
    try {
      const token = await this.token(deadline);
      let res: Response;
      try {
        res = await this.fetchFn(graphSendMailUrl(this.mailbox), {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            'client-request-id': clientRequestId,
            'return-client-request-id': 'true',
          },
          body: JSON.stringify({
            message: {
              subject,
              // Graph's JSON message takes one body: the HTML part of the template.
              body: { contentType: 'HTML', content: html },
              from: { emailAddress: this.from },
              toRecipients: [{ emailAddress: { address: to } }],
            },
            // No copy of sign-in codes or notices piles up in Sent Items.
            saveToSentItems: false,
          }),
          signal: deadline,
          redirect: 'error',
        });
      } catch {
        throw new EmailSendError(deadline.aborted ? 'timeout' : 'network_error', true);
      }
      const requestId = res.headers.get('request-id');
      if (res.ok) {
        this.logger.log(
          `email_accepted ${kind} to ${maskEmail(to)} status ${res.status} request ${requestId}`,
        );
        // Graph returns no message id; its request id is what Microsoft support asks for.
        return { providerMessageId: requestId };
      }
      const body = (await res.json().catch(() => null)) as GraphErrorBody | null;
      throw Object.assign(graphError(res.status, body?.error?.code), {
        diagnostics: graphDiagnostics(res, body, clientRequestId),
      });
    } catch (err) {
      const failure =
        err instanceof EmailSendError
          ? err
          : new EmailSendError('network_error', true);
      const { diagnostics } = err as { diagnostics?: string };
      // Retry-After is logged; the caller's backoff (BullMQ for queued
      // emails: 30 s, doubling) decides when the next attempt runs.
      this.logger.warn(
        `email_send_failed ${kind} to ${maskEmail(to)} (code: ${failure.code}, retryable: ${failure.retryable}${diagnostics ? `, ${diagnostics}` : ''})`,
      );
      throw failure;
    }
  }

  private async token(deadline: AbortSignal): Promise<string> {
    const timedOut = new Promise<never>((_, reject) => {
      const fail = () => reject(new EmailSendError('timeout', true));
      if (deadline.aborted) fail();
      else deadline.addEventListener('abort', fail, { once: true });
    });
    try {
      const result = await Promise.race([
        this.tokens.acquireTokenByClientCredential({ scopes: [GRAPH_SCOPE] }),
        timedOut,
      ]);
      if (!result?.accessToken)
        throw new EmailSendError('token_unavailable', true);
      return result.accessToken;
    } catch (err) {
      if (err instanceof EmailSendError) throw err;
      const code = (err as { errorCode?: unknown }).errorCode;
      throw typeof code === 'string' && AUTH_REJECTED.has(code)
        ? new EmailSendError('auth_rejected', false)
        : new EmailSendError('token_unavailable', true);
    }
  }
}

type GraphErrorBody = {
  error?: {
    code?: unknown;
    message?: unknown;
    innerError?: Record<string, unknown>;
  };
};

/**
 * Graph's own explanation of a failure, for the log line only (never stored
 * or returned): ErrorAccessDenied alone cannot tell a missing permission from
 * a mailbox outside the RBAC scope or one with REST access disabled; the
 * message can. Addresses and bearer tokens are redacted, 200 chars at most.
 */
export const sanitizeGraphMessage = (message: unknown): string | null =>
  typeof message === 'string'
    ? message
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/Bearer\s+\S+/gi, 'Bearer <redacted>')
        .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]*/g, '<token>')
        .replace(/[^\s"'<>@,;()]+@[^\s"'<>@,;()]+/g, '<address>')
        .replace(/"/g, "'")
        .trim()
        .slice(0, 200)
    : null;

const graphDiagnostics = (
  res: Response,
  body: GraphErrorBody | null,
  clientRequestId: string,
) => {
  const inner = body?.error?.innerError ?? {};
  const pick = (key: string) =>
    typeof inner[key] === 'string' && /^[\w:.+-]{1,64}$/.test(inner[key])
      ? inner[key]
      : null;
  const parts = [
    `status: ${res.status}`,
    `graph: ${typeof body?.error?.code === 'string' && GRAPH_CODE.test(body.error.code) ? body.error.code : 'none'}`,
    `message: "${sanitizeGraphMessage(body?.error?.message) ?? ''}"`,
    `request: ${pick('request-id') ?? res.headers.get('request-id') ?? 'none'}`,
    `client-request: ${pick('client-request-id') ?? clientRequestId}`,
    `date: ${pick('date') ?? res.headers.get('date') ?? 'none'}`,
  ];
  const retryAfter = res.headers.get('retry-after');
  if (retryAfter) parts.push(`retry-after: ${retryAfter}`);
  return parts.join(', ');
};

/** Status + Graph's short error code only; the message text is never kept. */
const graphError = (status: number, code: unknown): EmailSendError => {
  const safe =
    typeof code === 'string' && GRAPH_CODE.test(code) ? code : `http_${status}`;
  if (status === 429) return new EmailSendError('rate_limit_exceeded', true);
  if (status >= 500) return new EmailSendError(safe, true);
  // An expired or revoked token: MSAL fetches a new one once the cached one lapses.
  if (status === 401) return new EmailSendError('unauthorized', true);
  // Mail.Send not granted, an application access policy, or no Send As right.
  if (status === 403) return new EmailSendError(`forbidden_${safe}`, false);
  if (status === 404) return new EmailSendError('mailbox_not_found', false);
  return new EmailSendError(safe, false);
};

// ─── Configuration ──────────────────────────────────────────────────────────

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;
// Values copied from an example file rather than a real app registration.
const PLACEHOLDER =
  /^(<.*>|\{.*\}|x+|\*+|changeme|change[-_ ]me|replace[-_ ]?me|todo|tbd|placeholder|secret|password|your[-_ ].*|.*[-_ ]here)$|^0{8}-0{4}-0{4}-0{4}-0{12}$|@example\.(com|org|net)$/i;

export const MICROSOFT_ENV = [
  'MS_TENANT_ID',
  'MS_CLIENT_ID',
  'MS_CLIENT_SECRET',
  'MS_SENDER_MAILBOX',
  'EMAIL_FROM',
] as const;

/** Validated at startup with EMAIL_PROVIDER=microsoft. Errors name variables, never values. */
export const microsoftSettings = (config: ConfigService) => {
  const env = Object.fromEntries(
    MICROSOFT_ENV.map((k) => [k, (config.get<string>(k) ?? '').trim()]),
  ) as Record<(typeof MICROSOFT_ENV)[number], string>;
  const missing = MICROSOFT_ENV.filter((k) => !env[k]);
  if (missing.length)
    throw new Error(
      `Microsoft Graph email is not configured. Set ${missing.join(', ')} in .env.`,
    );
  const placeholders = MICROSOFT_ENV.filter((k) => PLACEHOLDER.test(env[k]));
  if (env.MS_CLIENT_SECRET.length < 16) placeholders.push('MS_CLIENT_SECRET');
  if (placeholders.length)
    throw new Error(
      `${[...new Set(placeholders)].join(', ')} look like placeholder values. Use the real values from the Entra ID app registration.`,
    );
  const invalid = [
    !(GUID.test(env.MS_TENANT_ID) || DOMAIN.test(env.MS_TENANT_ID)) &&
      'MS_TENANT_ID (a tenant id or verified domain)',
    !GUID.test(env.MS_CLIENT_ID) && 'MS_CLIENT_ID (the application id, a GUID)',
    !(ADDRESS_RE.test(env.MS_SENDER_MAILBOX) || GUID.test(env.MS_SENDER_MAILBOX)) &&
      'MS_SENDER_MAILBOX (a mailbox address or user id)',
    !ADDRESS_RE.test(env.EMAIL_FROM) && 'EMAIL_FROM (an email address)',
  ].filter(Boolean);
  if (invalid.length) throw new Error(`Invalid ${invalid.join('; ')}.`);
  return {
    tenantId: env.MS_TENANT_ID,
    clientId: env.MS_CLIENT_ID,
    clientSecret: env.MS_CLIENT_SECRET,
    mailbox: env.MS_SENDER_MAILBOX,
    fromAddress: env.EMAIL_FROM,
  };
};

export const createMicrosoftEmailProvider = (
  config: ConfigService,
  settings: EmailSettings,
): MicrosoftGraphEmailProvider => {
  const ms = microsoftSettings(config);
  if (config.get<string>('NODE_ENV') === 'production') {
    new Logger('MicrosoftGraphEmailProvider').warn(
      'Using a client secret. For production use a certificate or a federated credential (docs/email-production-setup.md, Microsoft Graph).',
    );
  }
  const msalConfig: Configuration = {
    auth: {
      clientId: ms.clientId,
      authority: `https://login.microsoftonline.com/${ms.tenantId}`,
      clientSecret: ms.clientSecret,
    },
    // MSAL logs nothing here: no tokens, no personal data.
    system: {
      loggerOptions: {
        piiLoggingEnabled: false,
        logLevel: LogLevel.Error,
        loggerCallback: () => undefined,
      },
    },
  };
  return new MicrosoftGraphEmailProvider(
    new ConfidentialClientApplication(msalConfig),
    ms.mailbox,
    {
      name: settings.fromName.replace(/["\\<>\r\n]/g, ''),
      address: ms.fromAddress,
    },
    settings.timeoutMs,
  );
};
