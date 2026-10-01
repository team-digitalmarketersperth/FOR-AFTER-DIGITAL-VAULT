import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MessageStatus, Prisma } from '../generated/prisma/client.js';
import {
  OtpAuthService,
  type OtpPrincipal,
} from '../otp-auth/otp-auth.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RedisService } from '../redis/redis.service.js';
import { RecipientOtpDelivery } from './recipient-otp-delivery.js';

export { INVALID_CODE, TOO_MANY } from '../otp-auth/otp-auth.service.js';

// Never for_after_session: the two principals must not be confused.
export const RECIPIENT_SESSION_COOKIE = 'for_after_recipient_session';
export const OTP_REQUESTED =
  'If released content is available for this email, a verification code has been sent.';

/** Everything a Recipient session holds. Authorization is re-checked in PostgreSQL. */
export type RecipientPrincipal = OtpPrincipal;

/**
 * The only grants that authorize anything: snapshot email matches, Message
 * RELEASED and not deleted. MessageRecipient alone never counts.
 */
export const eligibleGrant = (emailNormalized: string) =>
  ({
    recipientEmailNormalized: emailNormalized,
    message: { status: MessageStatus.RELEASED, deletedAt: null },
  }) satisfies Prisma.RecipientMessageAccessGrantWhereInput;

/**
 * Recipient Portal passwordless email OTP and opaque Redis sessions. A
 * Recipient is never a User: no password, role or account. Only emails with
 * released content are eligible.
 */
@Injectable()
export class RecipientAuthService extends OtpAuthService {
  constructor(
    private readonly prisma: PrismaService,
    redis: RedisService,
    delivery: RecipientOtpDelivery,
    config: ConfigService,
  ) {
    super(redis, delivery, config, {
      prefix: 'RECIPIENT',
      kind: 'recipient',
      requestedMessage: OTP_REQUESTED,
    });
  }

  protected async hasAccess(emailNormalized: string): Promise<boolean> {
    return (
      (await this.prisma.recipientMessageAccessGrant.count({
        where: eligibleGrant(emailNormalized),
        take: 1,
      })) > 0
    );
  }
}
