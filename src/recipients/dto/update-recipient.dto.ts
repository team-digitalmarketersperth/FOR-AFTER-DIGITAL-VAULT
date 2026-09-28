import { OmitType, PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength, ValidateIf } from 'class-validator';
import { trim } from '../../auth/dto/register.dto.js';
import { CreateRecipientDto } from './create-recipient.dto.js';

export class UpdateRecipientDto extends PartialType(
  OmitType(CreateRecipientDto, ['firstName'] as const),
) {
  // May be omitted, but not cleared: null must fail like an empty string.
  @ValidateIf((_, value) => value !== undefined)
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  firstName?: string;
}
