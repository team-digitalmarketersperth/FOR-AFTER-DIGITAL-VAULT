import { Transform } from 'class-transformer';
import { IsEmail, IsString, Matches, MaxLength } from 'class-validator';
import { normalizeEmail } from '../../auth/dto/register.dto.js';

// Only these fields are accepted; the global ValidationPipe rejects anything
// else (recipientId, messageId, ...). Authorization never comes from the body.
export class RequestRecipientOtpDto {
  @Transform(normalizeEmail)
  @IsEmail()
  @MaxLength(254)
  email: string;
}

export class VerifyRecipientOtpDto {
  // 32 random bytes, base64url.
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{43}$/, { message: 'challengeId is invalid' })
  challengeId: string;

  @IsString()
  @Matches(/^\d{6}$/, { message: 'code must be 6 digits' })
  code: string;
}
