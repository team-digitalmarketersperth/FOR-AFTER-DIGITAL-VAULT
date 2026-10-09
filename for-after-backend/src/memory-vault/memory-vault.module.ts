import { Module } from '@nestjs/common';
import { MediaModule } from '../media/media.module.js';
import { MessagesModule } from '../messages/messages.module.js';
import { UsersModule } from '../users/users.module.js';
import { MemoryToMessageService } from './memory-to-message.service.js';
import { MemoryVaultMediaService } from './memory-vault-media.service.js';
import { MemoryVaultController } from './memory-vault.controller.js';
import { MemoryVaultService } from './memory-vault.service.js';

@Module({
  // UsersModule provides UsersService for SessionAuthGuard; MediaModule
  // provides the shared MediaStorage (no second storage client).
  // MessagesModule: a memory becomes a normal Message (Phase 13B).
  imports: [UsersModule, MediaModule, MessagesModule],
  controllers: [MemoryVaultController],
  providers: [
    MemoryVaultService,
    MemoryVaultMediaService,
    MemoryToMessageService,
  ],
})
export class MemoryVaultModule {}
