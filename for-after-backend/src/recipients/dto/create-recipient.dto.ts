import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { normalizeEmail, trim } from '../../auth/dto/register.dto.js';

/**
 * E.164: + country code + number, digits only, as Twilio Verify needs it.
 * Recipient and Trusted Contact mobiles (SMS sign-in for both).
 */
export const E164 = /^\+[1-9]\d{6,14}$/;
/** Spaces, dots, dashes and brackets removed. No country-code guessing. */
export const stripPhone = (value: string) => value.replace(/[\s().-]/g, '');
export const normalizeMobile = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? stripPhone(value) : value;
export const IsE164Mobile = () =>
  Matches(E164, {
    message: 'mobile must include the country code, e.g. +61400000000',
  });
/** For logs: +61******678. */
export const maskMobile = (mobile: string) =>
  `${mobile.slice(0, 3)}******${mobile.slice(-3)}`;

// Only these fields are accepted; the global ValidationPipe rejects anything
// else (ownerUserId, id, deletedAt, ...). Optional fields accept null to clear.
export class CreateRecipientDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  firstName: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  lastName?: string | null;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(50)
  relationship?: string | null;

  // Not unique: several customers may add the same person.
  @IsOptional()
  @Transform(normalizeEmail)
  @IsEmail()
  @MaxLength(254)
  email?: string | null;

  // Not unique, like email. Stored as E.164 so SMS sign-in can match it.
  @IsOptional()
  @Transform(normalizeMobile)
  @IsE164Mobile()
  mobile?: string | null;

  // Calendar date only; strict mode rejects impossible dates like 2001-02-30.
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'birthday must be YYYY-MM-DD' })
  @IsISO8601({ strict: true })
  birthday?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  privateNote?: string | null;
}
