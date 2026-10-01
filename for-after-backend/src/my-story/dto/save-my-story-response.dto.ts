import { applyDecorators } from '@nestjs/common';
import {
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { TEXT_CONTENT_MAX } from '../../messages/dto/create-message.dto.js';
import {
  MY_STORY_CATEGORIES,
  type MyStoryCategory,
} from '../my-story.prompts.js';

// An answer to a guided prompt (My Story, My Wishes). Plain text, never
// trusted markup. Stored exactly as written: it is not trimmed, only required
// to contain something other than whitespace.
export const AnswerText = () =>
  applyDecorators(
    IsString(),
    Matches(/\S/, { message: 'textContent must not be blank' }),
    MaxLength(TEXT_CONTENT_MAX),
  );

// Only textContent is accepted; the global ValidationPipe rejects anything
// else (ownerUserId, promptKey, promptVersion, promptTextSnapshot, ...).
export class SaveMyStoryResponseDto {
  @AnswerText()
  textContent: string;
}

// GET /my-story/prompts?category=CHILDHOOD
export class MyStoryPromptsQueryDto {
  @IsOptional()
  @IsIn(MY_STORY_CATEGORIES, {
    message: `category must be one of: ${MY_STORY_CATEGORIES.join(', ')}`,
  })
  category?: MyStoryCategory;
}
