import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module.js';
import { AdminAnnouncementsController } from './announcements.controller.js';
import { AnnouncementAudienceService, AnnouncementPolicy } from './announcement-audience.service.js';
import { AnnouncementBroadcastQueue } from './announcement-broadcast-queue.service.js';
import { AnnouncementBroadcastService } from './announcement-broadcast.service.js';
import { AnnouncementResultsService } from './announcement-results.service.js';
import { AnnouncementTestQueue } from './announcement-test-queue.service.js';
import { AnnouncementsService } from './announcements.service.js';

// UsersModule backs SessionAuthGuard. No EmailModule: the API only records and queues test
// emails and broadcast runs; the worker (QueueWorkersModule) sends them.
@Module({
  imports: [UsersModule],
  controllers: [AdminAnnouncementsController],
  providers: [
    AnnouncementsService,
    AnnouncementTestQueue,
    AnnouncementAudienceService,
    AnnouncementPolicy,
    AnnouncementBroadcastQueue,
    AnnouncementBroadcastService,
    AnnouncementResultsService,
  ],
  exports: [AnnouncementTestQueue, AnnouncementBroadcastQueue, AnnouncementPolicy],
})
export class AnnouncementsModule {}
