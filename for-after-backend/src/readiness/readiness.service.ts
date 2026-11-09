import { Injectable } from '@nestjs/common';
import { MediaAssetStatus, MessageStatus } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  latestInvitation,
  trustedContactReadiness,
} from '../trusted-contacts/trusted-contact-invitations.service.js';

export type ReadinessStep =
  | { key: 'PEOPLE'; complete: boolean; people: number }
  | { key: 'TRUSTED_CONTACTS'; complete: boolean; trustedContacts: number; ready: number }
  | { key: 'PRESERVED'; complete: boolean; messages: number; memories: number; storyAnswers: number }
  | { key: 'SCHEDULING'; complete: boolean; messages: number; needsScheduling: number }
  | { key: 'WISHES'; complete: boolean; wishes: number };

export type Readiness = {
  /** 0–100, 20 per complete step. */
  score: number;
  completedSteps: number;
  totalSteps: number;
  steps: ReadinessStep[];
};

/** A live message with no timing chosen yet (readiness and the attention list share this). */
export const NEEDS_TIMING = MessageStatus.DRAFT;

// Content counts as preserved when it has words or at least one finished file.
const hasContent = {
  deletedAt: null,
  OR: [
    { textContent: { not: null } },
    { mediaAssets: { some: { deletedAt: null, status: MediaAssetStatus.READY } } },
  ],
};

/**
 * "How ready is my For After space?" Five setup steps, 20 points each, all
 * derived from the Customer's own rows with count/exists queries (never
 * content, names, emails or files). Nothing is stored. Wording is the
 * frontend's; this only says what is done and how much.
 */
@Injectable()
export class ReadinessService {
  constructor(private readonly prisma: PrismaService) {}

  async getForUser(ownerUserId: string): Promise<Readiness> {
    const own = { ownerUserId };
    const [people, contacts, byStatus, memories, storyAnswers, wishes] =
      await this.prisma.$transaction([
        this.prisma.recipient.count({ where: { ...own, deletedAt: null } }),
        // At most two rows; only the invitation state is read (no email returned).
        this.prisma.trustedContact.findMany({
          where: { ...own, deletedAt: null },
          select: { email: true, mobile: true, invitations: latestInvitation },
        }),
        this.prisma.message.groupBy({
          by: ['status'],
          where: { ...own, deletedAt: null },
          _count: { _all: true },
          orderBy: { status: 'asc' },
        }),
        this.prisma.memoryVaultItem.count({ where: { ...own, deletedAt: null } }),
        this.prisma.myStoryResponse.count({ where: { ...own, ...hasContent } }),
        this.prisma.myWishResponse.count({ where: { ...own, ...hasContent } }),
      ]);

    // Complete once at least one contact is READY (approved 2026-10-14): the
    // same definition the Trusted Contacts page shows. Who may sign in or
    // report is unchanged (docs/trusted-contact-auth.md).
    const trustedContacts = contacts.length;
    const ready = contacts.filter((c) => trustedContactReadiness(c, c.invitations[0]).status === 'READY').length;
    const count = (status: MessageStatus) =>
      (byStatus.find((g) => g.status === status)?._count as { _all: number } | undefined)?._all ?? 0;
    // RELEASED and SCHEDULED already have their timing; CANCELLED is past it.
    const messages = byStatus.reduce((n, g) => n + (g._count as { _all: number })._all, 0);
    const needsScheduling = count(NEEDS_TIMING);

    const steps: ReadinessStep[] = [
      { key: 'PEOPLE', complete: people > 0, people },
      { key: 'TRUSTED_CONTACTS', complete: ready > 0, trustedContacts, ready },
      {
        key: 'PRESERVED',
        complete: messages + memories + storyAnswers > 0,
        messages,
        memories,
        storyAnswers,
      },
      { key: 'SCHEDULING', complete: messages > 0 && needsScheduling === 0, messages, needsScheduling },
      { key: 'WISHES', complete: wishes > 0, wishes },
    ];
    const completedSteps = steps.filter((s) => s.complete).length;
    return {
      score: completedSteps * 20,
      completedSteps,
      totalSteps: steps.length,
      steps,
    };
  }
}
