import {
  Body,
  Controller,
  Get,
  HttpCode,
  Logger,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { adminActor, AuditLogService } from '../audit/audit-log.service.js';
import { AdminGuard } from '../auth/guards/admin.guard.js';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard.js';
import { AdminDeliveriesService } from './admin-deliveries.service.js';
import { AdminQueuesService } from './admin-queues.service.js';
import { AdminReleasesService } from './admin-releases.service.js';
import { AdminAccessService, assertCanCreateAdmins, assertCanManageIpBlocks, hasRecentAuth } from './admin-access.service.js';
import { IpBlockService } from '../ip-blocks/ip-block.service.js';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { AdminAiService } from './admin-ai.service.js';
import { AdminSecurityService } from './admin-security.service.js';
import { AdminStorageService } from './admin-storage.service.js';
import { AdminService } from './admin.service.js';
import { BillingService } from '../billing/billing.service.js';
import { UserRole } from '../generated/prisma/client.js';
import { SystemHealthService } from './system-health.service.js';
import {
  AdminUserListQueryDto,
  AdminAccessQueryDto,
  CreateAdminDto,
  AiOperationsQueryDto,
  AuditLogQueryDto,
  CreateIpBlockDto,
  IpBlockQueryDto,
  DeadLetterQueryDto,
  DeliveryListQueryDto,
  PageQueryDto,
  ReactivateUserDto,
  ReleaseListQueryDto,
  SecurityEventQueryDto,
  StorageAssetQueryDto,
  SuspendUserDto,
} from './dto/admin.dto.js';
import { AUTH } from '../config/swagger.js';

// Every admin route: a Customer session (or none) → 401/403; Recipient and
// Trusted Contact cookies are never read here, so they get 401. The Step 15
// death-verification routes live in DeathVerificationModule with the same guards.

@ApiTags('Admin')
@ApiCookieAuth(AUTH.admin)
@Controller('admin/dashboard')
@UseGuards(SessionAuthGuard, AdminGuard)
export class AdminDashboardController {
  constructor(private readonly admin: AdminService) {}

  @Get()
  dashboard() {
    return this.admin.dashboard();
  }
}

@ApiTags('Admin')
@ApiCookieAuth(AUTH.admin)
@Controller('admin/users')
@UseGuards(SessionAuthGuard, AdminGuard)
export class AdminUsersController {
  constructor(
    private readonly admin: AdminService,
    private readonly billing: BillingService,
  ) {}

  // Billing summary (docs/billing.md §6): SUPER_ADMIN viewers only, from the
  // same access-state function as everywhere else; omitted for other admins.
  private async withBilling<T extends { id: string }>(req: Request, items: T[]) {
    if (req.user!.role !== UserRole.SUPER_ADMIN) return items;
    const map = await this.billing.summaries(items.map((i) => i.id));
    return items.map((i) => ({ ...i, billing: map.get(i.id) ?? null }));
  }

  @Get()
  async list(@Query() query: AdminUserListQueryDto, @Req() req: Request) {
    const page = await this.admin.listUsers(query);
    return { ...page, items: await this.withBilling(req, page.items) };
  }

  @Get(':userId')
  async get(@Param('userId', ParseUUIDPipe) userId: string, @Req() req: Request) {
    const [user] = await this.withBilling(req, [await this.admin.getUser(userId, adminActor(req))]);
    return user;
  }

  @Post(':userId/suspend')
  @HttpCode(200)
  suspend(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: SuspendUserDto,
    @Req() req: Request,
  ) {
    return this.admin.suspend(userId, dto.reason, adminActor(req));
  }

  @Post(':userId/reactivate')
  @HttpCode(200)
  reactivate(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: ReactivateUserDto,
    @Req() req: Request,
  ) {
    return this.admin.reactivate(userId, dto.reason, adminActor(req));
  }
}

/** Read-only: there is no route that updates or deletes an audit row. */
@ApiTags('Admin')
@ApiCookieAuth(AUTH.admin)
@Controller('admin/audit-logs')
@UseGuards(SessionAuthGuard, AdminGuard)
export class AdminAuditController {
  private readonly logger = new Logger(AdminAuditController.name);

  constructor(private readonly audit: AuditLogService) {}

  @Get()
  list(@Query() query: AuditLogQueryDto, @Req() req: Request) {
    this.logger.log(`admin_audit_viewed admin ${req.user!.id}`);
    return this.audit.list(query);
  }

  @Get(':auditLogId')
  get(@Param('auditLogId', ParseUUIDPipe) id: string) {
    return this.audit.get(id);
  }
}

/** Security Activity (§20): a read-only projection of security audit rows. */
@ApiTags('Admin')
@ApiCookieAuth(AUTH.admin)
@Controller('admin/security/events')
@UseGuards(SessionAuthGuard, AdminGuard)
export class AdminSecurityController {
  private readonly logger = new Logger(AdminSecurityController.name);

  constructor(private readonly security: AdminSecurityService) {}

  @Get()
  list(@Query() query: SecurityEventQueryDto, @Req() req: Request) {
    this.logger.log(`admin_security_viewed admin ${req.user!.id}`);
    return this.security.list(query);
  }

  @Get(':reference')
  get(@Param('reference', ParseUUIDPipe) reference: string) {
    return this.security.get(reference);
  }
}

const IP_BLOCK_LIMIT = { default: { limit: 30, ttl: 3_600_000 } };

/** Temporary IP blocks (§20a). Reads for any admin (masked); changes need SUPER_ADMIN + recent two-factor. */
@ApiTags('Admin')
@ApiCookieAuth(AUTH.admin)
@Controller('admin/security/ip-blocks')
@UseGuards(SessionAuthGuard, AdminGuard)
export class AdminIpBlocksController {
  constructor(private readonly blocks: IpBlockService) {}

  @Get()
  list(@Query() query: IpBlockQueryDto, @Req() req: Request) {
    return this.blocks.list(query, {
      superAdmin: req.user!.role === UserRole.SUPER_ADMIN,
      recentAuth: hasRecentAuth(req.session.adminMfaVerifiedAt),
    });
  }

  @Post()
  @UseGuards(ThrottlerGuard)
  @Throttle(IP_BLOCK_LIMIT)
  create(@Body() dto: CreateIpBlockDto, @Req() req: Request) {
    assertCanManageIpBlocks(req.user!.role, req.session.adminMfaVerifiedAt);
    return this.blocks.create(dto, adminActor(req), [req.ip, req.socket.remoteAddress]);
  }

  @Post(':id/revoke')
  @HttpCode(200)
  @UseGuards(ThrottlerGuard)
  @Throttle(IP_BLOCK_LIMIT)
  revoke(@Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    assertCanManageIpBlocks(req.user!.role, req.session.adminMfaVerifiedAt);
    return this.blocks.revoke(id, adminActor(req));
  }
}

/** Storage & scans (§21): read-only stored-file metadata; never files or links. */
@ApiTags('Admin')
@ApiCookieAuth(AUTH.admin)
@Controller('admin/storage/assets')
@UseGuards(SessionAuthGuard, AdminGuard)
export class AdminStorageController {
  private readonly logger = new Logger(AdminStorageController.name);

  constructor(private readonly storage: AdminStorageService) {}

  @Get()
  list(@Query() query: StorageAssetQueryDto, @Req() req: Request) {
    this.logger.log(`admin_storage_viewed admin ${req.user!.id}`);
    return this.storage.list(query);
  }

  @Get(':reference')
  get(@Param('reference', ParseUUIDPipe) reference: string) {
    return this.storage.get(reference);
  }
}

// Create admin + resend: per IP, like every throttled route; invitations are also capped at 3 per account per hour.
const ADMIN_INVITE_LIMIT = { default: { limit: 20, ttl: 3_600_000 } };

/**
 * Admin access (§22): read-only views, plus Create admin and resend invitation
 * for SUPER_ADMIN with recent two-factor (checked here, on every request).
 */
@ApiTags('Admin')
@ApiCookieAuth(AUTH.admin)
@Controller('admin/access/admins')
@UseGuards(SessionAuthGuard, AdminGuard)
export class AdminAccessController {
  private readonly logger = new Logger(AdminAccessController.name);

  constructor(private readonly access: AdminAccessService) {}

  @Get()
  list(@Query() query: AdminAccessQueryDto, @Req() req: Request) {
    this.logger.log(`admin_access_viewed admin ${req.user!.id}`);
    return this.access.list(query);
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    const { userId, type } = adminActor(req);
    return this.access.get(id, { id: userId, type });
  }

  @Post()
  @UseGuards(ThrottlerGuard)
  @Throttle(ADMIN_INVITE_LIMIT)
  create(@Body() dto: CreateAdminDto, @Req() req: Request) {
    assertCanCreateAdmins(req.user!.role, req.session.adminMfaVerifiedAt);
    return this.access.create(dto, adminActor(req));
  }

  @Post(':id/invitation')
  @HttpCode(200)
  @UseGuards(ThrottlerGuard)
  @Throttle(ADMIN_INVITE_LIMIT)
  resend(@Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    assertCanCreateAdmins(req.user!.role, req.session.adminMfaVerifiedAt);
    return this.access.resend(id, adminActor(req));
  }
}


/** AI Operations (docs/assistant.md §8): settings presence + aggregates; never a provider call. */
@ApiTags('Admin')
@ApiCookieAuth(AUTH.admin)
@Controller('admin/system/ai')
@UseGuards(SessionAuthGuard, AdminGuard)
export class AdminAiController {
  constructor(private readonly ai: AdminAiService) {}

  @Get()
  operations(@Query() query: AiOperationsQueryDto) {
    return this.ai.operations(query);
  }
}

@ApiTags('Admin')
@ApiCookieAuth(AUTH.admin)
@Controller('admin/system/queues')
@UseGuards(SessionAuthGuard, AdminGuard)
export class AdminQueuesController {
  constructor(private readonly queues: AdminQueuesService) {}

  @Get()
  summary() {
    return this.queues.summary();
  }

  @Get(':queueName/failed')
  failed(@Param('queueName') name: string, @Query() query: PageQueryDto) {
    return this.queues.failed(name, query.page, query.limit);
  }

  @Post(':queueName/jobs/:jobId/retry')
  @HttpCode(200)
  retry(
    @Param('queueName') name: string,
    @Param('jobId') jobId: string,
    @Req() req: Request,
  ) {
    return this.queues.retry(name, jobId, adminActor(req));
  }
}

/** Phase 17A: durable dead letters. Ids and safe categories only. */
@ApiTags('Admin')
@ApiCookieAuth(AUTH.admin)
@Controller('admin/system/dead-letters')
@UseGuards(SessionAuthGuard, AdminGuard)
export class AdminDeadLettersController {
  constructor(private readonly queues: AdminQueuesService) {}

  @Get()
  list(@Query() query: DeadLetterQueryDto) {
    return this.queues.deadLetters(query);
  }

  @Get(':deadLetterId')
  get(@Param('deadLetterId', ParseUUIDPipe) id: string) {
    return this.queues.deadLetter(id);
  }

  @Post(':deadLetterId/retry')
  @HttpCode(200)
  retry(
    @Param('deadLetterId', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ) {
    return this.queues.retryDeadLetter(id, adminActor(req));
  }
}

// Release monitoring (docs/admin.md §16): GET only, PostgreSQL only, ids and
// states only. Responses are no-store like every admin route (app.setup.ts).
@ApiTags('Admin')
@ApiCookieAuth(AUTH.admin)
@Controller('admin/releases')
@UseGuards(SessionAuthGuard, AdminGuard)
export class AdminReleasesController {
  constructor(private readonly releases: AdminReleasesService) {}

  @Get()
  list(@Query() query: ReleaseListQueryDto) {
    return this.releases.list(query);
  }

  @Get(':reference')
  detail(@Param('reference', ParseUUIDPipe) reference: string, @Req() req: Request) {
    return this.releases.detail(reference, req.user!.id);
  }
}

// Delivery monitoring (docs/admin.md §17): GET only. Lists and stored history
// come from PostgreSQL; only the email detail's optional queue state reads Redis.
@ApiTags('Admin')
@ApiCookieAuth(AUTH.admin)
@Controller('admin/deliveries')
@UseGuards(SessionAuthGuard, AdminGuard)
export class AdminDeliveriesController {
  constructor(private readonly deliveries: AdminDeliveriesService) {}

  @Get()
  list(@Query() query: DeliveryListQueryDto) {
    return this.deliveries.list(query);
  }

  @Get('release-emails/:reference')
  releaseEmail(@Param('reference', ParseUUIDPipe) reference: string, @Req() req: Request) {
    return this.deliveries.releaseEmail(reference, req.user!.id);
  }

  @Get('safety-notices/:reference')
  safetyNotice(@Param('reference', ParseUUIDPipe) reference: string, @Req() req: Request) {
    return this.deliveries.safetyNotice(reference, req.user!.id);
  }
}

// System Health (docs/admin.md §19): observations from this API instance,
// read-only, no request input at all (no probe targets from the browser).
@ApiTags('Admin')
@ApiCookieAuth(AUTH.admin)
@Controller('admin/system/health')
@UseGuards(SessionAuthGuard, AdminGuard)
export class AdminSystemHealthController {
  constructor(private readonly health: SystemHealthService) {}

  @Get()
  check() {
    return this.health.check();
  }
}
