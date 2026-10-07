import { Module } from '@nestjs/common';
import { MediaModule } from '../media/media.module.js';
import { UsersModule } from '../users/users.module.js';
import { MessagesController } from './messages.controller.js';
import { MessagesService } from './messages.service.js';

@Module({
  // UsersModule provides UsersService for SessionAuthGuard; MediaModule the
  // shared MediaStorage (deleting a message removes its media objects).
  imports: [UsersModule, MediaModule],
  controllers: [MessagesController],
  providers: [MessagesService],
})
export class MessagesModule {}
