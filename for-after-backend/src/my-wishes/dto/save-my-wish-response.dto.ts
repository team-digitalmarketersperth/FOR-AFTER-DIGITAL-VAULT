import { IsIn, IsOptional, ValidateIf } from 'class-validator';
import { PrivateNote } from '../../messages/dto/create-message.dto.js';
import { AnswerText } from '../../my-story/dto/save-my-story-response.dto.js';
import {
  MY_WISHES_CATEGORIES,
  type MyWishesCategory,
} from '../my-wishes.prompts.js';

// Only textContent and privateNote are accepted; the global ValidationPipe rejects anything
// else (ownerUserId, promptKey, promptVersion, promptTextSnapshot, ...).
// Same text rule as My Story: not blank, max 20,000, stored as written.
// Phase 15B: optional. Omitted = unchanged, null = cleared (a wish may be
// photos or recordings only; the service refuses an empty one).
export class SaveMyWishResponseDto {
  @ValidateIf((_, v) => v !== undefined && v !== null)
  @AnswerText()
  textContent?: string | null;

  // Owner-only; never shared. Omitted = unchanged, null/blank = cleared.
  @PrivateNote()
  privateNote?: string | null;
}

// GET /my-wishes/prompts?category=CEREMONY
export class MyWishesPromptsQueryDto {
  @IsOptional()
  @IsIn(MY_WISHES_CATEGORIES, {
    message: `category must be one of: ${MY_WISHES_CATEGORIES.join(', ')}`,
  })
  category?: MyWishesCategory;
}
