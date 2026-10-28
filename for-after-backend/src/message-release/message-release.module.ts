import { Module } from '@nestjs/common';
import { MessageReleaseQueue } from './message-release-queue.service.js';
import { MessageReleaseService } from './message-release.service.js';

// Producer side + release logic, shared by the API and the worker process. No
// controller: releases happen in the worker (QueueWorkersModule), never on
// request. The API only adds, moves and removes jobs here.
@Module({
  providers: [MessageReleaseService, MessageReleaseQueue],
  exports: [MessageReleaseService, MessageReleaseQueue],
})
export class MessageReleaseModule {}
