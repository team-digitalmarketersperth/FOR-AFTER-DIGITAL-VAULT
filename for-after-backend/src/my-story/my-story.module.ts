import { Module } from '@nestjs/common';
import { MediaModule } from '../media/media.module.js';
import { MessagesModule } from '../messages/messages.module.js';
import { UsersModule } from '../users/users.module.js';
import { MyStoryMediaService } from './my-story-media.service.js';
import { MyStoryController } from './my-story.controller.js';
import { MyStoryService } from './my-story.service.js';
import { StoryToMessageService } from './story-to-message.service.js';

@Module({
  // UsersModule provides UsersService for SessionAuthGuard; MediaModule the
  // shared storage, scanner, quota and cleanup (Phase 14B media);
  // MessagesModule the snapshot service (Story → Message).
  imports: [UsersModule, MediaModule, MessagesModule],
  controllers: [MyStoryController],
  providers: [MyStoryService, MyStoryMediaService, StoryToMessageService],
})
export class MyStoryModule {}
