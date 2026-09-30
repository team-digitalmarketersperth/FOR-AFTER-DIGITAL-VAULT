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
  PipeTransform,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { CustomerGuard } from '../auth/guards/customer.guard.js';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard.js';
import type { SafeUser } from '../users/users.service.js';
import {
  MyStoryPromptsQueryDto,
  SaveMyStoryResponseDto,
} from './dto/save-my-story-response.dto.js';
import {
  getPromptByKey,
  type MyStoryPrompt,
  PROMPT_KEY_PATTERN,
} from './my-story.prompts.js';
import {
  MyStoryService,
  type PromptWithResponse,
  type StoryResponse,
} from './my-story.service.js';

export const PROMPT_NOT_FOUND = 'Prompt not found.';

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
@Controller('my-story/prompts')
@UseGuards(SessionAuthGuard, CustomerGuard)
export class MyStoryController {
  constructor(private readonly story: MyStoryService) {}

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
    return this.story.save(user.id, prompt, dto.textContent);
  }

  @Delete(':promptKey/response')
  @HttpCode(204)
  remove(
    @CurrentUser() user: SafeUser,
    @Param('promptKey', PromptKeyPipe) prompt: MyStoryPrompt,
  ): Promise<void> {
    return this.story.remove(user.id, prompt);
  }
}
