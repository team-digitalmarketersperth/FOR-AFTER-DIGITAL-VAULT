import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import type { AccessUrlResponse } from '../media/media.service.js';
import type { RecipientPrincipal } from '../recipient-auth/recipient-auth.service.js';
import {
  CurrentRecipient,
  RecipientSessionAuthGuard,
} from '../recipient-auth/recipient-session.guard.js';
import {
  type RecipientMediaResponse,
  type RecipientMessageDetail,
  type RecipientMessageSummary,
  RecipientMessagesService,
} from './recipient-messages.service.js';
import { AUTH } from '../config/swagger.js';

// Read-only by design: no create, update, delete, upload or schedule routes.
// Recipient session only; a Customer session is never accepted here.
@ApiTags('Recipient portal')
@ApiCookieAuth(AUTH.recipient)
@Controller('recipient/messages')
@UseGuards(RecipientSessionAuthGuard)
export class RecipientMessagesController {
  constructor(private readonly messages: RecipientMessagesService) {}

  @Get()
  findAll(
    @CurrentRecipient() recipient: RecipientPrincipal,
  ): Promise<RecipientMessageSummary[]> {
    return this.messages.findAll(recipient.emailNormalized);
  }

  @Get(':messageId')
  findOne(
    @CurrentRecipient() recipient: RecipientPrincipal,
    @Param('messageId', ParseUUIDPipe) messageId: string,
  ): Promise<RecipientMessageDetail> {
    return this.messages.findOne(recipient.emailNormalized, messageId);
  }

  @Get(':messageId/media')
  findMedia(
    @CurrentRecipient() recipient: RecipientPrincipal,
    @Param('messageId', ParseUUIDPipe) messageId: string,
  ): Promise<RecipientMediaResponse[]> {
    return this.messages.findMedia(recipient.emailNormalized, messageId);
  }

  @Get(':messageId/media/:mediaAssetId/access-url')
  createAccessUrl(
    @CurrentRecipient() recipient: RecipientPrincipal,
    @Param('messageId', ParseUUIDPipe) messageId: string,
    @Param('mediaAssetId', ParseUUIDPipe) id: string,
  ): Promise<AccessUrlResponse> {
    return this.messages.createMediaAccessUrl(
      recipient.emailNormalized,
      messageId,
      id,
    );
  }
}
