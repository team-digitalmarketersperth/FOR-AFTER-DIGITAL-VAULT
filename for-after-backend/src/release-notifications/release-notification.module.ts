import { Module } from '@nestjs/common';
import { ReleaseNotificationQueue } from './release-notification-queue.service.js';

// Step 24: "a message is waiting for you" emails. No controller. Producer side
// only; the email-delivery worker lives in QueueWorkersModule (Phase 17B).
@Module({
  providers: [ReleaseNotificationQueue],
  exports: [ReleaseNotificationQueue],
})
export class ReleaseNotificationModule {}
