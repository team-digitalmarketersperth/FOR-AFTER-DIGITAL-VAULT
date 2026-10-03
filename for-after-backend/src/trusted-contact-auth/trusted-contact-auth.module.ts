import { Module } from '@nestjs/common';
import { EmailProvider } from '../email/email-provider.js';
import { EmailModule } from '../email/email.module.js';
import { TrustedContactAuthController } from './trusted-contact-auth.controller.js';
import {
  TrustedContactAuthService,
  TrustedContactOtpDelivery,
  trustedContactOtpDeliveryFactory,
} from './trusted-contact-auth.service.js';
import { TrustedContactSessionAuthGuard } from './trusted-contact-session.guard.js';

@Module({
  imports: [EmailModule],
  controllers: [TrustedContactAuthController],
  // Codes go out by email (EMAIL_PROVIDER); tests override the token.
  providers: [
    TrustedContactAuthService,
    TrustedContactSessionAuthGuard,
    {
      provide: TrustedContactOtpDelivery,
      useFactory: trustedContactOtpDeliveryFactory,
      inject: [EmailProvider],
    },
  ],
  exports: [TrustedContactAuthService, TrustedContactSessionAuthGuard],
})
export class TrustedContactAuthModule {}
