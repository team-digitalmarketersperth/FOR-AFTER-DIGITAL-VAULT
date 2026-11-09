import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EmailProvider } from '../email/email-provider.js';
import type { Prisma } from '../generated/prisma/client.js';
import {
  EmailOtpDelivery,
  OtpAuthService,
  OtpDelivery,
  type SessionPrincipal,
} from '../otp-auth/otp-auth.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RedisService } from '../redis/redis.service.js';
import { SmsVerification } from '../sms/sms-verification.js';

// Never for_after_session or for_after_recipient_session: three principals,
// three cookies, and none authorizes another's routes.
export const TRUSTED_CONTACT_SESSION_COOKIE =
  'for_after_trusted_contact_session';
export const TRUSTED_CONTACT_OTP_REQUESTED =
  'If this email is registered as a trusted contact, a verification code has been sent.';
export const TRUSTED_CONTACT_SMS_OTP_REQUESTED =
  'If this mobile number is registered as a trusted contact, a verification code has been sent.';

/**
 * The email (email code) or E.164 mobile (SMS code) the session was proven
 * with. Relationships are looked up in PostgreSQL on every request.
 */
export type TrustedContactPrincipal = SessionPrincipal;

/**
 * The only TrustedContact rows that authorize anything: email (or, for an SMS
 * session, mobile) matches, the row is not deleted and neither is its
 * Customer. Every Trusted Contact query goes through this, so how someone
 * signed in never changes what they may do.
 */
export const activeRelationship = (principal: TrustedContactPrincipal) =>
  ({
    ...('mobile' in principal
      ? { mobile: principal.mobile }
      : { email: principal.emailNormalized }),
    deletedAt: null,
    owner: { deletedAt: null },
  }) satisfies Prisma.TrustedContactWhereInput;

/** DI token; email in the app (EMAIL_PROVIDER), faked in tests. */
export abstract class TrustedContactOtpDelivery extends OtpDelivery {}

export const trustedContactOtpDeliveryFactory = (
  email: EmailProvider,
): OtpDelivery => new EmailOtpDelivery(email, 'trusted-contact-otp');

/**
 * Trusted Contact passwordless sign-in (email code, or SMS code through
 * Twilio Verify) and opaque Redis sessions. A Trusted Contact is never a User
 * (no password, role or status). Unlike the Recipient Portal, no death report
 * or released content is required: any active Trusted Contact email or mobile
 * is eligible. No accepted invitation is needed, so mobile-only contacts
 * (who get no invitation; SMS invitations are deferred) can sign in by SMS.
 */
@Injectable()
export class TrustedContactAuthService extends OtpAuthService {
  constructor(
    private readonly prisma: PrismaService,
    redis: RedisService,
    delivery: TrustedContactOtpDelivery,
    config: ConfigService,
    sms: SmsVerification,
  ) {
    super(
      redis,
      delivery,
      config,
      {
        prefix: 'TRUSTED_CONTACT',
        kind: 'trusted_contact',
        requestedMessage: TRUSTED_CONTACT_OTP_REQUESTED,
        smsRequestedMessage: TRUSTED_CONTACT_SMS_OTP_REQUESTED,
      },
      sms,
    );
  }

  protected async hasAccess(
    principal: TrustedContactPrincipal,
  ): Promise<boolean> {
    return (
      (await this.prisma.trustedContact.count({
        where: activeRelationship(principal),
        take: 1,
      })) > 0
    );
  }
}
