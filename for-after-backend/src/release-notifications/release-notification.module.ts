import { Module } from '@nestjs/common';
import { EmailModule } from '../email/email.module.js';
import { ReleaseNotificationQueue } from './release-notification-queue.service.js';
import { ReleaseNotificationProcessor } from './release-notification.processor.js';

// Step 24: "a message is waiting for you" emails. No controller.
@Module({
  imports: [EmailModule],
  providers: [ReleaseNotificationQueue, ReleaseNotificationProcessor],
  exports: [ReleaseNotificationQueue],
})
export class ReleaseNotificationModule {}
