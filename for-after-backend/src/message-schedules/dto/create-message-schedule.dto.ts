import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { ReleaseTriggerType } from '../../generated/prisma/client.js';
import { LOCAL_TIME } from '../recurrence.js';

// Product-configurable, about 100 years.
export const AFTER_DEATH_DAYS_MAX = 36_500;
export const EVENT_LABEL_MAX = 100;

export const SupportedTrigger = () =>
  IsEnum(ReleaseTriggerType, {
    message: `triggerType must be one of ${Object.values(ReleaseTriggerType).join(', ')}`,
  });

// Field shapes only. Which fields a trigger needs (and "in the future") is
// checked on the complete final state by checkSchedule in the service, since
// PATCH merges with the stored schedule. null means "not set".
// Date + time + explicit offset (Z or ±hh:mm): never server-local time.
export const ISO_DATE_TIME_WITH_OFFSET =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
// Plain text: no markup characters or control characters.
const PLAIN_LABEL = /^[^<>\p{Cc}]*$/u;

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CreateMessageScheduleDto {
  @SupportedTrigger()
  triggerType: ReleaseTriggerType;

  // FIXED_DATE. Strict ISO check rejects impossible dates like 2026-02-30.
  @IsOptional()
  @Matches(ISO_DATE_TIME_WITH_OFFSET, {
    message:
      'scheduledFor must be an ISO 8601 date-time with a timezone offset, e.g. 2026-12-25T09:00:00+08:00',
  })
  @IsISO8601({ strict: true })
  scheduledFor?: string | null;

  // AFTER_DEATH.
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(AFTER_DEATH_DAYS_MAX)
  afterDeathDays?: number | null;

  // BIRTHDAY, ANNIVERSARY, CUSTOM_EVENT, ANNUAL_AFTER_DEATH: IANA zone name
  // (validated in the service), e.g. Australia/Perth.
  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string | null;

  // Same triggers: local wall time "HH:mm".
  @IsOptional()
  @Matches(LOCAL_TIME, { message: 'localTime must be HH:mm (24-hour)' })
  localTime?: string | null;

  // ANNIVERSARY (no year; 29 Feb allowed).
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(12)
  annualMonth?: number | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(31)
  annualDay?: number | null;

  // CUSTOM_EVENT: the local calendar date, YYYY-MM-DD.
  @IsOptional()
  @Matches(DATE_ONLY, { message: 'eventDate must be YYYY-MM-DD' })
  @IsISO8601({ strict: true })
  eventDate?: string | null;

  // CUSTOM_EVENT: plain-text name of the occasion.
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(EVENT_LABEL_MAX)
  @Matches(PLAIN_LABEL, {
    message: 'eventLabel must be plain text (no < or > characters)',
  })
  eventLabel?: string | null;
}
