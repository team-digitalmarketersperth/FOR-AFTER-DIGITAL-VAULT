import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  DeathVerificationService,
  type DeathReportReceipt,
  type DeathVerificationStatus,
} from '../death-verification/death-verification.service.js';
import { CreateDeathReportDto } from '../death-verification/dto/create-death-report.dto.js';
import type { TrustedContactPrincipal } from '../trusted-contact-auth/trusted-contact-auth.service.js';
import {
  CurrentTrustedContact,
  TrustedContactSessionAuthGuard,
} from '../trusted-contact-auth/trusted-contact-session.guard.js';
import {
  type TrustedAccount,
  TrustedContactPortalService,
} from './trusted-contact-portal.service.js';

// Trusted Contact session only; Customer and Recipient sessions get 401.
// No route here reads Messages, media, Memory Vault, My Story or My Wishes.
@Controller('trusted-contact/accounts')
@UseGuards(TrustedContactSessionAuthGuard)
export class TrustedContactPortalController {
  constructor(
    private readonly portal: TrustedContactPortalService,
    private readonly deaths: DeathVerificationService,
  ) {}

  @Get()
  findAll(
    @CurrentTrustedContact() contact: TrustedContactPrincipal,
  ): Promise<TrustedAccount[]> {
    return this.portal.findAccounts(contact.emailNormalized);
  }

  @Post(':trustedContactId/death-reports')
  async report(
    @CurrentTrustedContact() contact: TrustedContactPrincipal,
    @Param('trustedContactId', ParseUUIDPipe) id: string,
    @Body() dto: CreateDeathReportDto,
  ): Promise<DeathReportReceipt> {
    const reporter = await this.portal.findRelationship(
      contact.emailNormalized,
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
      contact.emailNormalized,
      id,
    );
    return this.deaths.getStatus(reporter);
  }
}
