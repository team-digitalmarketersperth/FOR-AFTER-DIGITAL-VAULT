import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module.js';
import { TrustedContactsController } from './trusted-contacts.controller.js';
import { TrustedContactsService } from './trusted-contacts.service.js';

@Module({
  // UsersModule provides UsersService for SessionAuthGuard.
  imports: [UsersModule],
  controllers: [TrustedContactsController],
  providers: [TrustedContactsService],
})
export class TrustedContactsModule {}
