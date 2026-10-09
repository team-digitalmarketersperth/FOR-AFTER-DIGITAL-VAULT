import { Module } from '@nestjs/common';
import { MediaModule } from '../media/media.module.js';
import { UsersModule } from '../users/users.module.js';
import { MessageSnapshotService } from './message-snapshot.service.js';
import { MessagesController } from './messages.controller.js';
import { MessagesService } from './messages.service.js';

@Module({
  // UsersModule provides UsersService for SessionAuthGuard; MediaModule the
  // shared MediaStorage (deleting a message removes its media objects).
  imports: [UsersModule, MediaModule],
  controllers: [MessagesController],
  providers: [MessagesService, MessageSnapshotService],
  // Memory Vault (13B) and My Story (14B) make messages from private content
  // through the same snapshot service and rules.
  exports: [MessagesService, MessageSnapshotService],
})
export class MessagesModule {}
