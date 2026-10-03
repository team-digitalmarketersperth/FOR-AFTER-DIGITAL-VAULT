import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EmailProvider } from '../email/email-provider.js';
import type { Prisma } from '../generated/prisma/client.js';
import {
  EmailOtpDelivery,
  OtpAuthService,
  OtpDelivery,
  type OtpPrincipal,
} from '../otp-auth/otp-auth.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RedisService } from '../redis/redis.service.js';

// Never for_after_session or for_after_recipient_session: three principals,
// three cookies, and none authorizes another's routes.
export const TRUSTED_CONTACT_SESSION_COOKIE =
  'for_after_trusted_contact_session';
export const TRUSTED_CONTACT_OTP_REQUESTED =
  'If this email is registered as a trusted contact, a verification code has been sent.';

/** Email only: relationships are looked up in PostgreSQL on every request. */
export type TrustedContactPrincipal = OtpPrincipal;

/**
 * The only TrustedContact rows that authorize anything: email matches, the
 * row is not deleted and neither is its Customer. Every Trusted Contact
 * query goes through this.
 */
export const activeRelationship = (emailNormalized: string) =>
  ({
    email: emailNormalized,
    deletedAt: null,
    owner: { deletedAt: null },
  }) satisfies Prisma.TrustedContactWhereInput;

/** DI token; email in the app (EMAIL_PROVIDER), faked in tests. */
export abstract class TrustedContactOtpDelivery extends OtpDelivery {}

export const trustedContactOtpDeliveryFactory = (
  email: EmailProvider,
): OtpDelivery => new EmailOtpDelivery(email, 'trusted-contact-otp');

/**
 * Trusted Contact passwordless email OTP and opaque Redis sessions. A
 * Trusted Contact is never a User (no password, role or status). Unlike the
 * Recipient Portal, no death report or released content is required: any
 * active Trusted Contact email is eligible.
 */
@Injectable()
export class TrustedContactAuthService extends OtpAuthService {
  constructor(
    private readonly prisma: PrismaService,
    redis: RedisService,
    delivery: TrustedContactOtpDelivery,
    config: ConfigService,
  ) {
    super(redis, delivery, config, {
      prefix: 'TRUSTED_CONTACT',
      kind: 'trusted_contact',
      requestedMessage: TRUSTED_CONTACT_OTP_REQUESTED,
    });
  }

  protected async hasAccess(emailNormalized: string): Promise<boolean> {
    return (
      (await this.prisma.trustedContact.count({
        where: activeRelationship(emailNormalized),
        take: 1,
      })) > 0
    );
  }
}
