import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import {
  DeathVerificationEvidenceService,
  type ReporterEvidence,
} from '../death-verification/death-verification-evidence.service.js';
import {
  DeathVerificationService,
  type DeathReportReceipt,
  type DeathVerificationStatus,
} from '../death-verification/death-verification.service.js';
import { CreateDeathReportDto } from '../death-verification/dto/create-death-report.dto.js';
import { CreateEvidenceUploadDto } from '../death-verification/dto/create-evidence-upload.dto.js';
import { CompleteMediaUploadDto } from '../media/dto/create-media-upload.dto.js';
import type {
  AccessUrlResponse,
  UploadUrlResponse,
} from '../media/media.service.js';
import type { TrustedContactPrincipal } from '../trusted-contact-auth/trusted-contact-auth.service.js';
import {
  CurrentTrustedContact,
  TrustedContactSessionAuthGuard,
} from '../trusted-contact-auth/trusted-contact-session.guard.js';
import {
  type TrustedAccount,
  TrustedContactPortalService,
} from './trusted-contact-portal.service.js';
import { AUTH } from '../config/swagger.js';

// Trusted Contact session only; Customer and Recipient sessions get 401.
// No route here reads Messages, media, Memory Vault, My Story or My Wishes;
// the only files are the contact's own death-verification evidence.
@ApiTags('Trusted Contact portal')
@ApiCookieAuth(AUTH.trustedContact)
@Controller('trusted-contact/accounts')
@UseGuards(TrustedContactSessionAuthGuard)
export class TrustedContactPortalController {
  constructor(
    private readonly portal: TrustedContactPortalService,
    private readonly deaths: DeathVerificationService,
    private readonly evidence: DeathVerificationEvidenceService,
  ) {}

  @Get()
  findAll(
    @CurrentTrustedContact() contact: TrustedContactPrincipal,
  ): Promise<TrustedAccount[]> {
    return this.portal.findAccounts(contact);
  }

  @Post(':trustedContactId/death-reports')
  async report(
    @CurrentTrustedContact() contact: TrustedContactPrincipal,
    @Param('trustedContactId', ParseUUIDPipe) id: string,
    @Body() dto: CreateDeathReportDto,
  ): Promise<DeathReportReceipt> {
    const reporter = await this.portal.findRelationship(
      contact,
      id,
    );
    return this.deaths.submitReport(reporter, dto);
  }

  @Get(':trustedContactId/death-verification')
  async status(
    @CurrentTrustedContact() contact: TrustedContactPrincipal,
    @Param('trustedContactId', ParseUUIDPipe) id: string,
  ): Promise<DeathVerificationStatus> {
    const reporter = await this.portal.findRelationship(
      contact,
      id,
    );
    return this.deaths.getStatus(reporter);
  }

  // ─── Phase 19A: the reporter's own supporting evidence ─────────────────
  // Case, report and account come from the session + route relationship,
  // never the body. Uploading evidence never verifies or releases anything.

  @Post(':trustedContactId/death-verification/evidence/upload-url')
  async evidenceUploadUrl(
    @CurrentTrustedContact() contact: TrustedContactPrincipal,
    @Param('trustedContactId', ParseUUIDPipe) id: string,
    @Body() dto: CreateEvidenceUploadDto,
  ): Promise<UploadUrlResponse> {
    const reporter = await this.portal.findRelationship(
      contact,
      id,
    );
    return this.evidence.createUploadUrl(reporter, dto);
  }

  @Post(':trustedContactId/death-verification/evidence/:evidenceId/complete')
  @HttpCode(200)
  async evidenceComplete(
    @CurrentTrustedContact() contact: TrustedContactPrincipal,
    @Param('trustedContactId', ParseUUIDPipe) id: string,
    @Param('evidenceId', ParseUUIDPipe) evidenceId: string,
    @Body() dto: CompleteMediaUploadDto,
  ): Promise<ReporterEvidence> {
    const reporter = await this.portal.findRelationship(
      contact,
      id,
    );
    return this.evidence.complete(reporter, evidenceId, dto.providerFileId);
  }

  @Get(':trustedContactId/death-verification/evidence')
  async evidenceList(
    @CurrentTrustedContact() contact: TrustedContactPrincipal,
    @Param('trustedContactId', ParseUUIDPipe) id: string,
  ): Promise<ReporterEvidence[]> {
    const reporter = await this.portal.findRelationship(
      contact,
      id,
    );
    return this.evidence.listForReporter(reporter);
  }

  @Get(':trustedContactId/death-verification/evidence/:evidenceId/access-url')
  async evidenceAccessUrl(
    @CurrentTrustedContact() contact: TrustedContactPrincipal,
    @Param('trustedContactId', ParseUUIDPipe) id: string,
    @Param('evidenceId', ParseUUIDPipe) evidenceId: string,
  ): Promise<AccessUrlResponse> {
    const reporter = await this.portal.findRelationship(
      contact,
      id,
    );
    return this.evidence.reporterAccessUrl(reporter, evidenceId);
  }
}
