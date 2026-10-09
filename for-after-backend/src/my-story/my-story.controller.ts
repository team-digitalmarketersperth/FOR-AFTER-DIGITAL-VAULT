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
import { MyStoryMediaService } from './my-story-media.service.js';
import { StoryToMessageService } from './story-to-message.service.js';
import {
  MyStoryPromptsQueryDto,
  SaveMyStoryResponseDto,
} from './dto/save-my-story-response.dto.js';
import {
  getPromptByKey,
  type MyStoryPrompt,
  PROMPT_KEY_PATTERN,
  PROMPT_NOT_FOUND,
} from './my-story.prompts.js';
import {
  MyStoryService,
  type PromptWithResponse,
  type StoryResponse,
} from './my-story.service.js';
import { AUTH } from '../config/swagger.js';

export { PROMPT_NOT_FOUND };

// Resolves :promptKey to the trusted catalogue entry: malformed → 400,
// unknown → 404. Nothing about the prompt is ever taken from the client.
@Injectable()
export class PromptKeyPipe implements PipeTransform<string, MyStoryPrompt> {
  transform(key: string): MyStoryPrompt {
    if (key.length > 100 || !PROMPT_KEY_PATTERN.test(key)) {
      throw new BadRequestException('promptKey is not valid');
    }
    const prompt = getPromptByKey(key);
    if (!prompt) throw new NotFoundException(PROMPT_NOT_FOUND);
    return prompt;
  }
}

// The owner is always the session user; ownership is enforced in the service.
@ApiTags('My Story')
@ApiCookieAuth(AUTH.customer)
@Controller('my-story/prompts')
@UseGuards(SessionAuthGuard, CustomerGuard)
export class MyStoryController {
  constructor(
    private readonly story: MyStoryService,
    private readonly media: MyStoryMediaService,
    private readonly toMessage: StoryToMessageService,
  ) {}

  @Get()
  findAll(
    @CurrentUser() user: SafeUser,
    @Query() query: MyStoryPromptsQueryDto,
  ): Promise<PromptWithResponse[]> {
    return this.story.listPrompts(user.id, query.category);
  }

  @Get(':promptKey')
  findOne(
    @CurrentUser() user: SafeUser,
    @Param('promptKey', PromptKeyPipe) prompt: MyStoryPrompt,
  ): Promise<PromptWithResponse> {
    return this.story.getPrompt(user.id, prompt);
  }

  @Get(':promptKey/response')
  findResponse(
    @CurrentUser() user: SafeUser,
    @Param('promptKey', PromptKeyPipe) prompt: MyStoryPrompt,
  ): Promise<StoryResponse> {
    return this.story.getResponse(user.id, prompt);
  }

  // Idempotent: always 200, whether the answer was created, updated or restored.
  @Put(':promptKey/response')
  save(
    @CurrentUser() user: SafeUser,
    @Param('promptKey', PromptKeyPipe) prompt: MyStoryPrompt,
    @Body() dto: SaveMyStoryResponseDto,
  ): Promise<StoryResponse> {
    return this.story.save(user.id, prompt, dto);
  }

  // Also removes the answer's files and memory links (Phase 14B).
  @Delete(':promptKey/response')
  @HttpCode(204)
  remove(
    @CurrentUser() user: SafeUser,
    @Param('promptKey', PromptKeyPipe) prompt: MyStoryPrompt,
  ): Promise<void> {
    return this.story.remove(user.id, prompt);
  }

  // Phase 14B: a new, independent DRAFT Message from chosen parts of the
  // answer (201). The answer stays private; linked memories are never copied.
  @Post(':promptKey/response/messages')
  createMessage(
    @CurrentUser() user: SafeUser,
    @Param('promptKey', PromptKeyPipe) prompt: MyStoryPrompt,
    @Body() dto: CreateMessageFromContentDto,
  ): Promise<MessageResponse> {
    return this.toMessage.createMessage(user.id, prompt, dto);
  }

  // Phase 14B media: same flow as message and Memory Vault media. Upload
  // auth creates the answer's private empty shell if it has none yet.
  @Post(':promptKey/response/media/upload-url')
  createUploadUrl(
    @CurrentUser() user: SafeUser,
    @Param('promptKey', PromptKeyPipe) prompt: MyStoryPrompt,
    @Body() dto: CreateMediaUploadDto,
  ): Promise<UploadUrlResponse> {
    return this.media.createUploadUrl(user.id, prompt, dto);
  }

  @Post(':promptKey/response/media/:mediaAssetId/complete')
  @HttpCode(200)
  completeMedia(
    @CurrentUser() user: SafeUser,
    @Param('promptKey', PromptKeyPipe) prompt: MyStoryPrompt,
    @Param('mediaAssetId', ParseUUIDPipe) id: string,
    @Body() dto: CompleteMediaUploadDto,
  ): Promise<MediaResponse> {
    return this.media.complete(user.id, prompt, id, dto.providerFileId);
  }

  @Get(':promptKey/response/media')
  findAllMedia(
    @CurrentUser() user: SafeUser,
    @Param('promptKey', PromptKeyPipe) prompt: MyStoryPrompt,
  ): Promise<MediaResponse[]> {
    return this.media.findAll(user.id, prompt);
  }

  @Get(':promptKey/response/media/:mediaAssetId/access-url')
  createAccessUrl(
    @CurrentUser() user: SafeUser,
    @Param('promptKey', PromptKeyPipe) prompt: MyStoryPrompt,
    @Param('mediaAssetId', ParseUUIDPipe) id: string,
  ): Promise<AccessUrlResponse> {
    return this.media.createAccessUrl(user.id, prompt, id);
  }

  @Delete(':promptKey/response/media/:mediaAssetId')
  @HttpCode(204)
  removeMedia(
    @CurrentUser() user: SafeUser,
    @Param('promptKey', PromptKeyPipe) prompt: MyStoryPrompt,
    @Param('mediaAssetId', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.media.remove(user.id, prompt, id);
  }
}
