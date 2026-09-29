import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { maskEmail } from '../auth/dto/register.dto.js';

export type OtpDeliveryInput = {
  email: string;
  code: string;
  expiresInSeconds: number;
};

/**
 * Provider-neutral OTP delivery. Also the DI token: RecipientAuthModule binds
 * it from RECIPIENT_OTP_DELIVERY_MODE; tests bind a fake. A real email
 * provider is a later step and plugs in here without touching auth.
 */
export abstract class RecipientOtpDelivery {
  abstract sendOtp(input: OtpDeliveryInput): Promise<void>;
}

// Local development / Postman only. The factory refuses it outside development.
export class ConsoleOtpDelivery extends RecipientOtpDelivery {
  private readonly logger = new Logger('RecipientOtpDelivery');

  sendOtp({ email, code }: OtpDeliveryInput): Promise<void> {
    this.logger.warn(
      `[DEV ONLY] Recipient OTP for ${maskEmail(email)}: ${code}`,
    );
    return Promise.resolve();
  }
}

// No provider configured yet: codes are generated but not sent anywhere.
export class DisabledOtpDelivery extends RecipientOtpDelivery {
  private readonly logger = new Logger('RecipientOtpDelivery');

  sendOtp(): Promise<void> {
    this.logger.warn(
      'recipient_otp_delivery_disabled: no email provider configured, code not sent',
    );
    return Promise.resolve();
  }
}

export const otpDeliveryFactory = (
  config: ConfigService,
): RecipientOtpDelivery => {
  const mode = config.get<string>('RECIPIENT_OTP_DELIVERY_MODE') || 'disabled';
  if (mode === 'console') {
    if (config.get<string>('NODE_ENV') !== 'development') {
      throw new Error(
        'RECIPIENT_OTP_DELIVERY_MODE=console is only allowed with NODE_ENV=development. It logs one-time codes.',
      );
    }
    return new ConsoleOtpDelivery();
  }
  if (mode === 'disabled') return new DisabledOtpDelivery();
  throw new Error(
    'RECIPIENT_OTP_DELIVERY_MODE must be "disabled" or "console" (development only).',
  );
};
