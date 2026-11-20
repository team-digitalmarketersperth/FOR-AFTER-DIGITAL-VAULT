import { RequiresPlan } from '../billing/billing-access.js';
import { Body, Controller, Get, HttpCode, Module, Post, Res, UseGuards } from '@nestjs/common';
import { AiUsageService, type AiUsageStatusResponse } from './ai-usage.service.js';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
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
import { AssistantMetrics } from './assistant-metrics.js';
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

  /** Updated Plans Step 5: a fresh id per Send; reusing one is refused (409 AI_REQUEST_DUPLICATE), never re-run. */
  @IsOptional()
  @IsUUID()
  requestId?: string;
}

/**
 * The For After companion's AI replies (Groq). Customer session only; the
 * reply is a suggestion: nothing is saved, sent or changed here.
 */
@ApiTags('Assistant')
@ApiCookieAuth(AUTH.customer)
@Controller('assistant')
@UseGuards(SessionAuthGuard, CustomerGuard)
@RequiresPlan()
export class AssistantController {
  constructor(
    private readonly assistant: AssistantService,
    private readonly usage_: AiUsageService,
  ) {}

  /** Updated Plans Step 5: this account's AI allowance (a read: never gated). */
  @Get('usage')
  usage(@CurrentUser() user: SafeUser): Promise<AiUsageStatusResponse> {
    return this.usage_.status(user.id);
  }

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

// UsersModule backs SessionAuthGuard; Redis is global. Exported for the
// admin AI Operations page (settings + aggregates only).
@Module({
  imports: [UsersModule],
  controllers: [AssistantController],
  providers: [AssistantService, AssistantMetrics, AiUsageService],
  exports: [AssistantService, AssistantMetrics],
})
export class AssistantModule {}
