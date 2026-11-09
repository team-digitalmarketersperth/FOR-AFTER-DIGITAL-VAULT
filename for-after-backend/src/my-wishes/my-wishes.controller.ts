import { RequiresPlan } from '../billing/billing-access.js';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Injectable,
  NotFoundException,
  Param,
  Patch,
  ParseUUIDPipe,
  PipeTransform,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { CustomerGuard } from '../auth/guards/customer.guard.js';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard.js';
import { PROMPT_KEY_PATTERN } from '../my-story/my-story.prompts.js';
import type { SafeUser } from '../users/users.service.js';
import {
  CompleteMediaUploadDto,
  CreateMediaUploadDto,
} from '../media/dto/create-media-upload.dto.js';
import type {
  AccessUrlResponse,
  MediaResponse,
  UploadUrlResponse,
} from '../media/media.service.js';
import { CreateMessageFromContentDto } from '../messages/dto/create-message-from-content.dto.js';
import type { MessageResponse } from '../messages/messages.service.js';
import { MyWishesMediaService } from './my-wishes-media.service.js';
import { WishToMessageService } from './wish-to-message.service.js';
import {
  MyWishesPromptsQueryDto,
  SaveMyWishResponseDto,
} from './dto/save-my-wish-response.dto.js';
import { getWishPromptByKey, type MyWishPrompt } from './my-wishes.prompts.js';
import {
  MyWishesService,
  type WishPromptWithResponse,
  type WishResponse,
} from './my-wishes.service.js';
import { AUTH } from '../config/swagger.js';
import { AcknowledgeDisclaimerDto } from './dto/acknowledge-disclaimer.dto.js';
import {
  CreateMyWishSongDto,
  ReorderMyWishSongsDto,
  UpdateMyWishSongDto,
} from './dto/save-my-wish-song.dto.js';
import { MyWishSongsService, type WishSong } from './my-wish-songs.service.js';
import {
  type DisclaimerStatus,
  MyWishesDisclaimerService,
} from './my-wishes-disclaimer.service.js';

// Phase 15A: the authoritative My Wishes notice (informational since
// 2026-10-14). The acknowledgement route is kept for older clients only.
@ApiTags('My Wishes')
@ApiCookieAuth(AUTH.customer)
@Controller('my-wishes/disclaimer')
@UseGuards(SessionAuthGuard, CustomerGuard)
@RequiresPlan()
export class MyWishesDisclaimerController {
  constructor(private readonly disclaimer: MyWishesDisclaimerService) {}

  @Get()
  status(@CurrentUser() user: SafeUser): Promise<DisclaimerStatus> {
    return this.disclaimer.status(user.id);
  }

  // Idempotent: 200 with the (unchanged) status when already acknowledged.
  @Post('acknowledgement')
  @HttpCode(200)
  acknowledge(
    @CurrentUser() user: SafeUser,
    @Body() dto: AcknowledgeDisclaimerDto,
  ): Promise<DisclaimerStatus> {
    return this.disclaimer.acknowledge(user.id, dto.version);
  }
}

export const WISH_PROMPT_NOT_FOUND = 'Prompt not found.';

// Resolves :promptKey to the trusted catalogue entry: malformed → 400
// (same key format as My Story), unknown → 404.
@Injectable()
export class WishPromptKeyPipe implements PipeTransform<string, MyWishPrompt> {
  transform(key: string): MyWishPrompt {
    if (key.length > 100 || !PROMPT_KEY_PATTERN.test(key)) {
      throw new BadRequestException('promptKey is not valid');
    }
    const prompt = getWishPromptByKey(key);
    if (!prompt) throw new NotFoundException(WISH_PROMPT_NOT_FOUND);
    return prompt;
  }
}

// The owner is always the session user; ownership is enforced in the service.
@ApiTags('My Wishes')
@ApiCookieAuth(AUTH.customer)
@Controller('my-wishes/prompts')
@UseGuards(SessionAuthGuard, CustomerGuard)
@RequiresPlan()
export class MyWishesController {
  constructor(
    private readonly wishes: MyWishesService,
    private readonly media: MyWishesMediaService,
    private readonly toMessage: WishToMessageService,
  ) {}

  @Get()
  findAll(
    @CurrentUser() user: SafeUser,
    @Query() query: MyWishesPromptsQueryDto,
  ): Promise<WishPromptWithResponse[]> {
    return this.wishes.listPrompts(user.id, query.category);
  }

  @Get(':promptKey')
  findOne(
    @CurrentUser() user: SafeUser,
    @Param('promptKey', WishPromptKeyPipe) prompt: MyWishPrompt,
  ): Promise<WishPromptWithResponse> {
    return this.wishes.getPrompt(user.id, prompt);
  }

  @Get(':promptKey/response')
  findResponse(
    @CurrentUser() user: SafeUser,
    @Param('promptKey', WishPromptKeyPipe) prompt: MyWishPrompt,
  ): Promise<WishResponse> {
    return this.wishes.getResponse(user.id, prompt);
  }

  // Idempotent: always 200, whether the answer was created, updated or restored.
  @Put(':promptKey/response')
  save(
    @CurrentUser() user: SafeUser,
    @Param('promptKey', WishPromptKeyPipe) prompt: MyWishPrompt,
    @Body() dto: SaveMyWishResponseDto,
  ): Promise<WishResponse> {
    return this.wishes.save(user.id, prompt, dto);
  }

  // Also removes the wish's files (Phase 15B). Messages made from it stay.
  @Delete(':promptKey/response')
  @HttpCode(204)
  remove(
    @CurrentUser() user: SafeUser,
    @Param('promptKey', WishPromptKeyPipe) prompt: MyWishPrompt,
  ): Promise<void> {
    return this.wishes.remove(user.id, prompt);
  }

  // Phase 15B: a new, independent DRAFT Message from chosen parts of the
  // wish (201). The wish stays private; recipients, schedule and release are
  // the normal Message ones.
  @Post(':promptKey/response/messages')
  createMessage(
    @CurrentUser() user: SafeUser,
    @Param('promptKey', WishPromptKeyPipe) prompt: MyWishPrompt,
    @Body() dto: CreateMessageFromContentDto,
  ): Promise<MessageResponse> {
    return this.toMessage.createMessage(user.id, prompt, dto);
  }

  // Phase 15B media: same flow as My Story media. Upload auth creates the
  // wish's private empty shell if it has none yet.
  @Post(':promptKey/response/media/upload-url')
  createUploadUrl(
    @CurrentUser() user: SafeUser,
    @Param('promptKey', WishPromptKeyPipe) prompt: MyWishPrompt,
    @Body() dto: CreateMediaUploadDto,
  ): Promise<UploadUrlResponse> {
    return this.media.createUploadUrl(user.id, prompt, dto);
  }

  @Post(':promptKey/response/media/:mediaAssetId/complete')
  @HttpCode(200)
  completeMedia(
    @CurrentUser() user: SafeUser,
    @Param('promptKey', WishPromptKeyPipe) prompt: MyWishPrompt,
    @Param('mediaAssetId', ParseUUIDPipe) id: string,
    @Body() dto: CompleteMediaUploadDto,
  ): Promise<MediaResponse> {
    return this.media.complete(user.id, prompt, id, dto.providerFileId);
  }

  @Get(':promptKey/response/media')
  findAllMedia(
    @CurrentUser() user: SafeUser,
    @Param('promptKey', WishPromptKeyPipe) prompt: MyWishPrompt,
  ): Promise<MediaResponse[]> {
    return this.media.findAll(user.id, prompt);
  }

  @Get(':promptKey/response/media/:mediaAssetId/access-url')
  createAccessUrl(
    @CurrentUser() user: SafeUser,
    @Param('promptKey', WishPromptKeyPipe) prompt: MyWishPrompt,
    @Param('mediaAssetId', ParseUUIDPipe) id: string,
  ): Promise<AccessUrlResponse> {
    return this.media.createAccessUrl(user.id, prompt, id);
  }

  @Delete(':promptKey/response/media/:mediaAssetId')
  @HttpCode(204)
  removeMedia(
    @CurrentUser() user: SafeUser,
    @Param('promptKey', WishPromptKeyPipe) prompt: MyWishPrompt,
    @Param('mediaAssetId', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.media.remove(user.id, prompt, id);
  }
}

// Funeral songs (My Wishes). Owner-only like every wish: the owner is always
// the session user; a song id that is not theirs is 404.
@ApiTags('My Wishes')
@ApiCookieAuth(AUTH.customer)
@Controller('my-wishes/songs')
@UseGuards(SessionAuthGuard, CustomerGuard)
@RequiresPlan()
export class MyWishSongsController {
  constructor(private readonly songs: MyWishSongsService) {}

  @Get()
  findAll(@CurrentUser() user: SafeUser): Promise<WishSong[]> {
    return this.songs.list(user.id);
  }

  @Post()
  create(
    @CurrentUser() user: SafeUser,
    @Body() dto: CreateMyWishSongDto,
  ): Promise<WishSong> {
    return this.songs.create(user.id, dto);
  }

  // Declared before :id so "order" is never read as an id.
  @Put('order')
  reorder(
    @CurrentUser() user: SafeUser,
    @Body() dto: ReorderMyWishSongsDto,
  ): Promise<WishSong[]> {
    return this.songs.reorder(user.id, dto.songIds);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: SafeUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateMyWishSongDto,
  ): Promise<WishSong> {
    return this.songs.update(user.id, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(
    @CurrentUser() user: SafeUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.songs.remove(user.id, id);
  }
}
