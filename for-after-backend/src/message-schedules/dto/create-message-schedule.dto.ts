import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { ReleaseTriggerType } from '../../generated/prisma/client.js';

export const SUPPORTED_TRIGGERS = [
  ReleaseTriggerType.FIXED_DATE,
  ReleaseTriggerType.ON_DEATH,
  ReleaseTriggerType.AFTER_DEATH,
] as const;
export type SupportedTrigger = (typeof SUPPORTED_TRIGGERS)[number];

// Product-configurable, about 100 years.
export const AFTER_DEATH_DAYS_MAX = 36_500;

export const SupportedTrigger = () =>
  IsIn(SUPPORTED_TRIGGERS, {
    message: `triggerType must be one of ${SUPPORTED_TRIGGERS.join(', ')} (other release types are not available yet)`,
  });

// Field shapes only. Which fields a trigger needs (and "in the future") is
// checked on the complete final state by checkSchedule in the service, since
// PATCH merges with the stored schedule. null means "not set".
// Date + time + explicit offset (Z or ±hh:mm): never server-local time.
export const ISO_DATE_TIME_WITH_OFFSET =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

export class CreateMessageScheduleDto {
  @SupportedTrigger()
  triggerType: SupportedTrigger;

  // Date + time + explicit offset (Z or ±hh:mm); never server-local time.
  // Strict ISO check rejects impossible dates like 2026-02-30.
  @IsOptional()
  @Matches(ISO_DATE_TIME_WITH_OFFSET, {
    message:
      'scheduledFor must be an ISO 8601 date-time with a timezone offset, e.g. 2026-12-25T09:00:00+08:00',
  })
  @IsISO8601({ strict: true })
  scheduledFor?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(AFTER_DEATH_DAYS_MAX)
  afterDeathDays?: number | null;
}
