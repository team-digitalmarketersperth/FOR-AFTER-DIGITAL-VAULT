import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createSmsSender, SmsSender } from './sms-sender.js';
import { createSmsVerification, SmsVerification } from './sms-verification.js';

/**
 * SMS code verification (Twilio Verify, SMS_VERIFY_PROVIDER) and transactional
 * SMS (Twilio Messaging, SMS_MESSAGING_PROVIDER): separate providers, each
 * validated at startup; tests override either with a fake.
 */
@Module({
  providers: [
    {
      provide: SmsVerification,
      useFactory: createSmsVerification,
      inject: [ConfigService],
    },
    {
      provide: SmsSender,
      useFactory: createSmsSender,
      inject: [ConfigService],
    },
  ],
  exports: [SmsVerification, SmsSender],
})
export class SmsModule {}
