import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { maskEmail } from '../auth/dto/register.dto.js';

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
 * confirm you are alive" notice. Also the DI token; tests bind a fake. The
 * production email provider arrives in Step 17 as another implementation.
 * sendAccountHolderSafetyNotice must throw if the notice was not sent: the
 * safeguard window only starts after a successful send.
 */
export abstract class DeathNoticeDelivery {
  abstract sendAccountHolderSafetyNotice(
    input: SafetyNoticeInput,
  ): Promise<void>;
}

// Local development / Postman only; refused outside NODE_ENV=development.
export class ConsoleDeathNoticeDelivery extends DeathNoticeDelivery {
  private readonly logger = new Logger('DeathNoticeDelivery');

  sendAccountHolderSafetyNotice({
    caseId,
    email,
    safeguardEndsAt,
  }: SafetyNoticeInput): Promise<void> {
    this.logger.warn(
      `[DEV ONLY] Death verification safety notice sent to ${maskEmail(email)} for case ${caseId} (safeguard ends ${safeguardEndsAt.toISOString()})`,
    );
    return Promise.resolve();
  }
}

// No provider yet: sending fails, so the case stays PENDING_VERIFICATION and
// no safeguard can start. That is the safe default until Step 17.
export class DisabledDeathNoticeDelivery extends DeathNoticeDelivery {
  sendAccountHolderSafetyNotice(): Promise<void> {
    return Promise.reject(
      new Error('death_notice_delivery_disabled: no provider configured'),
    );
  }
}

export const deathNoticeDeliveryFactory = (
  config: ConfigService,
): DeathNoticeDelivery => {
  const key = 'DEATH_VERIFICATION_NOTICE_DELIVERY_MODE';
  const mode = config.get<string>(key) || 'disabled';
  if (mode === 'console') {
    if (config.get<string>('NODE_ENV') !== 'development') {
      throw new Error(
        `${key}=console is only allowed with NODE_ENV=development. Real account holders would never be notified.`,
      );
    }
    return new ConsoleDeathNoticeDelivery();
  }
  if (mode === 'disabled') return new DisabledDeathNoticeDelivery();
  throw new Error(`${key} must be "disabled" or "console" (development only).`);
};
