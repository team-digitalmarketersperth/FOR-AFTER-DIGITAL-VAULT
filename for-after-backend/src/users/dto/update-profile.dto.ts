import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength, ValidateIf } from 'class-validator';
import { trim } from '../../auth/dto/register.dto.js';

// Name only. Email (no verified change flow yet), role, status and everything
// else are rejected by the global pipe (forbidNonWhitelisted).
export class UpdateProfileDto {
  // May be omitted, but not cleared: null must fail like an empty string.
  @ValidateIf((_, value) => value !== undefined)
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  firstName?: string;

  @ValidateIf((_, value) => value !== undefined)
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  lastName?: string;
}
