import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { DeathVerificationModule } from '../death-verification/death-verification.module.js';
import { MessageReleaseModule } from '../message-release/message-release.module.js';
import { UsersModule } from '../users/users.module.js';
import {
  AdminAuditController,
  AdminDashboardController,
  AdminQueuesController,
  AdminUsersController,
} from './admin.controller.js';
import { AdminQueuesService } from './admin-queues.service.js';
import { AdminService } from './admin.service.js';

// Admin backend (Step 16). Admin sign-in + MFA is AdminAuthModule; death case
// review stays in DeathVerificationModule (same guards, audit and paging).
// UsersModule backs SessionAuthGuard; the two queue modules provide the
// allowlisted Queue instances.
@Module({
  imports: [
    UsersModule,
    AuditModule,
    MessageReleaseModule,
    DeathVerificationModule,
  ],
  controllers: [
    AdminDashboardController,
    AdminUsersController,
    AdminAuditController,
    AdminQueuesController,
  ],
  providers: [AdminService, AdminQueuesService],
})
export class AdminModule {}
