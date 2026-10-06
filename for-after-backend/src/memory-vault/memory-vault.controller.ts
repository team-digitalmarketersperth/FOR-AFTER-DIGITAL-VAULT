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
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { CustomerGuard } from '../auth/guards/customer.guard.js';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard.js';
import { CreateMediaUploadDto } from '../media/dto/create-media-upload.dto.js';
import type {
  AccessUrlResponse,
  MediaResponse,
  UploadUrlResponse,
} from '../media/media.service.js';
import type { SafeUser } from '../users/users.service.js';
import {
  CreateMemoryVaultItemDto,
  MemoryVaultQueryDto,
} from './dto/create-memory-vault-item.dto.js';
import { UpdateMemoryVaultItemDto } from './dto/update-memory-vault-item.dto.js';
import { MemoryVaultMediaService } from './memory-vault-media.service.js';
import {
  type MemoryResponse,
  MemoryVaultService,
} from './memory-vault.service.js';
import { AUTH } from '../config/swagger.js';

// The owner is always the session user; ownership is enforced in the services.
// Media bytes never pass through here (signed URLs, as for message media).
@ApiTags('Memory Vault')
@ApiCookieAuth(AUTH.customer)
@Controller('memory-vault')
@UseGuards(SessionAuthGuard, CustomerGuard)
export class MemoryVaultController {
  constructor(
    private readonly memories: MemoryVaultService,
    private readonly media: MemoryVaultMediaService,
  ) {}

  @Post()
  create(
    @CurrentUser() user: SafeUser,
    @Body() dto: CreateMemoryVaultItemDto,
  ): Promise<MemoryResponse> {
    return this.memories.create(user.id, dto);
  }

  @Get()
  findAll(
    @CurrentUser() user: SafeUser,
    @Query() query: MemoryVaultQueryDto,
  ): Promise<MemoryResponse[]> {
    return this.memories.findAllForOwner(user.id, query.category);
  }

  @Get(':memoryVaultItemId')
  findOne(
    @CurrentUser() user: SafeUser,
    @Param('memoryVaultItemId', ParseUUIDPipe) id: string,
  ): Promise<MemoryResponse> {
    return this.memories.findOwnedById(user.id, id);
  }

  @Patch(':memoryVaultItemId')
  update(
    @CurrentUser() user: SafeUser,
    @Param('memoryVaultItemId', ParseUUIDPipe) id: string,
    @Body() dto: UpdateMemoryVaultItemDto,
  ): Promise<MemoryResponse> {
    return this.memories.update(user.id, id, dto);
  }

  @Delete(':memoryVaultItemId')
  @HttpCode(204)
  remove(
    @CurrentUser() user: SafeUser,
    @Param('memoryVaultItemId', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.memories.remove(user.id, id);
  }

  @Post(':memoryVaultItemId/media/upload-url')
  createUploadUrl(
    @CurrentUser() user: SafeUser,
    @Param('memoryVaultItemId', ParseUUIDPipe) itemId: string,
    @Body() dto: CreateMediaUploadDto,
  ): Promise<UploadUrlResponse> {
    return this.media.createUploadUrl(user.id, itemId, dto);
  }

  @Post(':memoryVaultItemId/media/:mediaAssetId/complete')
  @HttpCode(200)
  completeMedia(
    @CurrentUser() user: SafeUser,
    @Param('memoryVaultItemId', ParseUUIDPipe) itemId: string,
    @Param('mediaAssetId', ParseUUIDPipe) id: string,
  ): Promise<MediaResponse> {
    return this.media.complete(user.id, itemId, id);
  }

  @Get(':memoryVaultItemId/media')
  findAllMedia(
    @CurrentUser() user: SafeUser,
    @Param('memoryVaultItemId', ParseUUIDPipe) itemId: string,
  ): Promise<MediaResponse[]> {
    return this.media.findAllForItem(user.id, itemId);
  }

  @Get(':memoryVaultItemId/media/:mediaAssetId/access-url')
  createAccessUrl(
    @CurrentUser() user: SafeUser,
    @Param('memoryVaultItemId', ParseUUIDPipe) itemId: string,
    @Param('mediaAssetId', ParseUUIDPipe) id: string,
  ): Promise<AccessUrlResponse> {
    return this.media.createAccessUrl(user.id, itemId, id);
  }

  @Delete(':memoryVaultItemId/media/:mediaAssetId')
  @HttpCode(204)
  removeMedia(
    @CurrentUser() user: SafeUser,
    @Param('memoryVaultItemId', ParseUUIDPipe) itemId: string,
    @Param('mediaAssetId', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.media.remove(user.id, itemId, id);
  }
}
