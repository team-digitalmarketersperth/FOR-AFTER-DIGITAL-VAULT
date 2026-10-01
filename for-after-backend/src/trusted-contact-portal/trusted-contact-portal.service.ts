import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { maskEmail } from '../auth/dto/register.dto.js';
import type { DeathVerificationCaseStatus } from '../generated/prisma/client.js';
import type { Reporter } from '../death-verification/death-verification.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { activeRelationship } from '../trusted-contact-auth/trusted-contact-auth.service.js';

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
 * their email, a display name, a content-exists flag and the case status.
 * Never the Customer's email/mobile, recipients or any content.
 */
@Injectable()
export class TrustedContactPortalService {
  private readonly logger = new Logger(TrustedContactPortalService.name);

  constructor(private readonly prisma: PrismaService) {}

  async findAccounts(emailNormalized: string): Promise<TrustedAccount[]> {
    const rows = await this.prisma.trustedContact.findMany({
      where: activeRelationship(emailNormalized),
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
            deathVerificationCase: { select: { status: true } },
          },
        },
      },
    });
    this.logger.log(
      `trusted_contact_accounts_viewed ${maskEmail(emailNormalized)} accounts ${rows.length}`,
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
      deathVerificationStatus: owner.deathVerificationCase?.status ?? null,
    }));
  }

  /** The route's relationship, only if it belongs to the signed-in email. */
  async findRelationship(
    emailNormalized: string,
    trustedContactId: string,
  ): Promise<Reporter> {
    const row = await this.prisma.trustedContact.findFirst({
      where: { id: trustedContactId, ...activeRelationship(emailNormalized) },
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
