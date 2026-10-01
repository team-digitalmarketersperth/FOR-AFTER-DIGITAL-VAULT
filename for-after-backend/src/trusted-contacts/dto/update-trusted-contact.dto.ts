import { OmitType, PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength, ValidateIf } from 'class-validator';
import { trim } from '../../auth/dto/register.dto.js';
import { CreateTrustedContactDto } from './create-trusted-contact.dto.js';

// All optional. Whether email/mobile may be cleared depends on the stored row,
// so that rule is enforced by TrustedContactsService.update.
export class UpdateTrustedContactDto extends PartialType(
  OmitType(CreateTrustedContactDto, ['firstName'] as const),
) {
  // May be omitted, but not cleared: null must fail like an empty string.
  @ValidateIf((_, value) => value !== undefined)
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  firstName?: string;
}
