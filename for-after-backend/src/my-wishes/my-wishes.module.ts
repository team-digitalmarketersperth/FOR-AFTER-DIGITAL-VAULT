import { Module } from '@nestjs/common';
import { MediaModule } from '../media/media.module.js';
import { MessagesModule } from '../messages/messages.module.js';
import { UsersModule } from '../users/users.module.js';
import { MyWishesMediaService } from './my-wishes-media.service.js';
import { WishToMessageService } from './wish-to-message.service.js';
import {
  MyWishesDisclaimer,
  MyWishesDisclaimerService,
} from './my-wishes-disclaimer.service.js';
import {
  MyWishesController,
  MyWishesDisclaimerController,
} from './my-wishes.controller.js';
import { MyWishesService } from './my-wishes.service.js';

@Module({
  // UsersModule provides UsersService for SessionAuthGuard; MediaModule the
  // shared storage, scanner, quota and cleanup (Phase 15B media);
  // MessagesModule the snapshot service (Wish → Message).
  imports: [UsersModule, MediaModule, MessagesModule],
  controllers: [MyWishesController, MyWishesDisclaimerController],
  providers: [
    MyWishesService,
    MyWishesDisclaimer,
    MyWishesDisclaimerService,
    MyWishesMediaService,
    WishToMessageService,
  ],
})
export class MyWishesModule {}
