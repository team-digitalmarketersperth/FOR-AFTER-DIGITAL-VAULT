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
import { SmsModule } from '../sms/sms.module.js';

@Module({
  imports: [EmailModule, SmsModule],
  controllers: [TrustedContactAuthController],
  // Email codes go out by EMAIL_PROVIDER, SMS codes by SMS_VERIFY_PROVIDER
  // (the same Twilio Verify service as Recipients); tests override the tokens.
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
