import {
  EmailProvider,
  type EmailKind,
  type EmailMessage,
  EmailSendError,
} from '../src/email/email-provider.js';

/**
 * Step 24 test inbox: records every send (no network, no Resend). Failures can
 * be queued to simulate a provider outage. It deliberately does NOT dedupe by
 * idempotency key, so tests prove the app itself sends once.
 */
export class FakeEmailProvider extends EmailProvider {
  readonly name = 'fake';
  readonly sent: EmailMessage[] = [];
  readonly failures: EmailSendError[] = [];

  send(message: EmailMessage) {
    const failure = this.failures.shift();
    if (failure) return Promise.reject(failure);
    this.sent.push(message);
    return Promise.resolve({ providerMessageId: `fake-${this.sent.length}` });
  }

  to(email: string, kind?: EmailKind) {
    return this.sent.filter(
      (m) => m.to === email && (!kind || m.kind === kind),
    );
  }

  /** The 6-digit code from the latest sign-in email to `email`. */
  code(email: string): string | undefined {
    const last = this.sent.findLast(
      (m) => m.to === email && m.kind.endsWith('-otp'),
    );
    return last?.text.match(/Your sign-in code is (\d{6})/)?.[1];
  }

  failNext(count: number, code = 'rate_limit_exceeded', retryable = true) {
    for (let i = 0; i < count; i++)
      this.failures.push(new EmailSendError(code, retryable));
  }
}
