import { Module } from '@nestjs/common';
import { AssistantModule } from '../assistant/assistant.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { DeathVerificationModule } from '../death-verification/death-verification.module.js';
import { HealthModule } from '../health/health.module.js';
import { IpBlockModule } from '../ip-blocks/ip-block.module.js';
import { MessageReleaseModule } from '../message-release/message-release.module.js';
import { ReleaseNotificationModule } from '../release-notifications/release-notification.module.js';
import { UsersModule } from '../users/users.module.js';
import {
  AdminAccessController,
  AdminAiController,
  AdminAuditController,
  AdminDashboardController,
  AdminDeadLettersController,
  AdminDeliveriesController,
  AdminIpBlocksController,
  AdminQueuesController,
  AdminReleasesController,
  AdminSecurityController,
  AdminStorageController,
  AdminSystemHealthController,
  AdminUsersController,
} from './admin.controller.js';
import { AdminDeliveriesService } from './admin-deliveries.service.js';
import { AdminQueuesService } from './admin-queues.service.js';
import { AdminReleasesService } from './admin-releases.service.js';
import { AdminAccessService } from './admin-access.service.js';
import { AdminAiService } from './admin-ai.service.js';
import { AdminSecurityService } from './admin-security.service.js';
import { AdminStorageService } from './admin-storage.service.js';
import { AdminService } from './admin.service.js';
import { SystemHealthService } from './system-health.service.js';

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
    ReleaseNotificationModule,
    HealthModule,
    AssistantModule,
    AuthModule,
    IpBlockModule,
  ],
  controllers: [
    AdminDashboardController,
    AdminUsersController,
    AdminAuditController,
    AdminQueuesController,
    AdminDeadLettersController,
    AdminReleasesController,
    AdminDeliveriesController,
    AdminSecurityController,
    AdminIpBlocksController,
    AdminStorageController,
    AdminSystemHealthController,
    AdminAiController,
    AdminAccessController,
  ],
  providers: [
    AdminService,
    AdminQueuesService,
    AdminReleasesService,
    AdminDeliveriesService,
    AdminSecurityService,
    AdminAiService,
    AdminAccessService,
    AdminStorageService,
    SystemHealthService,
  ],
})
export class AdminModule {}
