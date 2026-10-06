import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { CustomerGuard } from '../auth/guards/customer.guard.js';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard.js';
import type { SafeUser } from '../users/users.service.js';
import { CreateMediaUploadDto } from './dto/create-media-upload.dto.js';
import {
  type AccessUrlResponse,
  type MediaResponse,
  MediaService,
  type UploadUrlResponse,
} from './media.service.js';
import { AUTH } from '../config/swagger.js';

// Owner-only. File bytes never pass through here: clients PUT/GET the bucket
// directly with the short-lived signed URLs returned below.
@ApiTags('Media')
@ApiCookieAuth(AUTH.customer)
@Controller('messages/:messageId/media')
@UseGuards(SessionAuthGuard, CustomerGuard)
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @Post('upload-url')
  createUploadUrl(
    @CurrentUser() user: SafeUser,
    @Param('messageId', ParseUUIDPipe) messageId: string,
    @Body() dto: CreateMediaUploadDto,
  ): Promise<UploadUrlResponse> {
    return this.media.createUploadUrl(user.id, messageId, dto);
  }

  @Post(':mediaAssetId/complete')
  @HttpCode(200)
  complete(
    @CurrentUser() user: SafeUser,
    @Param('messageId', ParseUUIDPipe) messageId: string,
    @Param('mediaAssetId', ParseUUIDPipe) id: string,
  ): Promise<MediaResponse> {
    return this.media.complete(user.id, messageId, id);
  }

  @Get()
  findAll(
    @CurrentUser() user: SafeUser,
    @Param('messageId', ParseUUIDPipe) messageId: string,
  ): Promise<MediaResponse[]> {
    return this.media.findAllForMessage(user.id, messageId);
  }

  @Get(':mediaAssetId/access-url')
  createAccessUrl(
    @CurrentUser() user: SafeUser,
    @Param('messageId', ParseUUIDPipe) messageId: string,
    @Param('mediaAssetId', ParseUUIDPipe) id: string,
  ): Promise<AccessUrlResponse> {
    return this.media.createAccessUrl(user.id, messageId, id);
  }

  @Delete(':mediaAssetId')
  @HttpCode(204)
  remove(
    @CurrentUser() user: SafeUser,
    @Param('messageId', ParseUUIDPipe) messageId: string,
    @Param('mediaAssetId', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.media.remove(user.id, messageId, id);
  }
}
