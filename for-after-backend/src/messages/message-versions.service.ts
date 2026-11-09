import { Injectable, NotFoundException } from '@nestjs/common';
import { recordActivity } from '../activity/customer-activity.js';
import { paginate } from '../audit/audit-log.service.js';
import { MessageVersionReason } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  contentOf,
  lockOwnedDraft,
  recordVersion,
  sameContent,
} from './message-versions.js';
import { type MessageResponse, messageSelect, toResponse } from './messages.service.js';

// Same message whether the message or version is missing or someone else's.
const NOT_FOUND = 'Version not found.';

const summarySelect = { id: true, version: true, reason: true, createdAt: true } as const;

/**
 * A Message's version history, owner-only. Ownership is part of every query
 * (through the message), never checked after fetching by id. Lists carry
 * metadata only; content is read one version at a time.
 */
@Injectable()
export class MessageVersionsService {
  constructor(private readonly prisma: PrismaService) {}

  private owned(ownerUserId: string, messageId: string) {
    return { messageId, message: { ownerUserId, deletedAt: null } };
  }

  async list(ownerUserId: string, messageId: string, page: number, limit: number) {
    const where = this.owned(ownerUserId, messageId);
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.messageVersion.count({ where }),
      this.prisma.messageVersion.findMany({
        where,
        orderBy: { version: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: summarySelect,
      }),
    ]);
    // No versions yet is fine for an owned message (created before history); 404 otherwise.
    if (!total) await this.assertMessage(ownerUserId, messageId);
    return {
      // Versions are 1..total with no gaps (never deleted), so the newest is `total`.
      items: rows.map((r) => ({ ...r, isCurrent: r.version === total })),
      pagination: paginate(page, limit, total),
    };
  }

  async get(ownerUserId: string, messageId: string, versionId: string) {
    const where = this.owned(ownerUserId, messageId);
    const [row, total] = await this.prisma.$transaction([
      this.prisma.messageVersion.findFirst({
        where: { ...where, id: versionId },
        select: { ...summarySelect, title: true, contentType: true, textContent: true },
      }),
      this.prisma.messageVersion.count({ where }),
    ]);
    if (!row) throw new NotFoundException(NOT_FOUND);
    return { ...row, isCurrent: row.version === total };
  }

  /**
   * DRAFT only (409 otherwise: unschedule first; released content is never
   * replaced). Under the message row lock: the current content is kept in
   * history (recordVersion), the version's title/type/text become current,
   * and the restore is itself a new version. Media, recipients and schedule
   * are untouched; nothing is queued or released.
   */
  async restore(
    ownerUserId: string,
    messageId: string,
    versionId: string,
  ): Promise<MessageResponse> {
    return this.prisma.$transaction(async (tx) => {
      const before = await lockOwnedDraft(tx, ownerUserId, messageId);
      const target = await tx.messageVersion.findFirst({
        where: { id: versionId, messageId },
        select: { title: true, contentType: true, textContent: true },
      });
      if (!target) throw new NotFoundException(NOT_FOUND);
      if (!sameContent(before, target)) {
        await tx.message.update({ where: { id: messageId }, data: contentOf(target) });
        await recordVersion(tx, messageId, before, target, MessageVersionReason.RESTORED);
        await recordActivity(tx, {
          userId: ownerUserId,
          type: 'MESSAGE_VERSION_RESTORED',
          entityId: messageId,
        });
      }
      // Any autosave was based on the content just replaced.
      await tx.draftRecovery.deleteMany({
        where: { userId: ownerUserId, type: 'MESSAGE', key: messageId },
      });
      return toResponse(
        await tx.message.findUniqueOrThrow({ where: { id: messageId }, select: messageSelect }),
      );
    });
  }

  private async assertMessage(ownerUserId: string, id: string) {
    const n = await this.prisma.message.count({ where: { id, ownerUserId, deletedAt: null } });
    if (!n) throw new NotFoundException(NOT_FOUND);
  }
}
