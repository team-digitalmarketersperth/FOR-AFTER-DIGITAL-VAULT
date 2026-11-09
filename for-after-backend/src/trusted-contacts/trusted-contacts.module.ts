import { Module } from '@nestjs/common';
import { EmailModule } from '../email/email.module.js';
import { SmsModule } from '../sms/sms.module.js';
import { UsersModule } from '../users/users.module.js';
import { TrustedContactInvitationsService } from './trusted-contact-invitations.service.js';
import {
  TrustedContactInvitationController,
  TrustedContactsController,
} from './trusted-contacts.controller.js';
import { TrustedContactsService } from './trusted-contacts.service.js';

@Module({
  // UsersModule provides UsersService for SessionAuthGuard; EmailModule and
  // SmsModule (SmsSender) the invitations (Phase 10).
  imports: [UsersModule, EmailModule, SmsModule],
  controllers: [TrustedContactsController, TrustedContactInvitationController],
  providers: [TrustedContactsService, TrustedContactInvitationsService],
})
export class TrustedContactsModule {}
