import { Module } from '@nestjs/common';
import { MediaModule } from '../media/media.module.js';
import { UsersModule } from '../users/users.module.js';
import { RecipientPhotoService } from './recipient-photo.service.js';
import { RecipientsController } from './recipients.controller.js';
import { RecipientsService } from './recipients.service.js';

@Module({
  // UsersModule provides UsersService for SessionAuthGuard; MediaModule the
  // shared MediaStorage (Phase 09 photos; no second storage client).
  imports: [UsersModule, MediaModule],
  controllers: [RecipientsController],
  providers: [RecipientsService, RecipientPhotoService],
})
export class RecipientsModule {}
