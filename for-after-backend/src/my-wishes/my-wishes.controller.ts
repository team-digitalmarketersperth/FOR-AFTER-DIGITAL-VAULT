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
import { PROMPT_KEY_PATTERN } from '../my-story/my-story.prompts.js';
import type { SafeUser } from '../users/users.service.js';
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
@Controller('my-wishes/prompts')
@UseGuards(SessionAuthGuard, CustomerGuard)
export class MyWishesController {
  constructor(private readonly wishes: MyWishesService) {}

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
    return this.wishes.save(user.id, prompt, dto.textContent);
  }

  @Delete(':promptKey/response')
  @HttpCode(204)
  remove(
    @CurrentUser() user: SafeUser,
    @Param('promptKey', WishPromptKeyPipe) prompt: MyWishPrompt,
  ): Promise<void> {
    return this.wishes.remove(user.id, prompt);
  }
}
