import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TrustedContactAuthController } from './trusted-contact-auth.controller.js';
import {
  TrustedContactAuthService,
  TrustedContactOtpDelivery,
  trustedContactOtpDeliveryFactory,
} from './trusted-contact-auth.service.js';
import { TrustedContactSessionAuthGuard } from './trusted-contact-session.guard.js';

@Module({
  controllers: [TrustedContactAuthController],
  // Delivery is configuration (TRUSTED_CONTACT_OTP_DELIVERY_MODE); tests override it.
  providers: [
    TrustedContactAuthService,
    TrustedContactSessionAuthGuard,
    {
      provide: TrustedContactOtpDelivery,
      useFactory: trustedContactOtpDeliveryFactory,
      inject: [ConfigService],
    },
  ],
  exports: [TrustedContactAuthService, TrustedContactSessionAuthGuard],
})
export class TrustedContactAuthModule {}
