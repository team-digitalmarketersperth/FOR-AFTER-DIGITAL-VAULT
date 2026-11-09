import { Transform } from 'class-transformer';
import { IsEmail, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Matches, MaxLength, Min } from 'class-validator';
import { PageQueryDto } from '../admin/dto/admin.dto.js';
import { normalizeEmail, trim } from '../auth/dto/register.dto.js';

export const NAME_MAX = 120;
export const SUBJECT_MAX = 150;
export const BODY_MAX = 5000;
export const CTA_LABEL_MAX = 60;

/**
 * Where a button may point: existing Customer pages that need no id or query.
 * Only the key is stored; the URL is built from the validated APP_BASE_URL,
 * never from a request. The page's own sign-in and access checks still apply.
 */
export const ANNOUNCEMENT_DESTINATIONS = {
  DASHBOARD: '/dashboard',
  SUPPORT: '/support',
} as const;
export type AnnouncementDestination = keyof typeof ANNOUNCEMENT_DESTINATIONS;
const DESTINATION_KEYS = Object.keys(ANNOUNCEMENT_DESTINATIONS);

// No line breaks (incl. Unicode separators) or other control characters: a subject becomes an email header.
const SINGLE_LINE = /^[^\p{Cc}\u2028\u2029]*$/u;

/** What the preview renders; also the content of a draft. Plain text only. */
export class AnnouncementContentDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(SUBJECT_MAX)
  @Matches(SINGLE_LINE, { message: 'subject must be a single line' })
  subject: string;

  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(BODY_MAX)
  body: string;

  // null or omitted = no button (IsOptional skips both). Label and destination together: checked in the service.
  @IsOptional()
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(CTA_LABEL_MAX)
  @Matches(SINGLE_LINE, { message: 'ctaLabel must be a single line' })
  ctaLabel?: string | null;

  @IsOptional()
  @IsIn(DESTINATION_KEYS, { message: `ctaDestination must be one of: ${DESTINATION_KEYS.join(', ')}` })
  ctaDestination?: AnnouncementDestination | null;
}

export class CreateAnnouncementDto extends AnnouncementContentDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(NAME_MAX)
  @Matches(SINGLE_LINE, { message: 'name must be a single line' })
  name: string;
}

/** expectedVersion: the version the editor loaded, so a newer save is a 409, never overwritten. */
export class UpdateAnnouncementDto extends CreateAnnouncementDto {
  @IsInt()
  @Min(1)
  expectedVersion: number;
}

/**
 * Step 2 test email. Only these two fields: the destination is always the
 * requester's own verified email (server-side), so no recipient, CC or BCC is accepted.
 */
export class CreateTestSendDto {
  /** One per deliberate test: a retried POST with the same id returns the same request. */
  @IsUUID()
  clientOperationId: string;

  /** The saved version the admin is testing; a newer save makes this a 409. */
  @IsInt()
  @Min(1)
  expectedVersion: number;
}

/** Step 4: review the SAVED version for sending; a newer save makes this a 409. */
export class BroadcastReviewDto {
  @IsInt()
  @Min(1)
  expectedVersion: number;
}

/**
 * Step 4 confirmation ("Queue announcement"). No recipients, counts or content:
 * only the operation id, the reviewed version and the server-issued review token.
 */
export class CreateBroadcastDto {
  /** One per deliberate confirmation: a retried POST with the same id returns the same run. */
  @IsUUID()
  clientOperationId: string;

  @IsInt()
  @Min(1)
  expectedVersion: number;

  @IsString()
  @MaxLength(2048)
  @Matches(/^[\w-]+\.[\w-]+$/, { message: 'reviewToken is not valid' })
  reviewToken: string;
}

/** Step 7: who a send would reach. Pilot = only the explicitly selected pilot members. */
export class AudienceScopeDto {
  @IsIn(['PILOT', 'ALL_ELIGIBLE'])
  audience: 'PILOT' | 'ALL_ELIGIBLE';
}

/** Step 7: add one existing Customer account to the pilot group, by its exact address. */
export class AddPilotMemberDto {
  @Transform(normalizeEmail)
  @IsEmail()
  @MaxLength(254)
  email: string;
}

const RECIPIENT_STATES = ['QUEUED', 'PROCESSING', 'ACCEPTED', 'FAILED', 'UNKNOWN', 'SKIPPED', 'CANCELLED'] as const;

/** Results table: one page of a run's recipients, filtered by state and/or searched by name or address. */
export class RecipientQueryDto extends PageQueryDto {
  @IsOptional()
  @IsIn(RECIPIENT_STATES)
  status?: (typeof RECIPIENT_STATES)[number];

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  q?: string;
}

/** Manual retry review: one recipient, or (omitted) every eligible failure of the run. */
export class RetryReviewDto {
  @IsOptional()
  @IsUUID()
  recipientId?: string;
}

/** Confirms exactly the reviewed set (its hash); a replay with the same clientOperationId returns the same request. */
export class CreateRetryDto extends RetryReviewDto {
  @IsUUID()
  clientOperationId: string;

  @IsString()
  @Matches(/^[a-f0-9]{64}$/, { message: 'setHash is not valid' })
  setHash: string;
}
