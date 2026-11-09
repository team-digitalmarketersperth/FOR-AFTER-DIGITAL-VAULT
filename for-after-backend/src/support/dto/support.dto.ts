import {
  IsEnum,
  IsIn,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { PageQueryDto } from '../../admin/dto/admin.dto.js';
import { trim } from '../../auth/dto/register.dto.js';
import { SupportCategory, SupportStatus } from '../../generated/prisma/client.js';

export const SUBJECT_MAX = 150;
export const TEXT_MAX = 5000;

const enumMessage = (name: string, values: object) =>
  `${name} must be one of: ${Object.values(values).join(', ')}`;

/**
 * Every write carries a client-generated UUID: a retried submission (same
 * author, same id) returns the first result instead of creating a second.
 */
class Submission {
  @IsUUID()
  clientRequestId: string;
}

// Plain text, trimmed. Owner, status and author always come from the server.
export class CreateSupportRequestDto extends Submission {
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MinLength(3)
  @MaxLength(SUBJECT_MAX)
  subject: string;

  @IsEnum(SupportCategory, { message: enumMessage('category', SupportCategory) })
  category: SupportCategory;

  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MinLength(10)
  @MaxLength(TEXT_MAX)
  description: string;
}

/** A Customer follow-up, an admin reply or an internal note. */
export class SupportTextDto extends Submission {
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(TEXT_MAX)
  body: string;
}

/** expectedStatus: the status the admin saw, so a concurrent change is a 409, not overwritten. */
export class SupportStatusDto {
  @IsEnum(SupportStatus, { message: enumMessage('status', SupportStatus) })
  status: SupportStatus;

  @IsEnum(SupportStatus, { message: enumMessage('expectedStatus', SupportStatus) })
  expectedStatus: SupportStatus;
}

export class AdminSupportQueryDto extends PageQueryDto {
  @IsOptional()
  @IsEnum(SupportStatus, { message: enumMessage('status', SupportStatus) })
  status?: SupportStatus;

  @IsOptional()
  @IsEnum(SupportCategory, { message: enumMessage('category', SupportCategory) })
  category?: SupportCategory;

  /** Exact request id. */
  @IsOptional()
  @IsUUID()
  reference?: string;

  /** Exact owner (User) id. */
  @IsOptional()
  @IsUUID()
  accountId?: string;

  /** Created-time range; at most 366 days. */
  @IsOptional()
  @IsISO8601({ strict: true })
  from?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  to?: string;

  @IsOptional()
  @IsIn(['createdAt', 'lastPublicActivityAt'], { message: 'sort must be one of: createdAt, lastPublicActivityAt' })
  sort?: 'createdAt' | 'lastPublicActivityAt';
}
