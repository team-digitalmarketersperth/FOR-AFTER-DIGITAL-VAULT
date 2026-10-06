import { Module } from '@nestjs/common';
import { EmailModule } from '../email/email.module.js';
import { UsersModule } from '../users/users.module.js';
import { TrustedContactInvitationsService } from './trusted-contact-invitations.service.js';
import {
  TrustedContactInvitationController,
  TrustedContactsController,
} from './trusted-contacts.controller.js';
import { TrustedContactsService } from './trusted-contacts.service.js';

@Module({
  // UsersModule provides UsersService for SessionAuthGuard; EmailModule the
  // invitation emails (Phase 10).
  imports: [UsersModule, EmailModule],
  controllers: [TrustedContactsController, TrustedContactInvitationController],
  providers: [TrustedContactsService, TrustedContactInvitationsService],
})
export class TrustedContactsModule {}
