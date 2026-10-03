import { Module } from '@nestjs/common';
import { EmailProvider } from '../email/email-provider.js';
import { EmailConfig, EmailModule } from '../email/email.module.js';
import { MessageReleaseModule } from '../message-release/message-release.module.js';
import { UsersModule } from '../users/users.module.js';
import {
  DeathNoticeDelivery,
  deathNoticeDeliveryFactory,
} from './death-verification-notice.js';
import { DeathVerificationQueue } from './death-verification-queue.service.js';
import { DeathVerificationWorkflow } from './death-verification-workflow.service.js';
import {
  AdminDeathVerificationController,
  CustomerDeathVerificationController,
} from './death-verification.controller.js';
import { DeathVerificationService } from './death-verification.service.js';

// Reports arrive through the Trusted Contact portal (Step 14). Step 15 adds
// the safeguard workflow, the Customer confirm-alive routes and the minimal
// admin decision routes. UsersModule backs SessionAuthGuard; MessageReleaseModule
// provides the one message-release queue death triggers are executed through.
@Module({
  imports: [UsersModule, MessageReleaseModule, EmailModule],
  controllers: [
    CustomerDeathVerificationController,
    AdminDeathVerificationController,
  ],
  providers: [
    DeathVerificationService,
    DeathVerificationWorkflow,
    DeathVerificationQueue,
    // The notice is an email (EMAIL_PROVIDER); tests override the token.
    {
      provide: DeathNoticeDelivery,
      useFactory: deathNoticeDeliveryFactory,
      inject: [EmailProvider, EmailConfig],
    },
  ],
  exports: [DeathVerificationService, DeathVerificationQueue],
})
export class DeathVerificationModule {}
