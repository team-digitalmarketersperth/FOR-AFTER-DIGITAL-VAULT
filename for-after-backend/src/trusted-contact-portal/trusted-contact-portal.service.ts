import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { DeathVerificationCaseStatus } from '../generated/prisma/client.js';
import type { Reporter } from '../death-verification/death-verification.service.js';
import { maskPrincipal } from '../otp-auth/otp-auth.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  activeRelationship,
  type TrustedContactPrincipal,
} from '../trusted-contact-auth/trusted-contact-auth.service.js';

// Same message for missing, deleted and someone else's relationship: never
// 403, which would confirm the id exists.
export const ACCOUNT_NOT_FOUND = 'Account not found.';

export type TrustedAccount = {
  trustedContactId: string;
  accountHolder: { displayName: string };
  relationship: string | null;
  hasPreservedContent: boolean;
  deathVerificationStatus: DeathVerificationCaseStatus | null;
};

// Existence probe only: at most one id per content type, never a count.
const anyActive = { where: { deletedAt: null }, select: { id: true }, take: 1 };

/**
 * What a signed-in Trusted Contact may see: the Customers who currently list
 * their email (or mobile, after SMS sign-in), a display name, a content-exists flag and the case status.
 * Never the Customer's email/mobile, recipients or any content.
 */
@Injectable()
export class TrustedContactPortalService {
  private readonly logger = new Logger(TrustedContactPortalService.name);

  constructor(private readonly prisma: PrismaService) {}

  async findAccounts(
    contact: TrustedContactPrincipal,
  ): Promise<TrustedAccount[]> {
    const rows = await this.prisma.trustedContact.findMany({
      where: activeRelationship(contact),
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        relationship: true,
        owner: {
          select: {
            firstName: true,
            lastName: true,
            messages: anyActive,
            memoryVaultItems: anyActive,
            myStoryResponses: anyActive,
            myWishResponses: anyActive,
            // The current (newest) case only.
            deathVerificationCases: {
              orderBy: [{ openedAt: 'desc' }, { id: 'desc' }],
              take: 1,
              select: { status: true },
            },
          },
        },
      },
    });
    this.logger.log(
      `trusted_contact_accounts_viewed ${maskPrincipal(contact)} accounts ${rows.length}`,
    );
    return rows.map(({ id, relationship, owner }) => ({
      trustedContactId: id,
      accountHolder: {
        displayName:
          [owner.firstName, owner.lastName].filter(Boolean).join(' ') ||
          'Account holder',
      },
      relationship,
      hasPreservedContent:
        owner.messages.length +
          owner.memoryVaultItems.length +
          owner.myStoryResponses.length +
          owner.myWishResponses.length >
        0,
      deathVerificationStatus: owner.deathVerificationCases[0]?.status ?? null,
    }));
  }

  /** The route's relationship, only if it belongs to the signed-in contact. */
  async findRelationship(
    contact: TrustedContactPrincipal,
    trustedContactId: string,
  ): Promise<Reporter> {
    const row = await this.prisma.trustedContact.findFirst({
      where: { id: trustedContactId, ...activeRelationship(contact) },
      select: {
        id: true,
        ownerUserId: true,
        firstName: true,
        lastName: true,
        email: true,
        mobile: true,
      },
    });
    if (!row) throw new NotFoundException(ACCOUNT_NOT_FOUND);
    return row;
  }
}
