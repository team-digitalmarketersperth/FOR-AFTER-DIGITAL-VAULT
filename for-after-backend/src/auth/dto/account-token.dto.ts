import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { IsNewPassword, normalizeEmail } from './register.dto.js';

// The emailed token: 32 random bytes, base64url (43 characters).
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export class EmailTokenDto {
  @IsString()
  @Matches(TOKEN, { message: 'This link is invalid or has expired.' })
  token: string;
}

/** forgot-password and resend-verification: the answer never depends on it. */
export class AccountEmailDto {
  @Transform(normalizeEmail)
  @IsEmail()
  @MaxLength(254)
  email: string;
}

// The one password rule (IsNewPassword), same as registration and change.
export class ResetPasswordDto extends EmailTokenDto {
  @IsNewPassword()
  newPassword: string;
}

// Phase 08: exactly these two fields. The password is checked against the
// stored hash, so only the login limits apply to it.
export class ChangeEmailDto {
  @Transform(normalizeEmail)
  @IsEmail()
  @MaxLength(254)
  newEmail: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  currentPassword: string;
}
