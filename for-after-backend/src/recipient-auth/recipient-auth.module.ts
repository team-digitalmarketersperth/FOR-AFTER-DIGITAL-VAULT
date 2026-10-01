import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RecipientAuthController } from './recipient-auth.controller.js';
import { RecipientAuthService } from './recipient-auth.service.js';
import {
  otpDeliveryFactory,
  RecipientOtpDelivery,
} from './recipient-otp-delivery.js';
import { RecipientSessionAuthGuard } from './recipient-session.guard.js';

@Module({
  controllers: [RecipientAuthController],
  // Delivery is configuration (RECIPIENT_OTP_DELIVERY_MODE); tests override it.
  providers: [
    RecipientAuthService,
    RecipientSessionAuthGuard,
    {
      provide: RecipientOtpDelivery,
      useFactory: otpDeliveryFactory,
      inject: [ConfigService],
    },
  ],
  exports: [RecipientAuthService, RecipientSessionAuthGuard],
})
export class RecipientAuthModule {}
