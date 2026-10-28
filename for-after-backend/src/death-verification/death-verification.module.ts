import { Module } from '@nestjs/common';
import { EmailProvider } from '../email/email-provider.js';
import { EmailConfig, EmailModule } from '../email/email.module.js';
import { MediaModule } from '../media/media.module.js';
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
import { DeathVerificationEvidenceService } from './death-verification-evidence.service.js';
import { DeathVerificationService } from './death-verification.service.js';

// The safeguard workflow and its producer queue, shared by the API and the
// worker process (Phase 17B; the consumer is DeathVerificationProcessor in
// QueueWorkersModule). MessageReleaseModule provides the one message-release
// queue death triggers are executed through.
@Module({
  imports: [MessageReleaseModule, EmailModule],
  providers: [
    DeathVerificationWorkflow,
    DeathVerificationQueue,
    // The notice is an email (EMAIL_PROVIDER); tests override the token.
    {
      provide: DeathNoticeDelivery,
      useFactory: deathNoticeDeliveryFactory,
      inject: [EmailProvider, EmailConfig],
    },
  ],
  exports: [DeathVerificationWorkflow, DeathVerificationQueue],
})
export class DeathVerificationQueueModule {}

// Reports arrive through the Trusted Contact portal (Step 14). Step 15 adds
// the Customer confirm-alive routes and the minimal admin decision routes.
// UsersModule backs SessionAuthGuard. MediaModule: evidence files (Phase 19A).
@Module({
  imports: [UsersModule, DeathVerificationQueueModule, MediaModule],
  controllers: [
    CustomerDeathVerificationController,
    AdminDeathVerificationController,
  ],
  providers: [DeathVerificationService, DeathVerificationEvidenceService],
  exports: [
    DeathVerificationService,
    DeathVerificationEvidenceService,
    DeathVerificationQueueModule,
  ],
})
export class DeathVerificationModule {}
