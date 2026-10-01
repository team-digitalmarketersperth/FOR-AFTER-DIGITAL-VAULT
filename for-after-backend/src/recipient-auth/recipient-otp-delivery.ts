import { ConfigService } from '@nestjs/config';
import {
  createOtpDelivery,
  OtpDelivery,
} from '../otp-auth/otp-auth.service.js';

export {
  ConsoleOtpDelivery,
  DisabledOtpDelivery,
  type OtpDeliveryInput,
} from '../otp-auth/otp-auth.service.js';

/**
 * DI token for Recipient OTP delivery. RecipientAuthModule binds it from
 * RECIPIENT_OTP_DELIVERY_MODE; tests bind a fake.
 */
export abstract class RecipientOtpDelivery extends OtpDelivery {}

export const otpDeliveryFactory = (config: ConfigService): OtpDelivery =>
  createOtpDelivery(config, 'RECIPIENT', 'Recipient', 'recipient');
