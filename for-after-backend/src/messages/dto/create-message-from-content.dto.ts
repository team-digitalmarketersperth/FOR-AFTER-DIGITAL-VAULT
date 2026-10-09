import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsUUID,
} from 'class-validator';
import {
  RecipientIds,
  SUPPORTED_CONTENT_TYPES,
  type SupportedContentType,
  Title,
} from './create-message.dto.js';

// Implementation safeguard (no product decision): files copied per request.
export const COPY_MEDIA_MAX = 20;

/**
 * A new DRAFT Message made from what the Customer picked out of private
 * content: POST /memory-vault/:id/messages (Phase 13B),
 * POST /my-story/prompts/:promptKey/response/messages (Phase 14B) and
 * POST /my-wishes/prompts/:promptKey/response/messages (Phase 15B).
 * contentType is always explicit (never inferred from the source); recipients
 * follow the normal Message rules.
 */
export class CreateMessageFromContentDto {
  @Title()
  title: string;

  @IsIn(SUPPORTED_CONTENT_TYPES, {
    message: 'contentType must be TEXT, PHOTO, AUDIO, VIDEO or MIXED',
  })
  contentType: SupportedContentType;

  // Copy the source's text (if it has any) into the message.
  @IsBoolean()
  includeText: boolean;

  // The source's own READY files to copy ([] = none).
  @IsArray()
  @ArrayMaxSize(COPY_MEDIA_MAX)
  @IsUUID('all', { each: true })
  @ArrayUnique((id: unknown) => String(id).toLowerCase(), {
    message: 'mediaAssetIds must not contain duplicates',
  })
  mediaAssetIds: string[];

  @RecipientIds()
  recipientIds: string[];
}
