import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { adminActor } from '../audit/audit-log.service.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { AdminGuard } from '../auth/guards/admin.guard.js';
import { CustomerGuard } from '../auth/guards/customer.guard.js';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard.js';
import type { SafeUser } from '../users/users.service.js';
import {
  DeathVerificationService,
  type CustomerDeathVerificationStatus,
} from './death-verification.service.js';
import {
  ConfirmAliveDto,
  DeathVerificationListQueryDto,
  RejectDeathCaseDto,
  VerifyDeathCaseDto,
} from './dto/death-verification-decision.dto.js';

/**
 * The account holder's view of a death report about them. Works while the
 * case is open; after VERIFIED the account is PASSED, so the session guard
 * already refuses these routes (401).
 */
@Controller('death-verification/me')
@UseGuards(SessionAuthGuard, CustomerGuard)
export class CustomerDeathVerificationController {
  constructor(private readonly cases: DeathVerificationService) {}

  @Get()
  status(
    @CurrentUser() user: SafeUser,
  ): Promise<CustomerDeathVerificationStatus> {
    return this.cases.getCustomerStatus(user.id);
  }

  @Post('confirm-alive')
  @HttpCode(200)
  confirmAlive(
    @CurrentUser() user: SafeUser,
    @Body() _dto: ConfirmAliveDto,
  ): Promise<CustomerDeathVerificationStatus> {
    return this.cases.confirmAlive(user.id);
  }
}

/**
 * Step 15 admin decisions, part of the Step 16 admin backend: ADMIN and
 * SUPER_ADMIN with completed MFA only; Customers get 403, Recipient/Trusted
 * Contact sessions 401. Detail views and decisions write AuditLog rows.
 */
@Controller('admin/death-verifications')
@UseGuards(SessionAuthGuard, AdminGuard)
export class AdminDeathVerificationController {
  constructor(private readonly cases: DeathVerificationService) {}

  @Get()
  list(@Query() query: DeathVerificationListQueryDto) {
    return this.cases.listForAdmin(query.status, query.page, query.limit);
  }

  @Get(':caseId')
  get(@Param('caseId', ParseUUIDPipe) caseId: string, @Req() req: Request) {
    return this.cases.viewForAdmin(caseId, adminActor(req));
  }

  @Post(':caseId/verify')
  @HttpCode(200)
  verify(
    @Param('caseId', ParseUUIDPipe) caseId: string,
    @Body() dto: VerifyDeathCaseDto,
    @Req() req: Request,
  ) {
    return this.cases.verify(caseId, adminActor(req), dto);
  }

  @Post(':caseId/reject')
  @HttpCode(200)
  reject(
    @Param('caseId', ParseUUIDPipe) caseId: string,
    @Body() dto: RejectDeathCaseDto,
    @Req() req: Request,
  ) {
    return this.cases.reject(caseId, adminActor(req), dto);
  }
}
