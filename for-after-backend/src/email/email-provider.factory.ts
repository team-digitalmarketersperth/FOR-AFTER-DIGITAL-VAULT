import type { ConfigService } from '@nestjs/config';
import { createEmailProvider, type EmailProvider, emailSettings } from './email-provider.js';
import { createMicrosoftEmailProvider } from './microsoft-email-provider.js';

/**
 * The provider EMAIL_PROVIDER selects, validated at startup. Microsoft Graph
 * lives in its own module (it extends EmailProvider), so the selection sits
 * here rather than in email-provider.ts, keeping imports one-way.
 */
export const emailProviderFor = (config: ConfigService): EmailProvider => {
  const settings = emailSettings(config);
  return settings.provider === 'microsoft'
    ? createMicrosoftEmailProvider(config, settings)
    : createEmailProvider(config);
};
