import { Transform } from 'class-transformer';
import {
  IsDefined,
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { normalizeEmail, trim } from '../../auth/dto/register.dto.js';
import { IsMobile } from '../../recipients/dto/create-recipient.dto.js';

export const CONTACT_METHOD_REQUIRED =
  'Provide an email or a mobile (or both).';

// Only these fields are accepted; the global ValidationPipe rejects anything
// else (ownerUserId, id, deletedAt, ...). Optional fields accept null to clear.
export class CreateTrustedContactDto {
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

  // Required when there is no mobile. Not unique: one person may be a
  // trusted contact for several customers.
  @ValidateIf(
    (o: CreateTrustedContactDto) => o.email != null || o.mobile == null,
  )
  @IsDefined({ message: CONTACT_METHOD_REQUIRED })
  @Transform(normalizeEmail)
  @IsEmail()
  @MaxLength(254)
  email?: string | null;

  @IsOptional()
  @Transform(trim)
  @IsMobile()
  mobile?: string | null;
}
