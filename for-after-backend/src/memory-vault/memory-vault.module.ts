import { Module } from '@nestjs/common';
import { MediaModule } from '../media/media.module.js';
import { UsersModule } from '../users/users.module.js';
import { MemoryVaultMediaService } from './memory-vault-media.service.js';
import { MemoryVaultController } from './memory-vault.controller.js';
import { MemoryVaultService } from './memory-vault.service.js';

@Module({
  // UsersModule provides UsersService for SessionAuthGuard; MediaModule
  // provides the shared MediaStorage (no second storage client).
  imports: [UsersModule, MediaModule],
  controllers: [MemoryVaultController],
  providers: [MemoryVaultService, MemoryVaultMediaService],
})
export class MemoryVaultModule {}
