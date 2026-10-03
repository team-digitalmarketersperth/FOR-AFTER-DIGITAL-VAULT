import { EmailProvider } from '../email/email-provider.js';
import { deathSafety } from '../email/email-templates.js';
import { EmailConfig } from '../email/email.module.js';

/**
 * What the account-holder safety notice carries. Deliberately minimal: never
 * the reporter, their note, Message titles/content, recipients, Memory Vault,
 * My Story or My Wishes.
 */
export type SafetyNoticeInput = {
  caseId: string;
  email: string;
  displayName: string;
  safeguardEndsAt: Date;
};

/**
 * Provider-neutral delivery of the "a death report was filed; sign in and
 * confirm you are alive" notice. Also the DI token; tests bind a fake.
 * sendAccountHolderSafetyNotice must throw if the notice was not sent: the
 * safeguard window only starts after a successful send.
 */
export abstract class DeathNoticeDelivery {
  abstract sendAccountHolderSafetyNotice(
    input: SafetyNoticeInput,
  ): Promise<void>;
}

/**
 * Step 24: the notice is an email through EmailProvider. The workflow already
 * gives it durable state and retries (an attempt is claimed only while the
 * case is PENDING_VERIFICATION, so a case the Customer cancelled is never
 * emailed; failed sends are retried by the reconciler). The idempotency key
 * makes a retry after a lost response send nothing new. With
 * EMAIL_PROVIDER=disabled every send fails, so no safeguard can start.
 */
export class EmailDeathNoticeDelivery extends DeathNoticeDelivery {
  constructor(
    private readonly email: EmailProvider,
    private readonly appBaseUrl: string,
  ) {
    super();
  }

  async sendAccountHolderSafetyNotice({
    caseId,
    email,
    displayName,
  }: SafetyNoticeInput): Promise<void> {
    await this.email.send({
      kind: 'death-safety',
      to: email,
      idempotencyKey: `death-safety/${caseId}`,
      ...deathSafety(displayName, this.appBaseUrl),
    });
  }
}

export const deathNoticeDeliveryFactory = (
  email: EmailProvider,
  { settings }: EmailConfig,
): DeathNoticeDelivery =>
  new EmailDeathNoticeDelivery(email, settings.appBaseUrl);
