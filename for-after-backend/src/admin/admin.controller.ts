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
import type { Request } from 'express';
import { adminActor, AuditLogService } from '../audit/audit-log.service.js';
import { AdminGuard } from '../auth/guards/admin.guard.js';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard.js';
import { AdminQueuesService } from './admin-queues.service.js';
import { AdminService } from './admin.service.js';
import {
  AdminUserListQueryDto,
  AuditLogQueryDto,
  PageQueryDto,
  ReactivateUserDto,
  SuspendUserDto,
} from './dto/admin.dto.js';

// Every admin route: a Customer session (or none) → 401/403; Recipient and
// Trusted Contact cookies are never read here, so they get 401. The Step 15
// death-verification routes live in DeathVerificationModule with the same guards.

@Controller('admin/dashboard')
@UseGuards(SessionAuthGuard, AdminGuard)
export class AdminDashboardController {
  constructor(private readonly admin: AdminService) {}

  @Get()
  dashboard() {
    return this.admin.dashboard();
  }
}

@Controller('admin/users')
@UseGuards(SessionAuthGuard, AdminGuard)
export class AdminUsersController {
  constructor(private readonly admin: AdminService) {}

  @Get()
  list(@Query() query: AdminUserListQueryDto) {
    return this.admin.listUsers(query);
  }

  @Get(':userId')
  get(@Param('userId', ParseUUIDPipe) userId: string, @Req() req: Request) {
    return this.admin.getUser(userId, adminActor(req));
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
