import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { trim } from '../../auth/dto/register.dto.js';
import {
  AuditEventType,
  UserRole,
  UserStatus,
} from '../../generated/prisma/client.js';
import { trimToNull } from '../../messages/dto/create-message.dto.js';

export const REASON_MAX = 1000;

const enumMessage = (name: string, values: object) =>
  `${name} must be one of: ${Object.values(values).join(', ')}`;

/** ?page=1&limit=25 (max 100). Used by every admin list. */
export class PageQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100_000)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 25;
}

export class AdminUserListQueryDto extends PageQueryDto {
  // Matches email, first or last name (case-insensitive). Never content.
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(254)
  search?: string;

  @IsOptional()
  @IsEnum(UserStatus, { message: enumMessage('status', UserStatus) })
  status?: UserStatus;

  @IsOptional()
  @IsEnum(UserRole, { message: enumMessage('role', UserRole) })
  role?: UserRole;
}

// Plain text, trimmed; stored only in the audit row, never logged.
export class SuspendUserDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(REASON_MAX)
  reason: string;
}

export class ReactivateUserDto {
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(REASON_MAX)
  reason?: string | null;
}

export class AuditLogQueryDto extends PageQueryDto {
  @IsOptional()
  @IsEnum(AuditEventType, {
    message: enumMessage('eventType', AuditEventType),
  })
  eventType?: AuditEventType;

  @IsOptional()
  @IsUUID()
  actorUserId?: string;

  @IsOptional()
  @Matches(/^[A-Za-z]{1,50}$/, { message: 'subjectType is invalid' })
  subjectType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  subjectId?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  from?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  to?: string;
}
