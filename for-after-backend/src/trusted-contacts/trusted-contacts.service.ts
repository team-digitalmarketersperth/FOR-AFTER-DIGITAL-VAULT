import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  TrustedContactInvitationStatus,
} from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  type InvitationState,
  invitationState,
  latestInvitation,
  TrustedContactInvitationsService,
} from './trusted-contact-invitations.service.js';
import {
  CONTACT_METHOD_REQUIRED,
  CreateTrustedContactDto,
} from './dto/create-trusted-contact.dto.js';
import { UpdateTrustedContactDto } from './dto/update-trusted-contact.dto.js';

// ownerUserId and deletedAt never leave the API.
const trustedContactSelect = {
  id: true,
  firstName: true,
  lastName: true,
  relationship: true,
  email: true,
  mobile: true,
  createdAt: true,
  updatedAt: true,
  invitations: latestInvitation,
} satisfies Prisma.TrustedContactSelect;

type Row = Prisma.TrustedContactGetPayload<{
  select: typeof trustedContactSelect;
}>;

export type TrustedContactResponse = Omit<Row, 'invitations'> & {
  invitation: { status: InvitationState; sentAt: Date | null };
};

// Never the token, its hash or the address it was sent to.
const toResponse = ({ invitations, ...row }: Row): TrustedContactResponse => ({
  ...row,
  invitation: invitationState(row.email, invitations[0]),
});

/** Phase 10 product decision: at most two active Trusted Contacts per Customer. */
export const MAX_TRUSTED_CONTACTS = 2;
export const MAX_REACHED = `You can nominate up to ${MAX_TRUSTED_CONTACTS} trusted contacts. Remove one to add someone else.`;

// Same message whether the row is missing, deleted or someone else's.
const NOT_FOUND = 'Trusted contact not found.';

// Explicit field list, so nothing else from a request can reach the database.
const toData = (dto: UpdateTrustedContactDto) => ({
  firstName: dto.firstName,
  lastName: dto.lastName,
  relationship: dto.relationship,
  email: dto.email,
  mobile: dto.mobile,
});

@Injectable()
export class TrustedContactsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly invitations: TrustedContactInvitationsService,
  ) {}

  // Every read and write goes through this filter: ownership is part of the
  // query itself, never checked after fetching by id alone.
  private owned(ownerUserId: string, id: string) {
    return { id, ownerUserId, deletedAt: null };
  }

  /**
   * Count and insert under a lock on the Customer's User row, so concurrent
   * creates are serialised: a plain count-then-create could let two requests
   * both see one contact and end with three. Soft-deleted rows do not count.
   * With an email, the invitation is then sent (best effort: a failed send
   * leaves the contact with invitation NOT_SENT, and the Customer can resend).
   */
  async create(
    ownerUserId: string,
    dto: CreateTrustedContactDto,
    meta?: { ip?: string; userAgent?: string },
  ): Promise<TrustedContactResponse> {
    const { id } = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${ownerUserId}::uuid FOR UPDATE`;
      const active = await tx.trustedContact.count({
        where: { ownerUserId, deletedAt: null },
      });
      if (active >= MAX_TRUSTED_CONTACTS) {
        throw new ConflictException(MAX_REACHED);
      }
      return tx.trustedContact.create({
        data: { ...toData(dto), firstName: dto.firstName, ownerUserId },
        select: { id: true },
      });
    });
    if (dto.email) await this.invitations.send(ownerUserId, id, meta);
    return this.findOwnedById(ownerUserId, id);
  }

  async findAllForOwner(
    ownerUserId: string,
  ): Promise<TrustedContactResponse[]> {
    const rows = await this.prisma.trustedContact.findMany({
      where: { ownerUserId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      select: trustedContactSelect,
    });
    return rows.map(toResponse);
  }

  async findOwnedById(
    ownerUserId: string,
    id: string,
  ): Promise<TrustedContactResponse> {
    const row = await this.prisma.trustedContact.findFirst({
      where: this.owned(ownerUserId, id),
      select: trustedContactSelect,
    });
    if (!row) throw new NotFoundException(NOT_FOUND);
    return toResponse(row);
  }

  // At least one contact method must remain. Clearing one is only allowed
  // while the other is set, and that condition is part of the same UPDATE,
  // so a concurrent PATCH cannot slip in between check and write. The
  // database CHECK constraint is the final backstop.
  async update(
    ownerUserId: string,
    id: string,
    dto: UpdateTrustedContactDto,
  ): Promise<TrustedContactResponse> {
    const clearsEmail = dto.email === null && dto.mobile == null;
    const clearsMobile = dto.mobile === null && dto.email == null;
    if (clearsEmail && clearsMobile) {
      throw new BadRequestException(CONTACT_METHOD_REQUIRED);
    }
    const keepsContactMethod = clearsEmail
      ? { mobile: { not: null } }
      : clearsMobile
        ? { email: { not: null } }
        : undefined;
    return this.updateOwned(ownerUserId, id, toData(dto), keepsContactMethod);
  }

  // Soft delete: death reports keep referencing the row. A pending invitation
  // is cancelled with it (acceptance also re-checks deletedAt).
  async remove(ownerUserId: string, id: string): Promise<void> {
    const now = new Date();
    await this.updateOwned(ownerUserId, id, {
      deletedAt: now,
      invitations: {
        updateMany: {
          where: { status: TrustedContactInvitationStatus.PENDING },
          data: {
            status: TrustedContactInvitationStatus.CANCELLED,
            cancelledAt: now,
          },
        },
      },
    });
  }

  private async updateOwned(
    ownerUserId: string,
    id: string,
    data: Prisma.TrustedContactUpdateInput,
    keepsContactMethod?: Pick<
      Prisma.TrustedContactWhereInput,
      'email' | 'mobile'
    >,
  ): Promise<TrustedContactResponse> {
    try {
      return toResponse(
        await this.prisma.trustedContact.update({
          where: { ...this.owned(ownerUserId, id), ...keepsContactMethod },
          data,
          select: trustedContactSelect,
        }),
      );
    } catch (err) {
      if (
        !(err instanceof Prisma.PrismaClientKnownRequestError) ||
        err.code !== 'P2025'
      ) {
        throw err;
      }
      // No row matched: tell "exists but would lose its last contact method"
      // (400) apart from "not yours / missing / deleted" (404).
      const exists =
        keepsContactMethod &&
        (await this.prisma.trustedContact.count({
          where: this.owned(ownerUserId, id),
        }));
      throw exists
        ? new BadRequestException(CONTACT_METHOD_REQUIRED)
        : new NotFoundException(NOT_FOUND);
    }
  }
}
