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

@Module({
  imports: [EmailModule],
  controllers: [RecipientAuthController],
  // Codes go out by email (EMAIL_PROVIDER); tests override the token.
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
