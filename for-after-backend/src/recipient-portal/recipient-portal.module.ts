import { Module } from '@nestjs/common';
import { MediaModule } from '../media/media.module.js';
import { RecipientAuthModule } from '../recipient-auth/recipient-auth.module.js';
import { RecipientMessagesController } from './recipient-messages.controller.js';
import { RecipientMessagesService } from './recipient-messages.service.js';

@Module({
  // RecipientAuthModule provides the Recipient guard; MediaModule the one
  // storage client used to sign media URLs.
  imports: [RecipientAuthModule, MediaModule],
  controllers: [RecipientMessagesController],
  providers: [RecipientMessagesService],
})
export class RecipientPortalModule {}
