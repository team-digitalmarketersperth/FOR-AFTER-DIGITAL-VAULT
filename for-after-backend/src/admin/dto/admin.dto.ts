import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsTimeZone,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ASSISTANT_ACTIONS, ASSISTANT_PAGES } from '../../assistant/assistant.service.js';
import { normalizeEmail, trim } from '../../auth/dto/register.dto.js';
import { DEAD_LETTER_QUEUES } from '../../dead-letters/dead-letter.service.js';
import {
  AuditActorType,
  AuditEventType,
  DeadLetterStatus,
  MessageStatus,
  ReleaseTriggerType,
  UserRole,
  UserStatus,
} from '../../generated/prisma/client.js';
import { trimToNull } from '../../messages/dto/create-message.dto.js';
import { ERROR_CATEGORIES, type ErrorCategory } from '../admin-deliveries.service.js';
import {
  SECURITY_CATEGORIES,
  SECURITY_OUTCOMES,
  type SecurityCategory,
  type SecurityOutcome,
} from '../admin-security.service.js';
import {
  IP_BLOCK_DURATIONS,
  IP_BLOCK_REASON_MAX,
  IP_BLOCK_STATUSES,
  type IpBlockStatus,
} from '../../ip-blocks/ip-block.service.js';
import { DELETION_STATES, MEDIA_KINDS, STORAGE_SOURCES, UPLOAD_STATES } from '../admin-storage.service.js';

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

export class DeadLetterQueryDto extends PageQueryDto {
  @IsOptional()
  @IsIn(DEAD_LETTER_QUEUES, {
    message: `queue must be one of: ${DEAD_LETTER_QUEUES.join(', ')}`,
  })
  queue?: (typeof DEAD_LETTER_QUEUES)[number];

  @IsOptional()
  @IsEnum(DeadLetterStatus, {
    message: enumMessage('status', DeadLetterStatus),
  })
  status?: DeadLetterStatus;

  @IsOptional()
  @IsISO8601({ strict: true })
  from?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  to?: string;
}

// GET /admin/releases (docs/admin.md §16). Ids and enums only: no text search,
// so no customer-written content can be searched.
const RELEASE_STATUSES = [MessageStatus.SCHEDULED, MessageStatus.RELEASED, MessageStatus.CANCELLED] as const;
export class ReleaseListQueryDto extends PageQueryDto {
  @IsOptional()
  @IsIn(RELEASE_STATUSES, { message: `status must be one of: ${RELEASE_STATUSES.join(', ')}` })
  status?: (typeof RELEASE_STATUSES)[number];

  @IsOptional()
  @IsEnum(ReleaseTriggerType, { message: enumMessage('triggerType', ReleaseTriggerType) })
  triggerType?: ReleaseTriggerType;

  // Applies to the stored schedule instant (FIXED_DATE / CUSTOM_EVENT).
  @IsOptional()
  @IsISO8601({ strict: true })
  scheduledFrom?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  scheduledTo?: string;

  /** Exact Message id. */
  @IsOptional()
  @IsUUID()
  reference?: string;

  /** Exact owner (User) id. */
  @IsOptional()
  @IsUUID()
  accountId?: string;

  /** Same definition as the Overview's "past due, not yet released". */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  pastDue?: boolean;

  @IsOptional()
  @IsIn(['updatedAt', 'createdAt', 'scheduledFor'], {
    message: 'sort must be one of: updatedAt, createdAt, scheduledFor',
  })
  sort?: 'updatedAt' | 'createdAt' | 'scheduledFor';

  @IsOptional()
  @IsIn(['asc', 'desc'], { message: 'dir must be one of: asc, desc' })
  dir?: 'asc' | 'desc';
}

// GET /admin/deliveries (docs/admin.md §17). One category per request; status
// values depend on it (checked in the service). Ids and enums only: no text
// search, so no address, subject or body can be searched.
export const DELIVERY_CATEGORIES = ['release_email', 'safety_notice'] as const;
const boolParam = ({ value }: { value: unknown }) => (value === 'true' ? true : value === 'false' ? false : value);
export class DeliveryListQueryDto extends PageQueryDto {
  @IsOptional()
  @IsIn(DELIVERY_CATEGORIES, { message: `category must be one of: ${DELIVERY_CATEGORIES.join(', ')}` })
  category: (typeof DELIVERY_CATEGORIES)[number] = 'release_email';

  @IsOptional()
  @Matches(/^[a-z_]{1,40}$/, { message: 'status is invalid' })
  status?: string;

  @IsOptional()
  @Transform(boolParam)
  @IsBoolean()
  outcomeUncertain?: boolean;

  @IsOptional()
  @IsIn(ERROR_CATEGORIES, { message: `errorCategory must be one of: ${ERROR_CATEGORIES.join(', ')}` })
  errorCategory?: ErrorCategory;

  /** Exact delivery id (ReleaseNotification id, or the case id for a safety notice). */
  @IsOptional()
  @IsUUID()
  reference?: string;

  /** Exact Message id (release emails only). */
  @IsOptional()
  @IsUUID()
  releaseReference?: string;

  /** Created-time range (when the delivery intent was recorded). */
  @IsOptional()
  @IsISO8601({ strict: true })
  createdFrom?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  createdTo?: string;

  @IsOptional()
  @IsIn(['createdAt', 'updatedAt'], { message: 'sort must be one of: createdAt, updatedAt' })
  sort?: 'createdAt' | 'updatedAt';

  @IsOptional()
  @IsIn(['asc', 'desc'], { message: 'dir must be one of: asc, desc' })
  dir?: 'asc' | 'desc';
}

// GET /admin/security/events (docs/admin.md §20). Enums and exact ids only: no
// text search over metadata, no IP search.
export class SecurityEventQueryDto extends PageQueryDto {
  @IsOptional()
  @IsIn(SECURITY_CATEGORIES, { message: `category must be one of: ${SECURITY_CATEGORIES.join(', ')}` })
  category?: SecurityCategory;

  @IsOptional()
  @IsIn(SECURITY_OUTCOMES, { message: `outcome must be one of: ${SECURITY_OUTCOMES.join(', ')}` })
  outcome?: SecurityOutcome;

  @IsOptional()
  @IsEnum(AuditActorType, { message: enumMessage('actorType', AuditActorType) })
  actorType?: AuditActorType;

  /** Exact audit row id. */
  @IsOptional()
  @IsUUID()
  reference?: string;

  /** Exact User id the event is about (server-recorded subject). */
  @IsOptional()
  @IsUUID()
  accountId?: string;

  /** Recorded-time range; defaults to the last 30 days, at most 366. */
  @IsOptional()
  @IsISO8601({ strict: true })
  from?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  to?: string;

  /** IANA zone for the chart's day and hour bins (default UTC). Names only: Postgres reads a bare "+05:30" backwards. */
  @IsOptional()
  @IsTimeZone()
  @Matches(/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/)
  @MaxLength(64)
  tz?: string;
}

// POST /admin/security/ip-blocks (docs/admin.md §20a). The address is checked and
// normalised by IpBlockService; only the listed durations exist.
export class CreateIpBlockDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  ip!: string;

  @Type(() => Number)
  @IsIn(IP_BLOCK_DURATIONS, { message: `durationMinutes must be one of: ${IP_BLOCK_DURATIONS.join(', ')}` })
  durationMinutes!: number;

  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(IP_BLOCK_REASON_MAX)
  reason!: string;
}

export class IpBlockQueryDto extends PageQueryDto {
  @IsOptional()
  @IsIn(IP_BLOCK_STATUSES, { message: `status must be one of: ${IP_BLOCK_STATUSES.join(', ')}` })
  status?: IpBlockStatus;
}

// GET /admin/storage/assets (docs/admin.md §21). Enums and exact ids only: no
// file name, title or MIME search.
export class StorageAssetQueryDto extends PageQueryDto {
  @IsOptional()
  @IsIn(STORAGE_SOURCES, { message: `source must be one of: ${STORAGE_SOURCES.join(', ')}` })
  source?: (typeof STORAGE_SOURCES)[number];

  @IsOptional()
  @IsIn(UPLOAD_STATES, { message: `uploadState must be one of: ${UPLOAD_STATES.join(', ')}` })
  uploadState?: (typeof UPLOAD_STATES)[number];

  @IsOptional()
  @IsIn(DELETION_STATES, { message: `deletion must be one of: ${DELETION_STATES.join(', ')}` })
  deletion?: (typeof DELETION_STATES)[number];

  @IsOptional()
  @IsIn(MEDIA_KINDS, { message: `kind must be one of: ${MEDIA_KINDS.join(', ')}` })
  kind?: (typeof MEDIA_KINDS)[number];

  /** Exact stored-file row id. */
  @IsOptional()
  @IsUUID()
  reference?: string;

  /** Exact owner (User) id. */
  @IsOptional()
  @IsUUID()
  accountId?: string;

  /** Created-time range (when the upload was started); at most 366 days. */
  @IsOptional()
  @IsISO8601({ strict: true })
  from?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  to?: string;

  @IsOptional()
  @IsIn(['createdAt', 'updatedAt'], { message: 'sort must be one of: createdAt, updatedAt' })
  sort?: 'createdAt' | 'updatedAt';

  @IsOptional()
  @IsIn(['asc', 'desc'], { message: 'dir must be one of: asc, desc' })
  dir?: 'asc' | 'desc';
}

// GET /admin/system/ai (docs/assistant.md §8): allowlisted window, area (companion page) and action.
// "area", not "page": page is the pagination parameter everywhere else.
export class AiOperationsQueryDto {
  @IsOptional()
  @IsIn(['24h', '7d'], { message: 'window must be one of: 24h, 7d' })
  window?: '24h' | '7d';

  @IsOptional()
  @IsIn(ASSISTANT_PAGES, { message: `area must be one of: ${ASSISTANT_PAGES.join(', ')}` })
  area?: (typeof ASSISTANT_PAGES)[number];

  @IsOptional()
  @IsIn(ASSISTANT_ACTIONS, { message: `action must be one of: ${ASSISTANT_ACTIONS.join(', ')}` })
  action?: (typeof ASSISTANT_ACTIONS)[number];
}

// GET /admin/access/admins (docs/admin.md §22): admin roles, statuses and MFA
// enrolment only; search over email/name as on the Users page.
export class AdminAccessQueryDto extends PageQueryDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(254)
  search?: string;

  @IsOptional()
  @IsIn([UserRole.ADMIN, UserRole.SUPER_ADMIN], { message: 'role must be one of: ADMIN, SUPER_ADMIN' })
  role?: 'ADMIN' | 'SUPER_ADMIN';

  @IsOptional()
  @IsEnum(UserStatus, { message: enumMessage('status', UserStatus) })
  status?: UserStatus;

  @IsOptional()
  @IsIn(['enrolled', 'not_enrolled'], { message: 'mfa must be one of: enrolled, not_enrolled' })
  mfa?: 'enrolled' | 'not_enrolled';

  @IsOptional()
  @IsIn(['createdAt', 'email'], { message: 'sort must be one of: createdAt, email' })
  sort?: 'createdAt' | 'email';

  @IsOptional()
  @IsIn(['asc', 'desc'], { message: 'dir must be one of: asc, desc' })
  dir?: 'asc' | 'desc';
}

// POST /admin/access/admins: names and email only. No role, permission or
// password field exists, so none can be sent (unknown fields are rejected).
export class CreateAdminDto {
  @Transform(normalizeEmail)
  @IsEmail()
  @MaxLength(254)
  email: string;

  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  firstName: string;

  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  lastName: string;
}
