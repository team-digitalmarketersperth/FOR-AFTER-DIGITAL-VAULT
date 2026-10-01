import { IsIn, IsOptional } from 'class-validator';
import { AnswerText } from '../../my-story/dto/save-my-story-response.dto.js';
import {
  MY_WISHES_CATEGORIES,
  type MyWishesCategory,
} from '../my-wishes.prompts.js';

// Only textContent is accepted; the global ValidationPipe rejects anything
// else (ownerUserId, promptKey, promptVersion, promptTextSnapshot, ...).
// Same text rule as My Story: required, not blank, max 20,000, stored as written.
export class SaveMyWishResponseDto {
  @AnswerText()
  textContent: string;
}

// GET /my-wishes/prompts?category=CEREMONY
export class MyWishesPromptsQueryDto {
  @IsOptional()
  @IsIn(MY_WISHES_CATEGORIES, {
    message: `category must be one of: ${MY_WISHES_CATEGORIES.join(', ')}`,
  })
  category?: MyWishesCategory;
}
