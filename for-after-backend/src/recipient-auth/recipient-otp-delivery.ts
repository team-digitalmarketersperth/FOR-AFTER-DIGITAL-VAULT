import { EmailProvider } from '../email/email-provider.js';
import { EmailOtpDelivery, OtpDelivery } from '../otp-auth/otp-auth.service.js';

export { type OtpDeliveryInput } from '../otp-auth/otp-auth.service.js';

/**
 * DI token for Recipient OTP delivery. RecipientAuthModule binds it to email
 * (EMAIL_PROVIDER); tests bind a fake.
 */
export abstract class RecipientOtpDelivery extends OtpDelivery {}

export const otpDeliveryFactory = (email: EmailProvider): OtpDelivery =>
  new EmailOtpDelivery(email, 'recipient-otp');
