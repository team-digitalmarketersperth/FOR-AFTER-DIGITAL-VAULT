import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';
import { PageQueryDto } from '../admin/dto/admin.dto.js';
import { adminActor } from '../audit/audit-log.service.js';
import { AdminGuard } from '../auth/guards/admin.guard.js';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard.js';
import { SuperAdminGuard } from '../auth/guards/super-admin.guard.js';
import { AUTH } from '../config/swagger.js';
import {
  AddPilotMemberDto,
  AnnouncementContentDto,
  AudienceScopeDto,
  BroadcastReviewDto,
  CreateAnnouncementDto,
  CreateBroadcastDto,
  CreateRetryDto,
  CreateTestSendDto,
  RecipientQueryDto,
  RetryReviewDto,
  UpdateAnnouncementDto,
} from './announcements.dto.js';
import { AnnouncementBroadcastService } from './announcement-broadcast.service.js';
import { AnnouncementAudienceService } from './announcement-audience.service.js';
import { AnnouncementResultsService } from './announcement-results.service.js';
import { AnnouncementsService } from './announcements.service.js';

// Per IP, in Redis like every throttled route.
const WRITE_LIMIT = { default: { limit: 30, ttl: 60_000 } };
const PREVIEW_LIMIT = { default: { limit: 60, ttl: 60_000 } };
// Per IP; the per-admin (3 / 10 min) and shared limits are enforced in the service.
const TEST_LIMIT = { default: { limit: 10, ttl: 60_000 } };
// One aggregate query per call.
const AUDIENCE_LIMIT = { default: { limit: 20, ttl: 60_000 } };
// Step 4: confirming and stopping broadcasts are rare, deliberate actions.
const BROADCAST_LIMIT = { default: { limit: 5, ttl: 60_000 } };
const CANCEL_LIMIT = { default: { limit: 10, ttl: 60_000 } };

/**
 * Notification centre, Step 1: email announcement drafts and preview only.
 * SUPER_ADMIN with a completed admin MFA session; the Origin check, no-store
 * and strict validation apply globally. Step 2 adds test emails to the requesting
 * super admin only. Step 4 adds the customer broadcast: review (server-signed),
 * confirm (records a run; the worker sends), progress and stop. Sending also
 * needs ANNOUNCEMENT_BROADCAST_ENABLED=true and a cleared communication policy.
 */
@ApiTags('Admin')
@ApiCookieAuth(AUTH.admin)
@Controller('admin/announcements')
@UseGuards(SessionAuthGuard, AdminGuard, SuperAdminGuard)
export class AdminAnnouncementsController {
  constructor(
    private readonly announcements: AnnouncementsService,
    private readonly audience: AnnouncementAudienceService,
    private readonly broadcasts: AnnouncementBroadcastService,
    private readonly results: AnnouncementResultsService,
  ) {}

  @Get()
  list(@Query() q: PageQueryDto) {
    return this.announcements.list(q.page, q.limit);
  }

  // Declared before :id. Renders unsaved content; stores nothing.
  @Post('preview')
  @HttpCode(200)
  @UseGuards(ThrottlerGuard)
  @Throttle(PREVIEW_LIMIT)
  preview(@Body() dto: AnnouncementContentDto) {
    return this.announcements.preview(dto);
  }

  /** The requester's own verified email (null when unverified): the only place a test can go. */
  @Get('test-destination')
  testDestination(@Req() req: Request) {
    return this.announcements.testDestination(req.user!.id);
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    return this.announcements.get(id, req.user!.id);
  }

  /** 202: accepted for sending, not sent. A replay with the same clientOperationId returns the same request. */
  @Post(':id/test-sends')
  @HttpCode(202)
  @UseGuards(ThrottlerGuard)
  @Throttle(TEST_LIMIT)
  requestTest(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateTestSendDto, @Req() req: Request) {
    return this.announcements.requestTest(id, dto, adminActor(req));
  }

  /** Step 3: read-only audience review of the saved draft. Counts only; sends nothing. */
  @Get(':id/audience')
  @UseGuards(ThrottlerGuard)
  @Throttle(AUDIENCE_LIMIT)
  reviewAudience(@Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    return this.audience.review(id, adminActor(req));
  }

  /** Step 4: what "Queue announcement" would send, with blockers; a review token only when sending is possible. */
  @Post(':id/broadcast-review')
  @HttpCode(200)
  @UseGuards(ThrottlerGuard)
  @Throttle(AUDIENCE_LIMIT)
  reviewBroadcast(@Param('id', ParseUUIDPipe) id: string, @Body() dto: BroadcastReviewDto, @Req() req: Request) {
    return this.broadcasts.review(id, dto.expectedVersion, adminActor(req));
  }

  /** 202: the run is recorded and queued, not sent. A replay with the same clientOperationId returns the same run. */
  @Post(':id/broadcasts')
  @HttpCode(202)
  @UseGuards(ThrottlerGuard)
  @Throttle(BROADCAST_LIMIT)
  queueBroadcast(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateBroadcastDto, @Req() req: Request) {
    return this.broadcasts.confirm(id, dto, adminActor(req));
  }

  /** Progress plus the manual-retry summary (eligible count, why not, recent requests). Readable with broadcasting off. */
  @Get(':id/broadcasts/:runId')
  async getBroadcast(@Param('id', ParseUUIDPipe) id: string, @Param('runId', ParseUUIDPipe) runId: string) {
    const progress = await this.broadcasts.progress(id, runId);
    return { ...progress, retry: await this.results.summary(id, runId) };
  }

  /** Results table: one page of recipients (state, safe reason, attempts; the address only while unchanged). */
  @Get(':id/broadcasts/:runId/recipients')
  getRecipients(@Param('id', ParseUUIDPipe) id: string, @Param('runId', ParseUUIDPipe) runId: string, @Query() q: RecipientQueryDto) {
    return this.results.recipients(id, runId, q);
  }

  @Get(':id/broadcasts/:runId/recipients/:recipientId')
  getRecipient(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('runId', ParseUUIDPipe) runId: string,
    @Param('recipientId', ParseUUIDPipe) recipientId: string,
  ) {
    return this.results.recipient(id, runId, recipientId);
  }

  /** The email exactly as queued for this run (not the current draft). */
  @Get(':id/broadcasts/:runId/email')
  getRunEmail(@Param('id', ParseUUIDPipe) id: string, @Param('runId', ParseUUIDPipe) runId: string) {
    return this.results.email(id, runId);
  }

  /** What a manual retry would queue now (exact set hash and count), or why not. Changes nothing. */
  @Post(':id/broadcasts/:runId/retry-review')
  @HttpCode(200)
  @UseGuards(ThrottlerGuard)
  @Throttle(AUDIENCE_LIMIT)
  reviewRetry(@Param('id', ParseUUIDPipe) id: string, @Param('runId', ParseUUIDPipe) runId: string, @Body() dto: RetryReviewDto) {
    return this.results.reviewRetry(id, runId, dto.recipientId);
  }

  /** 202: the reviewed failures are queued again in this run (the worker sends). A replay returns the same request. */
  @Post(':id/broadcasts/:runId/retries')
  @HttpCode(202)
  @UseGuards(ThrottlerGuard)
  @Throttle(BROADCAST_LIMIT)
  retry(@Param('id', ParseUUIDPipe) id: string, @Param('runId', ParseUUIDPipe) runId: string, @Body() dto: CreateRetryDto, @Req() req: Request) {
    return this.results.confirmRetry(id, runId, dto, adminActor(req));
  }

  @Post(':id/broadcasts/:runId/cancel')
  @HttpCode(200)
  @UseGuards(ThrottlerGuard)
  @Throttle(CANCEL_LIMIT)
  cancelBroadcast(@Param('id', ParseUUIDPipe) id: string, @Param('runId', ParseUUIDPipe) runId: string, @Req() req: Request) {
    return this.broadcasts.cancel(id, runId, adminActor(req));
  }

  /** Step 7: the audience scope and each pilot member's status (SUPER_ADMIN only, like every route here). */
  @Get(':id/pilot')
  getPilot(@Param('id', ParseUUIDPipe) id: string) {
    return this.audience.pilot(id);
  }

  @Put(':id/audience-scope')
  @UseGuards(ThrottlerGuard)
  @Throttle(WRITE_LIMIT)
  setAudience(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AudienceScopeDto, @Req() req: Request) {
    return this.audience.setAudience(id, dto.audience, adminActor(req));
  }

  @Post(':id/pilot')
  @HttpCode(200)
  @UseGuards(ThrottlerGuard)
  @Throttle(WRITE_LIMIT)
  addPilot(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AddPilotMemberDto, @Req() req: Request) {
    return this.audience.addPilot(id, dto.email, adminActor(req));
  }

  @Delete(':id/pilot/:userId')
  @UseGuards(ThrottlerGuard)
  @Throttle(WRITE_LIMIT)
  removePilot(@Param('id', ParseUUIDPipe) id: string, @Param('userId', ParseUUIDPipe) userId: string, @Req() req: Request) {
    return this.audience.removePilot(id, userId, adminActor(req));
  }

  @Get(':id/test-sends/:testId')
  getTest(@Param('id', ParseUUIDPipe) id: string, @Param('testId', ParseUUIDPipe) testId: string, @Req() req: Request) {
    return this.announcements.getTest(id, testId, req.user!.id);
  }

  @Post()
  @UseGuards(ThrottlerGuard)
  @Throttle(WRITE_LIMIT)
  create(@Body() dto: CreateAnnouncementDto, @Req() req: Request) {
    return this.announcements.create(dto, adminActor(req));
  }

  @Put(':id')
  @UseGuards(ThrottlerGuard)
  @Throttle(WRITE_LIMIT)
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateAnnouncementDto, @Req() req: Request) {
    return this.announcements.update(id, dto, adminActor(req));
  }
}
