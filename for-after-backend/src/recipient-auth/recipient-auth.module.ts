import { Module } from '@nestjs/common';
import { EmailProvider } from '../email/email-provider.js';
import { EmailModule } from '../email/email.module.js';
import { RecipientAuthController } from './recipient-auth.controller.js';
import { RecipientAuthService } from './recipient-auth.service.js';
import {
  otpDeliveryFactory,
  RecipientOtpDelivery,
} from './recipient-otp-delivery.js';
import { RecipientSessionAuthGuard } from './recipient-session.guard.js';
import { SmsModule } from '../sms/sms.module.js';

@Module({
  imports: [EmailModule, SmsModule],
  controllers: [RecipientAuthController],
  // Email codes go out by EMAIL_PROVIDER, SMS codes by SMS_VERIFY_PROVIDER;
  // tests override the tokens.
  providers: [
    RecipientAuthService,
    RecipientSessionAuthGuard,
    {
      provide: RecipientOtpDelivery,
      useFactory: otpDeliveryFactory,
      inject: [EmailProvider],
    },
  ],
  exports: [RecipientAuthService, RecipientSessionAuthGuard],
})
export class RecipientAuthModule {}
