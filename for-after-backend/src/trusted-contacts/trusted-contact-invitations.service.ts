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
import {
  trustedContactInvitation,
  trustedContactInvitationSms,
} from '../email/email-templates.js';
import { EmailConfig } from '../email/email.module.js';
import {
  AuditActorType,
  AuditEventType,
  type Prisma,
  TrustedContactInvitationStatus as Stored,
} from '../generated/prisma/client.js';
import { positiveInt } from '../media/media.service.js';
import { errorCode, PrismaService } from '../prisma/prisma.service.js';
import { maskMobile } from '../recipients/dto/create-recipient.dto.js';
import { SmsSender } from '../sms/sms-sender.js';

// Same scheme as AuthTokensService: a 256-bit token needs no slow hash; the
// unique index on the SHA-256 does the lookup.
const sha256 = (token: string) =>
  createHash('sha256').update(token).digest('hex');

// Per Trusted Contact, counted from the invitation rows (like AuthTokens).
const SENDS_PER_HOUR = 3;
// SMS costs money: also per Customer across all their contacts, removed ones
// included, so add-text-remove cycles cannot turn this into an SMS relay.
export const SMS_SENDS_PER_CUSTOMER_PER_DAY = 6;

export type InvitationChannel = 'EMAIL' | 'SMS';

export const INVITATION_NOT_FOUND = 'This invitation link is invalid.';
export const NO_EMAIL =
  'This trusted contact has no email address. Add one, or send the invitation by SMS.';
export const NO_MOBILE =
  'This trusted contact has no mobile number. Add one, or send the invitation by email.';
export const ALREADY_ACCEPTED = 'This invitation has already been accepted.';
export const SEND_CAPPED =
  'Too many invitations sent to this trusted contact. Please try again later.';
export const SEND_FAILED =
  "We couldn't send the invitation just now. Please try again.";

/**
 * What the Customer sees per Trusted Contact. EXPIRED is a PENDING row past
 * expiresAt. NOT_SENT: never sent, the send failed, or the address it was sent
 * to (email or mobile) changed since. Every contact has an email or a mobile
 * (CHECK constraint), so one channel is always available.
 */
export type InvitationState =
  'PENDING' | 'ACCEPTED' | 'DECLINED' | 'EXPIRED' | 'NOT_SENT';

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
    mobile: true,
    expiresAt: true,
    acceptedAt: true,
    createdAt: true,
  },
} satisfies Prisma.TrustedContact$invitationsArgs;

type InvitationRow = {
  status: Stored;
  emailNormalized: string | null;
  mobile: string | null;
  expiresAt: Date;
  acceptedAt?: Date | null;
  createdAt: Date;
};

type ContactAddresses = { email: string | null; mobile: string | null };

/** The link still points at the contact's current address for its channel. */
const sentToCurrent = (
  contact: ContactAddresses,
  row: Pick<InvitationRow, 'emailNormalized' | 'mobile'>,
) =>
  row.mobile
    ? row.mobile === contact.mobile
    : row.emailNormalized === contact.email;

export const invitationState = (
  contact: ContactAddresses,
  latest: InvitationRow | undefined,
  now = new Date(),
): {
  status: InvitationState;
  sentAt: Date | null;
  channel: InvitationChannel | null;
} => {
  if (
    !latest ||
    latest.status === Stored.CANCELLED ||
    !sentToCurrent(contact, latest)
  ) {
    return { status: 'NOT_SENT', sentAt: null, channel: null };
  }
  const expired = latest.status === Stored.PENDING && latest.expiresAt <= now;
  return {
    status: expired ? 'EXPIRED' : latest.status,
    sentAt: latest.createdAt,
    channel: latest.mobile ? 'SMS' : 'EMAIL',
  };
};

/**
 * Trusted Contact readiness (setup health), derived on every read from the
 * newest invitation, never stored. READY = they accepted an invitation sent to
 * their current email or mobile (the token proves the inbox or phone, so there
 * is no separate check). It says nothing about death reports or verification,
 * and changing that address resets it (the old invitation no longer matches).
 * The single definition: the Customer API and the readiness score use it.
 */
export type ReadinessStatus = 'READY' | 'INVITATION_PENDING' | 'INVITATION_EXPIRED' | 'ACTION_NEEDED';
export type TrustedContactReadiness = {
  status: ReadinessStatus;
  /** ACTION_NEEDED only: nothing (successfully) sent, or declined. */
  reason: 'NOT_SENT' | 'DECLINED' | null;
  invitationSentAt: Date | null;
  invitationAcceptedAt: Date | null;
};

export const trustedContactReadiness = (
  contact: ContactAddresses,
  latest: InvitationRow | undefined,
  now = new Date(),
): TrustedContactReadiness => {
  const { status, sentAt } = invitationState(contact, latest, now);
  const base = { invitationSentAt: sentAt, invitationAcceptedAt: null, reason: null };
  switch (status) {
    case 'ACCEPTED':
      return { ...base, status: 'READY', invitationAcceptedAt: latest?.acceptedAt ?? null };
    case 'PENDING':
      return { ...base, status: 'INVITATION_PENDING' };
    case 'EXPIRED':
      return { ...base, status: 'INVITATION_EXPIRED' };
    case 'DECLINED':
      return { ...base, status: 'ACTION_NEEDED', reason: 'DECLINED' };
    case 'NOT_SENT':
      return { ...base, status: 'ACTION_NEEDED', reason: 'NOT_SENT' };
  }
};

const displayName = (u: {
  firstName: string | null;
  lastName: string | null;
}) =>
  [u.firstName, u.lastName].filter(Boolean).join(' ') || 'A For After member';

type RequestMeta = { ip?: string; userAgent?: string };

/**
 * Phase 10: invitations to Trusted Contacts, by email or (2026-10-17) SMS: one
 * model, one token scheme, one invitation page; the Customer picks the channel
 * per send. Accepting records consent only: it creates no session and grants
 * nothing (sign-in stays email or SMS OTP, re-checked against the live
 * TrustedContact row on every request). Sent straight through EmailProvider /
 * SmsSender, never queued, so the raw token never sits in Redis job data (same
 * rule as AuthTokensService).
 */
@Injectable()
export class TrustedContactInvitationsService {
  private readonly logger = new Logger(TrustedContactInvitationsService.name);
  // Technical default: 7 days (no product-approved TTL exists).
  readonly ttlSeconds: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailProvider,
    private readonly sms: SmsSender,
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
   * Contact by email or SMS (never both, never a fallback: the channel's
   * address must exist, else 409). Any PENDING invitation is cancelled in the
   * same transaction, so only the newest link works. Foreign/removed → 404.
   * Returns false if it could not be sent (the new link is cancelled).
   */
  async send(
    ownerUserId: string,
    trustedContactId: string,
    channel: InvitationChannel = 'EMAIL',
    meta: RequestMeta = {},
  ): Promise<boolean> {
    const now = new Date();
    const issued = await this.prisma.$transaction(async (tx) => {
      // Same lock as create/remove: serialises everything for this Customer.
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${ownerUserId}::uuid FOR UPDATE`;
      const contact = await tx.trustedContact.findFirst({
        where: { id: trustedContactId, ownerUserId, deletedAt: null },
        select: {
          firstName: true,
          email: true,
          mobile: true,
          invitations: latestInvitation,
          owner: { select: { firstName: true, lastName: true } },
        },
      });
      if (!contact) throw new NotFoundException('Trusted contact not found.');
      // The stored mobile is already validated E.164 (CreateTrustedContactDto).
      const destination =
        channel === 'SMS'
          ? { emailNormalized: null, mobile: contact.mobile }
          : { emailNormalized: contact.email, mobile: null };
      if (!destination.emailNormalized && !destination.mobile) {
        throw new ConflictException(channel === 'SMS' ? NO_MOBILE : NO_EMAIL);
      }
      if (
        invitationState(contact, contact.invitations[0], now).status ===
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
      const smsToday =
        channel === 'SMS'
          ? await tx.trustedContactInvitation.count({
              where: {
                mobile: { not: null },
                createdAt: { gt: new Date(now.getTime() - 86_400_000) },
                trustedContact: { ownerUserId },
              },
            })
          : 0;
      if (
        recent >= SENDS_PER_HOUR ||
        smsToday >= SMS_SENDS_PER_CUSTOMER_PER_DAY
      ) {
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
          ...destination,
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
      return {
        id,
        token,
        ...destination,
        name: displayName(contact.owner),
        contactName: contact.firstName,
      };
    });

    const { appBaseUrl } = this.emailConfig.settings;
    try {
      if (issued.mobile) {
        await this.sms.send({
          to: issued.mobile,
          body: trustedContactInvitationSms(
            appBaseUrl,
            issued.token,
            this.ttlSeconds,
          ),
        });
      } else {
        await this.email.send({
          kind: 'trusted-contact-invitation',
          to: issued.emailNormalized!,
          ...trustedContactInvitation(
            appBaseUrl,
            issued.token,
            issued.name,
            this.ttlSeconds,
            issued.contactName,
          ),
        });
      }
    } catch (err) {
      // An unsent link must not show as "Pending": cancel it; the Customer can retry.
      await this.prisma.trustedContactInvitation.updateMany({
        where: { id: issued.id, status: Stored.PENDING },
        data: { status: Stored.CANCELLED, cancelledAt: new Date() },
      });
      this.logger.error(
        `trusted_contact_invitation_failed trusted_contact ${trustedContactId} channel ${channel} (code: ${errorCode(err)})`,
      );
      return false;
    }
    this.logger.log(
      `trusted_contact_invitation_sent trusted_contact ${trustedContactId} channel ${channel} ${issued.mobile ? maskMobile(issued.mobile) : maskEmail(issued.emailNormalized!)}`,
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
        mobile: true,
        trustedContact: {
          select: {
            email: true,
            mobile: true,
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
      sentToCurrent(contact, row);
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
   * and while the relationship still exists with the address (email or
   * mobile) it was sent to. Identical for both channels.
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
        select: {
          id: true,
          trustedContactId: true,
          emailNormalized: true,
          mobile: true,
        },
      });
      if (!row) throw new NotFoundException(INVITATION_NOT_FOUND);
      const { count } = await tx.trustedContactInvitation.updateMany({
        where: {
          id: row.id,
          status: Stored.PENDING,
          expiresAt: { gt: now },
          trustedContact: {
            deletedAt: null,
            ...(row.mobile
              ? { mobile: row.mobile }
              : { email: row.emailNormalized }),
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
