import { IsString, Matches } from 'class-validator';

// Only these fields are accepted; the global ValidationPipe rejects anything
// else (userId, role, secret, ...). The user always comes from the challenge.
export class AdminMfaChallengeDto {
  // 32 random bytes, base64url.
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{43}$/, { message: 'challengeId is invalid' })
  challengeId: string;
}

// TOTP and recovery codes use separate DTOs and routes, never one ambiguous field.
export class AdminTotpCodeDto extends AdminMfaChallengeDto {
  @IsString()
  @Matches(/^\d{6}$/, { message: 'code must be 6 digits' })
  code: string;
}

export class AdminRecoveryCodeDto extends AdminMfaChallengeDto {
  // XXXX-XXXX-XXXX-XXXX; hyphens/spaces optional, any case.
  @IsString()
  @Matches(/^(?:[A-Za-z0-9][\s-]?){16}$/, {
    message: 'recoveryCode is invalid',
  })
  recoveryCode: string;
}
