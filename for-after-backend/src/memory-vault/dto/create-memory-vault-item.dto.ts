import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { PageQueryDto } from '../../admin/dto/admin.dto.js';
import { trim } from '../../auth/dto/register.dto.js';
import { MemoryVaultCategory } from '../../generated/prisma/client.js';
import {
  IfDefined,
  TextContent,
  Title,
} from '../../messages/dto/create-message.dto.js';

export const Category = () =>
  IsEnum(MemoryVaultCategory, {
    message: `category must be one of: ${Object.values(MemoryVaultCategory).join(', ')}`,
  });

// Implementation safeguards (no product decision sets these): a tag is a short
// label, and one memory carries a handful, not hundreds.
export const TAG_NAME_MAX = 50;
export const TAGS_MAX = 20;
export const SEARCH_MAX = 200;

/** Display form: trimmed, inner whitespace collapsed. */
export const tagName = (name: string) => name.trim().replace(/\s+/g, ' ');
/** One logical tag per Customer: "Family", " family ", "FAMILY". */
export const normalizeTag = (name: string) => tagName(name).toLowerCase();

const tidyTags = ({ value }: { value: unknown }) =>
  Array.isArray(value)
    ? value.map((v) => (typeof v === 'string' ? tagName(v) : v))
    : value;

// Names, never tag ids: a Customer can only ever reach their own tags.
// Same name twice (after normalizing) counts once.
export const Tags = () =>
  applyDecorators(
    IfDefined(),
    Transform(tidyTags),
    IsArray(),
    ArrayMaxSize(TAGS_MAX),
    IsString({ each: true }),
    IsNotEmpty({ each: true, message: 'tags must not contain blank names' }),
    MaxLength(TAG_NAME_MAX, { each: true }),
  );

// Only these fields are accepted; the global ValidationPipe rejects anything
// else (ownerUserId, recipientIds, status, ...). Title and text follow the
// Message rules; blank text is stored as null.
export class CreateMemoryVaultItemDto {
  @Title()
  title: string;

  @Category()
  category: MemoryVaultCategory;

  @TextContent()
  textContent?: string | null;

  @Tags()
  tags?: string[];
}

// GET /memory-vault?page=1&limit=25&category=FAMILY&search=holiday&tag=family
// (page/limit: the Recipients/Messages/admin convention, max 100).
export class MemoryVaultQueryDto extends PageQueryDto {
  @IsOptional()
  @Category()
  category?: MemoryVaultCategory;

  // Title or text, case-insensitive; blank = no search.
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(SEARCH_MAX)
  search?: string;

  // One tag, by name (normalized like stored tags); blank = no filter.
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(TAG_NAME_MAX)
  tag?: string;
}
