import { Body, Controller, HttpCode, Module, Post, Res, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import type { Response } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { CustomerGuard } from '../auth/guards/customer.guard.js';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard.js';
import { AUTH } from '../config/swagger.js';
import { PROMPT_KEY_PATTERN } from '../my-story/my-story.prompts.js';
import { UsersModule } from '../users/users.module.js';
import type { SafeUser } from '../users/users.service.js';
import {
  ASSISTANT_ACTIONS,
  ASSISTANT_PAGES,
  type AssistantAction,
  type AssistantPage,
  AssistantService,
  LIMITS,
} from './assistant.service.js';

class HistoryTurnDto {
  // Only the conversation's own turns: a client can never add system/developer instructions.
  @IsIn(['user', 'assistant'])
  role: 'user' | 'assistant';

  @IsString()
  @MaxLength(LIMITS.turn)
  content: string;
}

class AssistantReplyDto {
  @IsIn(ASSISTANT_PAGES)
  page: AssistantPage;

  @IsIn(ASSISTANT_ACTIONS)
  action: AssistantAction;

  @IsOptional()
  @IsString()
  @MaxLength(LIMITS.message)
  message?: string;

  /** Text the Customer explicitly chose to include (e.g. their answer box). */
  @IsOptional()
  @IsString()
  @MaxLength(LIMITS.source)
  source?: string;

  /** My Story only: the question is looked up in the catalogue, never taken from the client. */
  @IsOptional()
  @Matches(PROMPT_KEY_PATTERN)
  @MaxLength(100)
  promptKey?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(LIMITS.history)
  @ValidateNested({ each: true })
  @Type(() => HistoryTurnDto)
  history?: HistoryTurnDto[];
}

/**
 * The For After companion's AI replies (Groq). Customer session only; the
 * reply is a suggestion: nothing is saved, sent or changed here.
 */
@ApiTags('Assistant')
@ApiCookieAuth(AUTH.customer)
@Controller('assistant')
@UseGuards(SessionAuthGuard, CustomerGuard)
export class AssistantController {
  constructor(private readonly assistant: AssistantService) {}

  @Post('reply')
  @HttpCode(200)
  reply(
    @CurrentUser() user: SafeUser,
    @Body() dto: AssistantReplyDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    // The browser gave up (closed the panel, left the page): stop the provider call too.
    const gone = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) gone.abort();
    });
    return this.assistant.reply(user.id, dto, gone.signal);
  }
}

// UsersModule backs SessionAuthGuard; Redis is global.
@Module({
  imports: [UsersModule],
  controllers: [AssistantController],
  providers: [AssistantService],
})
export class AssistantModule {}
