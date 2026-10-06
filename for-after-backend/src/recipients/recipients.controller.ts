import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { PageQueryDto } from '../admin/dto/admin.dto.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { CustomerGuard } from '../auth/guards/customer.guard.js';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard.js';
import type { SafeUser } from '../users/users.service.js';
import { CreateRecipientDto } from './dto/create-recipient.dto.js';
import { CreateMediaUploadDto } from '../media/dto/create-media-upload.dto.js';
import type {
  AccessUrlResponse,
  MediaResponse,
  UploadUrlResponse,
} from '../media/media.service.js';
import { UpdateRecipientDto } from './dto/update-recipient.dto.js';
import { RecipientPhotoService } from './recipient-photo.service.js';
import {
  type RecipientPage,
  type RecipientResponse,
  RecipientsService,
} from './recipients.service.js';
import { AUTH } from '../config/swagger.js';

// The owner is always the session user; ownership is enforced in the service.
@ApiTags('People I Love (Recipients)')
@ApiCookieAuth(AUTH.customer)
@Controller('recipients')
@UseGuards(SessionAuthGuard, CustomerGuard)
export class RecipientsController {
  constructor(
    private readonly recipients: RecipientsService,
    private readonly photos: RecipientPhotoService,
  ) {}

  @Post()
  create(
    @CurrentUser() user: SafeUser,
    @Body() dto: CreateRecipientDto,
  ): Promise<RecipientResponse> {
    return this.recipients.create(user.id, dto);
  }

  // Phase 09: ?page=1&limit=25 (max 100), the admin lists' convention.
  @Get()
  findAll(
    @CurrentUser() user: SafeUser,
    @Query() query: PageQueryDto,
  ): Promise<RecipientPage> {
    return this.recipients.findAllForOwner(user.id, query.page, query.limit);
  }

  @Get(':id')
  findOne(
    @CurrentUser() user: SafeUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<RecipientResponse> {
    return this.recipients.findOwnedById(user.id, id);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: SafeUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateRecipientDto,
  ): Promise<RecipientResponse> {
    return this.recipients.update(user.id, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @CurrentUser() user: SafeUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.recipients.remove(user.id, id);
    await this.photos.removeAllForRecipient(user.id, id);
  }

  // ─── Phase 09: the Recipient's private photo (same lifecycle as media) ───

  @Post(':id/photo/upload-url')
  createPhotoUpload(
    @CurrentUser() user: SafeUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateMediaUploadDto,
  ): Promise<UploadUrlResponse> {
    return this.photos.createUploadUrl(user.id, id, dto);
  }

  @Post(':id/photo/:photoId/complete')
  @HttpCode(200)
  completePhoto(
    @CurrentUser() user: SafeUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('photoId', ParseUUIDPipe) photoId: string,
  ): Promise<MediaResponse> {
    return this.photos.complete(user.id, id, photoId);
  }

  @Get(':id/photo/:photoId/access-url')
  photoAccessUrl(
    @CurrentUser() user: SafeUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('photoId', ParseUUIDPipe) photoId: string,
  ): Promise<AccessUrlResponse> {
    return this.photos.createAccessUrl(user.id, id, photoId);
  }

  @Delete(':id/photo/:photoId')
  @HttpCode(204)
  removePhoto(
    @CurrentUser() user: SafeUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('photoId', ParseUUIDPipe) photoId: string,
  ): Promise<void> {
    return this.photos.remove(user.id, id, photoId);
  }
}
