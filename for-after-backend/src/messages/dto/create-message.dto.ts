import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { trim } from '../../auth/dto/register.dto.js';
import { MessageContentType } from '../../generated/prisma/client.js';

// Product-configurable limits.
export const TEXT_CONTENT_MAX = 20_000;
export const RECIPIENTS_MAX = 100;

// May be omitted, but never null (null must fail like a missing value).
export const IfDefined = () => ValidateIf((_, value) => value !== undefined);

export const Title = () =>
  applyDecorators(Transform(trim), IsString(), IsNotEmpty(), MaxLength(200));

// Plain text, never trusted markup. Only outer whitespace is trimmed, and
// blank becomes null (no text). Optional: drafts may be incomplete, and
// scheduling decides whether text is required. Missing = unchanged on PATCH,
// null = clear.
export const trimToNull = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() || null : value;
export const TextContent = () =>
  applyDecorators(
    IsOptional(),
    Transform(trimToNull),
    IsString(),
    MaxLength(TEXT_CONTENT_MAX),
  );

// VIDEO since Phase 12 (ImageKit video pipeline); see message-composition.ts.
export const SUPPORTED_CONTENT_TYPES = [
  MessageContentType.TEXT,
  MessageContentType.PHOTO,
  MessageContentType.AUDIO,
  MessageContentType.VIDEO,
  MessageContentType.MIXED,
] as const;
export type SupportedContentType = (typeof SUPPORTED_CONTENT_TYPES)[number];
export const ContentType = () =>
  applyDecorators(
    IfDefined(),
    IsIn(SUPPORTED_CONTENT_TYPES, {
      message: 'contentType must be TEXT, PHOTO, AUDIO, VIDEO or MIXED',
    }),
  );

// UUIDs compare case-insensitively in PostgreSQL, so duplicates do too.
export const RecipientIds = () =>
  applyDecorators(
    IsArray(),
    ArrayMinSize(1),
    ArrayMaxSize(RECIPIENTS_MAX),
    IsUUID('all', { each: true }),
    ArrayUnique((id: unknown) => String(id).toLowerCase(), {
      message: 'recipientIds must not contain duplicates',
    }),
  );

// Only these fields are accepted; the global ValidationPipe rejects anything
// else (ownerUserId, status, ...). Status is always DRAFT on create. A draft
// may be incomplete (e.g. PHOTO before its upload); see checkComposition.
export class CreateMessageDto {
  @Title()
  title: string;

  // Defaults to TEXT.
  @ContentType()
  contentType?: SupportedContentType;

  @TextContent()
  textContent?: string | null;

  @RecipientIds()
  recipientIds: string[];
}
