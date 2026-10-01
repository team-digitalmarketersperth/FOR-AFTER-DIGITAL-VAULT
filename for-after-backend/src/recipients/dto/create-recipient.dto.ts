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

// Basic shape check only: stored as typed, no country-code guessing or verification.
export const IsMobile = () =>
  Matches(/^\+?[0-9][0-9 ()-]{5,19}$/, {
    message: 'mobile must be a phone number, e.g. +61400000000',
  });

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

  @IsOptional()
  @Transform(trim)
  @IsMobile()
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
