import { applyDecorators } from '@nestjs/common';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import {
  IfDefined,
  TEXT_CONTENT_MAX,
} from '../../messages/dto/create-message.dto.js';
import {
  MY_STORY_ANSWER_MAX,
  MY_STORY_CATEGORIES,
  type MyStoryCategory,
} from '../my-story.prompts.js';

// An answer to a guided prompt (My Story, My Wishes). Plain text, never
// trusted markup. Stored exactly as written: it is not trimmed, only required
// to contain something other than whitespace.
// Limit per section: My Wishes 20,000, My Story 50,000 (Phase 14A).
export const AnswerText = (max = TEXT_CONTENT_MAX) =>
  applyDecorators(
    IsString(),
    Matches(/\S/, { message: 'textContent must not be blank' }),
    MaxLength(max),
  );

// Implementation safeguard (no product decision): links per answer.
export const MEMORY_LINKS_MAX = 100;

// Only these fields are accepted; the global ValidationPipe rejects anything
// else (ownerUserId, promptKey, promptVersion, promptTextSnapshot, ...).
// Phase 14B: both optional. textContent omitted = unchanged, null = cleared
// (an answer may be files or memories only); memoryVaultItemIds present =
// the whole set of linked memories is replaced ([] unlinks all).
export class SaveMyStoryResponseDto {
  @ValidateIf((_, v) => v !== undefined && v !== null)
  @AnswerText(MY_STORY_ANSWER_MAX)
  textContent?: string | null;

  @IfDefined()
  @IsArray()
  @ArrayMaxSize(MEMORY_LINKS_MAX)
  @IsUUID('all', { each: true })
  @ArrayUnique((id: unknown) => String(id).toLowerCase(), {
    message: 'memoryVaultItemIds must not contain duplicates',
  })
  memoryVaultItemIds?: string[];
}

// GET /my-story/prompts?category=CHILDHOOD
export class MyStoryPromptsQueryDto {
  @IsOptional()
  @IsIn(MY_STORY_CATEGORIES, {
    message: `category must be one of: ${MY_STORY_CATEGORIES.join(', ')}`,
  })
  category?: MyStoryCategory;
}
