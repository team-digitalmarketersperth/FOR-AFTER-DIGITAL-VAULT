import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { IsNewPassword } from './register.dto.js';

// Exactly these two fields; anything else is rejected by the global pipe.
export class ChangePasswordDto {
  // Checked against the stored hash, so only LoginDto's limits apply.
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  currentPassword: string;

  @IsNewPassword()
  newPassword: string;
}
