import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module.js';
import { RecipientsController } from './recipients.controller.js';
import { RecipientsService } from './recipients.service.js';

@Module({
  // UsersModule provides UsersService for SessionAuthGuard.
  imports: [UsersModule],
  controllers: [RecipientsController],
  providers: [RecipientsService],
})
export class RecipientsModule {}
