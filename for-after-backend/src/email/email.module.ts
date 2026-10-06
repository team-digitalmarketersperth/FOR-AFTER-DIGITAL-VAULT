import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createEmailProvider,
  EmailProvider,
  emailSettings,
  type EmailSettings,
} from './email-provider.js';

/** DI token for the validated email settings (app link, sender). */
export abstract class EmailConfig {
  abstract readonly settings: EmailSettings;
}

/**
 * Step 24. The provider is chosen from EMAIL_PROVIDER (brevo | resend |
 * console | disabled) and validated at startup; tests override EmailProvider with a fake.
 * Imported by each module that sends (OTP, death verification, release).
 */
@Module({
  providers: [
    {
      provide: EmailProvider,
      useFactory: createEmailProvider,
      inject: [ConfigService],
    },
    {
      provide: EmailConfig,
      useFactory: (config: ConfigService) => ({
        settings: emailSettings(config),
      }),
      inject: [ConfigService],
    },
  ],
  exports: [EmailProvider, EmailConfig],
})
export class EmailModule {}
