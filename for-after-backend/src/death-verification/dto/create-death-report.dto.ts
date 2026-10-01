import { Transform } from 'class-transformer';
import {
  Equals,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateBy,
} from 'class-validator';
import { trimToNull } from '../../messages/dto/create-message.dto.js';

export const NOTE_MAX = 2000;

// "Today" in the furthest-ahead timezone (UTC+14). The client's timezone is
// unknown, so this accepts today's date everywhere on Earth and rejects any
// date that is still in the future for everyone. Plain string compare works
// because both sides are YYYY-MM-DD.
export const latestToday = (now = new Date()) =>
  new Date(now.getTime() + 14 * 3_600_000).toISOString().slice(0, 10);

const NotInFuture = () =>
  ValidateBy({
    name: 'notInFuture',
    validator: {
      validate: (value) => typeof value === 'string' && value <= latestToday(),
      defaultMessage: () => 'reportedDateOfDeath must not be in the future',
    },
  });

/**
 * A report, not proof of death. Unknown fields (ownerUserId, status,
 * trustedContactId, ...) are rejected by the global whitelist pipe.
 */
export class CreateDeathReportDto {
  // Same date-only convention as Recipient birthday: no time, no timezone.
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'reportedDateOfDeath must be YYYY-MM-DD',
  })
  @IsISO8601({ strict: true })
  @NotInFuture()
  reportedDateOfDeath?: string | null;

  // Plain text, never rendered as HTML and never logged.
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(NOTE_MAX)
  note?: string | null;

  // Deliberate-action safeguard only; not stored and not a legal attestation.
  @Equals(true, { message: 'confirmReport must be true' })
  confirmReport: true;
}
