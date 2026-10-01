import { Module } from '@nestjs/common';
import { MessageReleaseModule } from '../message-release/message-release.module.js';
import { UsersModule } from '../users/users.module.js';
import { MessageSchedulesController } from './message-schedules.controller.js';
import { MessageSchedulesService } from './message-schedules.service.js';

@Module({
  // UsersModule provides UsersService for SessionAuthGuard; MessageReleaseModule
  // provides the release queue that schedule changes keep in sync.
  imports: [UsersModule, MessageReleaseModule],
  controllers: [MessageSchedulesController],
  providers: [MessageSchedulesService],
})
export class MessageSchedulesModule {}
