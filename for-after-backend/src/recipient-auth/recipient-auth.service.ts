import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MessageStatus, Prisma } from '../generated/prisma/client.js';
import {
  OtpAuthService,
  type SessionPrincipal,
} from '../otp-auth/otp-auth.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RedisService } from '../redis/redis.service.js';
import { SmsVerification } from '../sms/sms-verification.js';
import { RecipientOtpDelivery } from './recipient-otp-delivery.js';

export {
  INVALID_CODE,
  SMS_UNAVAILABLE,
  TOO_MANY,
} from '../otp-auth/otp-auth.service.js';

// Never for_after_session: the two principals must not be confused.
export const RECIPIENT_SESSION_COOKIE = 'for_after_recipient_session';
export const OTP_REQUESTED =
  'If released content is available for this email, a verification code has been sent.';
export const SMS_OTP_REQUESTED =
  'If released content is available for this mobile number, a verification code has been sent.';

/**
 * Everything a Recipient session holds: the email (email code) or the E.164
 * mobile (SMS code) it was proven with. Authorization is re-checked in PostgreSQL.
 */
export type RecipientPrincipal = SessionPrincipal;

/**
 * Message states a grant may authorize. RELEASED: released to everyone at
 * once. SCHEDULED: a recurring trigger (Phase 16) that already released to
 * this Recipient and keeps recurring. Grants are only ever written by the
 * release worker, so a grant on a SCHEDULED message is itself the proof of
 * this Recipient's release; others have no grant until their own due time.
 */
export const GRANTABLE_STATUSES: MessageStatus[] = [
  MessageStatus.RELEASED,
  MessageStatus.SCHEDULED,
];

/**
 * The only grants that authorize anything: the snapshot email (or mobile, for
 * an SMS session) matches, Message released (see above) and not deleted.
 * MessageRecipient alone never counts.
 */
export const grantFor = (principal: RecipientPrincipal) =>
  ({
    ...('mobile' in principal
      ? { recipientMobileNormalized: principal.mobile }
      : { recipientEmailNormalized: principal.emailNormalized }),
    message: { status: { in: GRANTABLE_STATUSES }, deletedAt: null },
  }) satisfies Prisma.RecipientMessageAccessGrantWhereInput;

export const eligibleGrant = (emailNormalized: string) =>
  grantFor({ emailNormalized });

/**
 * Recipient Portal passwordless sign-in (email code, or SMS code through
 * Twilio Verify) and opaque Redis sessions. A Recipient is never a User: no
 * password, role or account. Only emails/mobiles with released content are
 * eligible, by the same grant rule for both.
 */
@Injectable()
export class RecipientAuthService extends OtpAuthService {
  constructor(
    private readonly prisma: PrismaService,
    redis: RedisService,
    delivery: RecipientOtpDelivery,
    config: ConfigService,
    sms: SmsVerification,
  ) {
    super(
      redis,
      delivery,
      config,
      {
        prefix: 'RECIPIENT',
        kind: 'recipient',
        requestedMessage: OTP_REQUESTED,
        smsRequestedMessage: SMS_OTP_REQUESTED,
      },
      sms,
    );
  }

  protected async hasAccess(principal: RecipientPrincipal): Promise<boolean> {
    return (
      (await this.prisma.recipientMessageAccessGrant.count({
        where: grantFor(principal),
        take: 1,
      })) > 0
    );
  }
}
