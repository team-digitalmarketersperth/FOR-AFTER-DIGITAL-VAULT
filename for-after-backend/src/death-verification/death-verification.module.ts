import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
  imports: [UsersModule, MessageReleaseModule],
  controllers: [
    CustomerDeathVerificationController,
    AdminDeathVerificationController,
  ],
  providers: [
    DeathVerificationService,
    DeathVerificationWorkflow,
    DeathVerificationQueue,
    // Delivery is configuration (DEATH_VERIFICATION_NOTICE_DELIVERY_MODE); tests override it.
    {
      provide: DeathNoticeDelivery,
      useFactory: deathNoticeDeliveryFactory,
      inject: [ConfigService],
    },
  ],
  exports: [DeathVerificationService, DeathVerificationQueue],
})
export class DeathVerificationModule {}
