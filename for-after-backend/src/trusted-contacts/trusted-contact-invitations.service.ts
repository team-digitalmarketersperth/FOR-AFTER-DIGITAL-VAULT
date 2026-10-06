import {
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'node:crypto';
import { writeAuditLog } from '../audit/audit-log.service.js';
import { maskEmail } from '../auth/dto/register.dto.js';
import { EmailProvider } from '../email/email-provider.js';
import { trustedContactInvitation } from '../email/email-templates.js';
import { EmailConfig } from '../email/email.module.js';
import {
  AuditActorType,
  AuditEventType,
  type Prisma,
  TrustedContactInvitationStatus as Stored,
} from '../generated/prisma/client.js';
import { positiveInt } from '../media/media.service.js';
import { errorCode, PrismaService } from '../prisma/prisma.service.js';

// Same scheme as AuthTokensService: a 256-bit token needs no slow hash; the
// unique index on the SHA-256 does the lookup.
const sha256 = (token: string) =>
  createHash('sha256').update(token).digest('hex');

// Per Trusted Contact, counted from the invitation rows (like AuthTokens).
const SENDS_PER_HOUR = 3;

export const INVITATION_NOT_FOUND = 'This invitation link is invalid.';
export const NO_EMAIL =
  'Invitations are sent by email. Add an email address to invite this trusted contact.';
export const ALREADY_ACCEPTED = 'This invitation has already been accepted.';
export const SEND_CAPPED =
  'Too many invitations sent to this trusted contact. Please try again later.';
export const SEND_FAILED =
  "We couldn't send the invitation just now. Please try again.";

/**
 * What the Customer sees per Trusted Contact. EXPIRED is a PENDING row past
 * expiresAt. NOT_SENT: never sent, the send failed, or the email changed since.
 * UNAVAILABLE: no email (SMS invitations are deferred).
 */
export type InvitationState =
  'PENDING' | 'ACCEPTED' | 'DECLINED' | 'EXPIRED' | 'NOT_SENT' | 'UNAVAILABLE';

/** What the invitee sees on the invitation page. CANCELLED: no longer valid. */
export type InvitationView = {
  status: 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'EXPIRED' | 'CANCELLED';
  // Null once the invitation is no longer valid.
  accountHolder: { displayName: string } | null;
};

/** The newest invitation, for TrustedContactsService's select. */
export const latestInvitation = {
  orderBy: { createdAt: 'desc' },
  take: 1,
  select: {
    status: true,
    emailNormalized: true,
    expiresAt: true,
    createdAt: true,
  },
} satisfies Prisma.TrustedContact$invitationsArgs;

type InvitationRow = {
  status: Stored;
  emailNormalized: string;
  expiresAt: Date;
  createdAt: Date;
};

export const invitationState = (
  email: string | null,
  latest: InvitationRow | undefined,
  now = new Date(),
): { status: InvitationState; sentAt: Date | null } => {
  if (!email) return { status: 'UNAVAILABLE', sentAt: null };
  if (
    !latest ||
    latest.status === Stored.CANCELLED ||
    latest.emailNormalized !== email
  ) {
    return { status: 'NOT_SENT', sentAt: null };
  }
  const expired = latest.status === Stored.PENDING && latest.expiresAt <= now;
  return {
    status: expired ? 'EXPIRED' : latest.status,
    sentAt: latest.createdAt,
  };
};

const displayName = (u: {
  firstName: string | null;
  lastName: string | null;
}) =>
  [u.firstName, u.lastName].filter(Boolean).join(' ') || 'A For After member';

type RequestMeta = { ip?: string; userAgent?: string };

/**
 * Phase 10: email invitations to Trusted Contacts. Accepting records consent
 * only: it creates no session and grants nothing (sign-in stays email OTP,
 * re-checked against the live TrustedContact row on every request). Sent
 * straight through EmailProvider, never queued, so the raw token never sits in
 * Redis job data (same rule as AuthTokensService).
 */
@Injectable()
export class TrustedContactInvitationsService {
  private readonly logger = new Logger(TrustedContactInvitationsService.name);
  // Technical default: 7 days (no product-approved TTL exists).
  readonly ttlSeconds: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailProvider,
    private readonly emailConfig: EmailConfig,
    config: ConfigService,
  ) {
    this.ttlSeconds = positiveInt(
      config,
      'TRUSTED_CONTACT_INVITATION_TTL_SECONDS',
      604_800,
    );
  }

  /**
   * Customer: send (or resend) the invitation for an owned, active Trusted
   * Contact with an email. Any PENDING invitation is cancelled in the same
   * transaction, so only the newest link works. Foreign/removed → 404.
   * Returns false if the email could not be sent (the new link is cancelled).
   */
  async send(
    ownerUserId: string,
    trustedContactId: string,
    meta: RequestMeta = {},
  ): Promise<boolean> {
    const now = new Date();
    const issued = await this.prisma.$transaction(async (tx) => {
      // Same lock as create/remove: serialises everything for this Customer.
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${ownerUserId}::uuid FOR UPDATE`;
      const contact = await tx.trustedContact.findFirst({
        where: { id: trustedContactId, ownerUserId, deletedAt: null },
        select: {
          email: true,
          invitations: latestInvitation,
          owner: { select: { firstName: true, lastName: true } },
        },
      });
      if (!contact) throw new NotFoundException('Trusted contact not found.');
      const { email } = contact;
      if (!email) throw new ConflictException(NO_EMAIL);
      if (
        invitationState(email, contact.invitations[0], now).status ===
        'ACCEPTED'
      ) {
        throw new ConflictException(ALREADY_ACCEPTED);
      }
      const recent = await tx.trustedContactInvitation.count({
        where: {
          trustedContactId,
          createdAt: { gt: new Date(now.getTime() - 3_600_000) },
        },
      });
      if (recent >= SENDS_PER_HOUR) {
        throw new HttpException(SEND_CAPPED, HttpStatus.TOO_MANY_REQUESTS);
      }
      await tx.trustedContactInvitation.updateMany({
        where: { trustedContactId, status: Stored.PENDING },
        data: { status: Stored.CANCELLED, cancelledAt: now },
      });
      const token = randomBytes(32).toString('base64url');
      const { id } = await tx.trustedContactInvitation.create({
        data: {
          trustedContactId,
          emailNormalized: email,
          tokenHash: sha256(token),
          expiresAt: new Date(now.getTime() + this.ttlSeconds * 1000),
        },
        select: { id: true },
      });
      await writeAuditLog(tx, {
        eventType: AuditEventType.TRUSTED_CONTACT_INVITATION_SENT,
        actor: { type: AuditActorType.CUSTOMER, userId: ownerUserId, ...meta },
        subjectType: 'TrustedContact',
        subjectId: trustedContactId,
      });
      return { id, token, email, name: displayName(contact.owner) };
    });

    try {
      await this.email.send({
        kind: 'trusted-contact-invitation',
        to: issued.email,
        ...trustedContactInvitation(
          this.emailConfig.settings.appBaseUrl,
          issued.token,
          issued.name,
          this.ttlSeconds,
        ),
      });
    } catch (err) {
      // An unsent link must not show as "Pending": cancel it; the Customer can retry.
      await this.prisma.trustedContactInvitation.updateMany({
        where: { id: issued.id, status: Stored.PENDING },
        data: { status: Stored.CANCELLED, cancelledAt: new Date() },
      });
      this.logger.error(
        `trusted_contact_invitation_failed trusted_contact ${trustedContactId} (code: ${errorCode(err)})`,
      );
      return false;
    }
    this.logger.log(
      `trusted_contact_invitation_sent trusted_contact ${trustedContactId} ${maskEmail(issued.email)}`,
    );
    return true;
  }

  /** Invitee: what the link is for. Unknown token → 404. */
  async view(token: string, now = new Date()): Promise<InvitationView> {
    const row = await this.prisma.trustedContactInvitation.findUnique({
      where: { tokenHash: sha256(token) },
      select: {
        status: true,
        expiresAt: true,
        emailNormalized: true,
        trustedContact: {
          select: {
            email: true,
            deletedAt: true,
            owner: {
              select: { firstName: true, lastName: true, deletedAt: true },
            },
          },
        },
      },
    });
    if (!row) throw new NotFoundException(INVITATION_NOT_FOUND);
    const contact = row.trustedContact;
    const live =
      row.status !== Stored.CANCELLED &&
      !contact.deletedAt &&
      !contact.owner.deletedAt &&
      contact.email === row.emailNormalized;
    if (!live) return { status: 'CANCELLED', accountHolder: null };
    const expired = row.status === Stored.PENDING && row.expiresAt <= now;
    if (expired) return { status: 'EXPIRED', accountHolder: null };
    return {
      status: row.status,
      accountHolder: { displayName: displayName(contact.owner) },
    };
  }

  /**
   * Invitee: PENDING → ACCEPTED or DECLINED, atomically (one conditional
   * update: exactly one answer wins, however many race). Only while unexpired
   * and while the relationship still exists with the address it was sent to.
   * Returns the resulting view; a lost race just shows the current state.
   */
  async respond(
    token: string,
    answer: 'ACCEPTED' | 'DECLINED',
    meta: RequestMeta = {},
  ): Promise<InvitationView> {
    const now = new Date();
    const answered = await this.prisma.$transaction(async (tx) => {
      const row = await tx.trustedContactInvitation.findUnique({
        where: { tokenHash: sha256(token) },
        select: { id: true, trustedContactId: true, emailNormalized: true },
      });
      if (!row) throw new NotFoundException(INVITATION_NOT_FOUND);
      const { count } = await tx.trustedContactInvitation.updateMany({
        where: {
          id: row.id,
          status: Stored.PENDING,
          expiresAt: { gt: now },
          trustedContact: {
            deletedAt: null,
            email: row.emailNormalized,
            owner: { deletedAt: null },
          },
        },
        data:
          answer === 'ACCEPTED'
            ? { status: Stored.ACCEPTED, acceptedAt: now }
            : { status: Stored.DECLINED, declinedAt: now },
      });
      if (!count) return null;
      await writeAuditLog(tx, {
        eventType:
          answer === 'ACCEPTED'
            ? AuditEventType.TRUSTED_CONTACT_INVITATION_ACCEPTED
            : AuditEventType.TRUSTED_CONTACT_INVITATION_DECLINED,
        actor: { type: AuditActorType.TRUSTED_CONTACT, userId: null, ...meta },
        subjectType: 'TrustedContact',
        subjectId: row.trustedContactId,
      });
      return row.trustedContactId;
    });
    if (answered) {
      this.logger.log(
        `trusted_contact_invitation_${answer.toLowerCase()} trusted_contact ${answered}`,
      );
    }
    return this.view(token, now);
  }
}
