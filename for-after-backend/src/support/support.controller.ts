import { Body, Controller, Get, Logger, Param, ParseUUIDPipe, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';
import { PageQueryDto } from '../admin/dto/admin.dto.js';
import { adminActor, type AuditActor } from '../audit/audit-log.service.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { AdminGuard } from '../auth/guards/admin.guard.js';
import { CustomerGuard } from '../auth/guards/customer.guard.js';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard.js';
import { AUTH } from '../config/swagger.js';
import { AuditActorType } from '../generated/prisma/client.js';
import type { SafeUser } from '../users/users.service.js';
import { AdminSupportQueryDto, CreateSupportRequestDto, SupportStatusDto, SupportTextDto } from './dto/support.dto.js';
import { SupportService } from './support.service.js';

// Per IP, in Redis like every throttled route (a Redis failure fails the request).
const CREATE_LIMIT = { default: { limit: 10, ttl: 3_600_000 } };
const FOLLOW_UP_LIMIT = { default: { limit: 30, ttl: 3_600_000 } };
const ADMIN_WRITE_LIMIT = { default: { limit: 60, ttl: 60_000 } };

const customerActor = (req: Request, user: SafeUser): AuditActor => ({
  type: AuditActorType.CUSTOMER,
  userId: user.id,
  ip: req.ip,
  userAgent: req.headers['user-agent'],
});

/**
 * The signed-in Customer's own support requests. Owner and author always come
 * from the session; another Customer's request is a 404. Support text is never logged.
 */
@ApiTags('Support')
@ApiCookieAuth(AUTH.customer)
@Controller('support/requests')
@UseGuards(SessionAuthGuard, CustomerGuard)
export class SupportController {
  constructor(private readonly support: SupportService) {}

  @Get()
  list(@CurrentUser() user: SafeUser, @Query() q: PageQueryDto) {
    return this.support.listOwn(user.id, q.page, q.limit);
  }

  @Get(':id')
  get(@CurrentUser() user: SafeUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.support.getOwn(user.id, id);
  }

  @Post()
  @UseGuards(ThrottlerGuard)
  @Throttle(CREATE_LIMIT)
  create(@CurrentUser() user: SafeUser, @Body() dto: CreateSupportRequestDto, @Req() req: Request) {
    return this.support.create(user.id, dto, customerActor(req, user));
  }

  @Post(':id/messages')
  @UseGuards(ThrottlerGuard)
  @Throttle(FOLLOW_UP_LIMIT)
  followUp(
    @CurrentUser() user: SafeUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SupportTextDto,
    @Req() req: Request,
  ) {
    return this.support.followUp(user.id, id, dto, customerActor(req, user));
  }
}

/**
 * The support inbox. Reply and note are separate commands: visibility is the
 * endpoint (and the table), never a flag in the body. No edit or delete.
 */
@ApiTags('Admin')
@ApiCookieAuth(AUTH.admin)
@Controller('admin/support/requests')
@UseGuards(SessionAuthGuard, AdminGuard)
export class AdminSupportController {
  private readonly logger = new Logger(AdminSupportController.name);

  constructor(private readonly support: SupportService) {}

  @Get()
  list(@Query() q: AdminSupportQueryDto, @Req() req: Request) {
    this.logger.log(`admin_support_viewed admin ${req.user!.id}`);
    return this.support.list(q);
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.support.get(id);
  }

  @Post(':id/replies')
  @UseGuards(ThrottlerGuard)
  @Throttle(ADMIN_WRITE_LIMIT)
  reply(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SupportTextDto, @Req() req: Request) {
    return this.support.reply(id, dto, adminActor(req));
  }

  @Post(':id/notes')
  @UseGuards(ThrottlerGuard)
  @Throttle(ADMIN_WRITE_LIMIT)
  note(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SupportTextDto, @Req() req: Request) {
    return this.support.note(id, dto, adminActor(req));
  }

  @Patch(':id/status')
  @UseGuards(ThrottlerGuard)
  @Throttle(ADMIN_WRITE_LIMIT)
  setStatus(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SupportStatusDto, @Req() req: Request) {
    return this.support.setStatus(id, dto, adminActor(req));
  }
}
