import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module.js';
import { MyStoryController } from './my-story.controller.js';
import { MyStoryService } from './my-story.service.js';

@Module({
  // UsersModule provides UsersService for SessionAuthGuard.
  imports: [UsersModule],
  controllers: [MyStoryController],
  providers: [MyStoryService],
})
export class MyStoryModule {}
