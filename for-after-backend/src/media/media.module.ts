import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module.js';
import { MediaCleanup } from './media-cleanup.service.js';
import { MediaController } from './media.controller.js';
import { MediaService } from './media.service.js';
import { StorageController } from './storage.controller.js';
import { StorageQuota } from './storage-quota.service.js';
import { ClamAvMalwareScanner } from './scanner/clamav-malware-scanner.service.js';
import { MalwareScanner } from './scanner/malware-scanner.service.js';
import { ImageKitMediaStorage } from './storage/imagekit-media-storage.service.js';
import { MediaStorage } from './storage/media-storage.service.js';

@Module({
  // UsersModule provides UsersService for SessionAuthGuard.
  imports: [UsersModule],
  controllers: [MediaController, StorageController],
  // ImageKit for every new upload; legacy B2 rows are served through it too.
  // Every upload is malware-scanned by clamd before READY. Tests override
  // MediaStorage and MalwareScanner with fakes.
  providers: [
    MediaService,
    MediaCleanup,
    StorageQuota,
    { provide: MediaStorage, useClass: ImageKitMediaStorage },
    { provide: MalwareScanner, useClass: ClamAvMalwareScanner },
  ],
  // One storage client and one cleanup app-wide: Memory Vault media,
  // Recipient photos, message deletion and the Recipient portal reuse them.
  exports: [MediaStorage, MalwareScanner, MediaCleanup, StorageQuota],
})
export class MediaModule {}
