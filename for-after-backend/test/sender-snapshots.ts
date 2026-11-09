import { senderDisplayName } from '../src/message-release/message-release.service.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';

/**
 * Phase 18: every access grant of these Customers' Messages, with the trigger
 * that released it, its sender snapshot and the owner's name now. Suites that
 * never rename a Customer expect snapshot === current on every grant.
 */
export async function senderSnapshots(prisma: PrismaService, ownerEmails: string[]) {
  const grants = await prisma.recipientMessageAccessGrant.findMany({
    where: { message: { owner: { email: { in: ownerEmails } } } },
    select: {
      senderDisplayNameSnapshot: true,
      messageRelease: { select: { triggerType: true } },
      message: { select: { owner: { select: { firstName: true, lastName: true } } } },
    },
  });
  return grants.map((g) => ({
    trigger: g.messageRelease.triggerType,
    snapshot: g.senderDisplayNameSnapshot,
    current: senderDisplayName(g.message.owner),
  }));
}
