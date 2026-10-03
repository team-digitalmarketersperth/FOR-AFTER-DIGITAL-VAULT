import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsNotEmpty,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
// The one email normalization (DTOs, release access grants, Recipient OTP).
export const emailKey = (email: string) => email.trim().toLowerCase();
// For logs: s***@example.com.
export const maskEmail = (email: string) =>
  email.replace(/^(.)[^@]*@/, '$1***@');
export const normalizeEmail = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? emailKey(value) : value;

// The one password rule: registration and password change (Step 22).
// Length over composition rules (NIST SP 800-63B). 128 caps Argon2 input.
export const IsNewPassword = () =>
  applyDecorators(IsString(), MinLength(12), MaxLength(128));

// Only these four fields are accepted; the global ValidationPipe rejects
// anything else (role, status, ...).
export class RegisterDto {
  @Transform(normalizeEmail)
  @IsEmail()
  @MaxLength(254)
  email: string;

  @IsNewPassword()
  password: string;

  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  firstName: string;

  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  lastName: string;
}
