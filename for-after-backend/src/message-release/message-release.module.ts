import { Module } from '@nestjs/common';
import { MessageReleaseQueue } from './message-release-queue.service.js';
import { MessageReleaseProcessor } from './message-release.processor.js';
import { MessageReleaseReconciler } from './message-release-reconciler.service.js';
import { MessageReleaseService } from './message-release.service.js';

// Internal only: no controller. Releases happen in the worker, never on request.
@Module({
  providers: [
    MessageReleaseService,
    MessageReleaseQueue,
    MessageReleaseProcessor,
    MessageReleaseReconciler,
  ],
  exports: [MessageReleaseQueue],
})
export class MessageReleaseModule {}
