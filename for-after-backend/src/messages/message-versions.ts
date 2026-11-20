import { ConflictException, NotFoundException } from '@nestjs/common';
import {
  MediaKind,
  MessageContentType,
  MessageStatus,
  MessageVersionReason,
  type Prisma,
} from '../generated/prisma/client.js';

// Version history (docs/message-composition.md, "Version history"): one
// immutable row per explicit save or restore that changed the written
// content. Never media, recipients or schedule; never autosave.

export type VersionedContent = {
  title: string;
  contentType: MessageContentType;
  textContent: string | null;
};

const MESSAGE_NOT_FOUND = 'Message not found.';
export const NOT_DRAFT = 'Only draft messages can be changed or deleted.';

export const sameContent = (a: VersionedContent, b: VersionedContent) =>
  a.title === b.title &&
  a.contentType === b.contentType &&
  a.textContent === b.textContent;

export const contentOf = ({
  title,
  contentType,
  textContent,
}: VersionedContent): VersionedContent => ({
  title,
  contentType,
  textContent,
});

/** Version 1, as a nested create on a new Message. */
export const firstVersion = (content: VersionedContent) => ({
  create: {
    version: 1,
    reason: MessageVersionReason.CREATED,
    ...contentOf(content),
  },
});

export type LockedMessage = VersionedContent & {
  status: MessageStatus;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Locks the owner's live message row for the rest of the transaction, so
 * saves, restores, media changes and scheduling on it run one at a time
 * (version numbers can't race). 404 if not theirs; 409 unless DRAFT.
 */
export async function lockOwnedDraft(
  tx: Prisma.TransactionClient,
  ownerUserId: string,
  id: string,
): Promise<LockedMessage> {
  const [row] = await tx.$queryRaw<LockedMessage[]>`
    SELECT title, "contentType", "textContent", status, "createdAt", "updatedAt"
    FROM "Message"
    WHERE id = ${id}::uuid AND "ownerUserId" = ${ownerUserId}::uuid AND "deletedAt" IS NULL
    FOR UPDATE`;
  if (!row) throw new NotFoundException(MESSAGE_NOT_FOUND);
  if (row.status !== MessageStatus.DRAFT) throw new ConflictException(NOT_DRAFT);
  return row;
}

/**
 * Trial Step 4: does this save or restore switch the message to a non-text format it doesn't already have? Only that is
 * paid-only; keeping the current format (text edits to an older photo message) or going to TEXT never is.
 */
export const isNewNonTextFormat = (next: MessageContentType | undefined, current: MessageContentType) =>
  next !== undefined && next !== MessageContentType.TEXT && next !== current;

/**
 * Updated Plans Step 4: the media a format itself requires. MIXED is 'any': it doesn't imply video (its actual files are
 * checked by kind when each is uploaded or copied), so a Premium MIXED message of photos and audio is allowed.
 */
export const formatMediaKinds = (format: MessageContentType): readonly MediaKind[] | 'any' =>
  format === MessageContentType.MIXED ? 'any' : format === MessageContentType.TEXT ? [] : [MediaKind[format]];

/**
 * Records `after` as the next version when this save changed the content.
 * The content it replaces is always kept: if it isn't the latest version (a
 * message from before version history has none), it is recorded first,
 * dated when it was last saved. Call under lockOwnedDraft.
 */
export async function recordVersion(
  tx: Prisma.TransactionClient,
  messageId: string,
  before: LockedMessage,
  after: VersionedContent,
  reason: MessageVersionReason,
): Promise<void> {
  if (sameContent(before, after)) return;
  const latest = await tx.messageVersion.findFirst({
    where: { messageId },
    orderBy: { version: 'desc' },
    select: { version: true, title: true, contentType: true, textContent: true },
  });
  let next = (latest?.version ?? 0) + 1;
  if (!latest || !sameContent(latest, before)) {
    // ponytail: "never edited" = updatedAt within 1 s of createdAt; media changes also touch updatedAt.
    const untouched = !latest && before.updatedAt.getTime() - before.createdAt.getTime() < 1000;
    await tx.messageVersion.create({
      data: {
        messageId,
        version: next++,
        reason: untouched ? MessageVersionReason.CREATED : MessageVersionReason.EDITED,
        createdAt: before.updatedAt,
        ...contentOf(before),
      },
    });
  }
  await tx.messageVersion.create({
    data: { messageId, version: next, reason, ...contentOf(after) },
  });
}
