import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module.js';
import { MediaController } from './media.controller.js';
import { MediaService } from './media.service.js';
import { MediaStorage } from './storage/media-storage.service.js';
import { S3MediaStorage } from './storage/s3-media-storage.service.js';

@Module({
  // UsersModule provides UsersService for SessionAuthGuard.
  imports: [UsersModule],
  controllers: [MediaController],
  // Provider is configuration: any S3-compatible bucket uses S3MediaStorage.
  // Tests override MediaStorage with a mock.
  providers: [
    MediaService,
    { provide: MediaStorage, useClass: S3MediaStorage },
  ],
  // One storage client app-wide: Memory Vault media reuses it.
  exports: [MediaStorage],
})
export class MediaModule {}
