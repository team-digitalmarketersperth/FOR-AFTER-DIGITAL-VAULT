import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import {
  Equals,
  IsEnum,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateBy,
} from 'class-validator';
import { PageQueryDto } from '../../admin/dto/admin.dto.js';
import { DeathVerificationCaseStatus } from '../../generated/prisma/client.js';
import { ISO_DATE_TIME_WITH_OFFSET } from '../../message-schedules/dto/create-message-schedule.dto.js';
import { trimToNull } from '../../messages/dto/create-message.dto.js';

export const DECISION_NOTE_MAX = 2000;

// Admin-only plain text: trimmed (blank → null), never logged or shown to
// Customers, Trusted Contacts or Recipients.
const DecisionNote = () =>
  applyDecorators(
    IsOptional(),
    Transform(trimToNull),
    IsString(),
    MaxLength(DECISION_NOTE_MAX),
  );

// Customer: POST /death-verification/me/confirm-alive. No other fields.
export class ConfirmAliveDto {
  @Equals(true, { message: 'confirmAlive must be true' })
  confirmAlive: true;
}

const NotInFuture = () =>
  ValidateBy({
    name: 'notInFuture',
    validator: {
      validate: (value) =>
        typeof value === 'string' && new Date(value).getTime() <= Date.now(),
      defaultMessage: () => 'verifiedDeathAt must not be in the future',
    },
  });

// Admin: POST /admin/death-verifications/:caseId/verify.
export class VerifyDeathCaseDto {
  // The approved time of death, with an explicit timezone; stored as UTC.
  // Never inferred from a report's reportedDateOfDeath.
  @Matches(ISO_DATE_TIME_WITH_OFFSET, {
    message:
      'verifiedDeathAt must be an ISO 8601 date-time with a timezone offset, e.g. 2026-09-28T14:30:00+10:00',
  })
  @IsISO8601({ strict: true })
  @NotInFuture()
  verifiedDeathAt: string;

  @Equals(true, { message: 'confirmVerification must be true' })
  confirmVerification: true;

  @DecisionNote()
  decisionNote?: string | null;
}

// Admin: POST /admin/death-verifications/:caseId/reject.
export class RejectDeathCaseDto {
  @Equals(true, { message: 'confirmRejection must be true' })
  confirmRejection: true;

  @DecisionNote()
  decisionNote?: string | null;
}

// Admin: GET /admin/death-verifications?status=&page=&limit=
export class DeathVerificationListQueryDto extends PageQueryDto {
  @IsOptional()
  @IsEnum(DeathVerificationCaseStatus, {
    message: `status must be one of: ${Object.values(DeathVerificationCaseStatus).join(', ')}`,
  })
  status?: DeathVerificationCaseStatus;
}
