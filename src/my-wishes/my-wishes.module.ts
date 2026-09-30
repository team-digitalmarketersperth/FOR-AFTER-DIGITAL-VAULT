import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module.js';
import { MyWishesController } from './my-wishes.controller.js';
import { MyWishesService } from './my-wishes.service.js';

@Module({
  // UsersModule provides UsersService for SessionAuthGuard.
  imports: [UsersModule],
  controllers: [MyWishesController],
  providers: [MyWishesService],
})
export class MyWishesModule {}
