import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import {
  MediaAssetStatus,
  MediaKind,
  MessageStatus,
} from '../generated/prisma/client.js';
import { MIME_TYPES } from '../media/dto/create-media-upload.dto.js';
import { MediaCleanup } from '../media/media-cleanup.service.js';
import {
  checkUpload,
  mediaKey,
  mediaSettings,
  storedRefSelect,
} from '../media/media.service.js';
import { MalwareScanner } from '../media/scanner/malware-scanner.service.js';
import { StorageQuota } from '../media/storage-quota.service.js';
import {
  MediaStorage,
  type StoredRef,
} from '../media/storage/media-storage.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { SupportedContentType } from './dto/create-message.dto.js';
import { type MessageResponse, MessagesService } from './messages.service.js';

/** A READY file of the source (memory, story answer) to copy into the message. */
export type SnapshotSource = StoredRef & {
  kind: MediaKind;
  mimeType: string;
  sizeBytes: number;
  originalFileName: string;
};

export type SnapshotDraft = {
  title: string;
  contentType: SupportedContentType;
  textContent: string | null;
  recipientIds: string[];
  // In the order the Customer picked them.
  media: SnapshotSource[];
};

/**
 * A new, independent DRAFT Message made from private content (a Memory Vault
 * item in Phase 13B, a My Story answer in Phase 14B): its own text and its
 * own copies of the chosen files. Nothing links back to the source, so either
 * side can be edited or deleted without affecting the other. Recipients,
 * scheduling and release are then the normal Message ones.
 */
@Injectable()
export class MessageSnapshotService {
  private readonly logger = new Logger(MessageSnapshotService.name);
  private readonly scanTimeoutMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: MediaStorage,
    private readonly scanner: MalwareScanner,
    private readonly cleanup: MediaCleanup,
    private readonly messages: MessagesService,
    private readonly quota: StorageQuota,
    config: ConfigService,
  ) {
    this.scanTimeoutMs = mediaSettings(config).scanTimeoutMs;
  }

  async create(
    ownerUserId: string,
    draft: SnapshotDraft,
  ): Promise<MessageResponse> {
    await this.messages.assertOwnedRecipients(ownerUserId, draft.recipientIds);

    // New rows at the normal message paths, ids only.
    const messageId = randomUUID();
    const now = Date.now();
    const copies = draft.media.map((source) => {
      const id = randomUUID();
      const types: Record<string, string> = MIME_TYPES[source.kind];
      return {
        source,
        row: {
          id,
          kind: source.kind,
          mimeType: source.mimeType,
          sizeBytes: source.sizeBytes,
          originalFileName: source.originalFileName,
          storageKey: mediaKey(
            ownerUserId,
            `messages/${messageId}`,
            source.kind,
            id,
            types[source.mimeType],
          ),
        },
      };
    });

    // One transaction: the draft, its recipients and a PENDING_UPLOAD row per
    // copy. Rows exist before any provider file, so nothing copied is ever
    // untracked: a crash mid-copy leaves PENDING rows that block scheduling
    // and that the stale-upload reconciler retires.
    await this.prisma.$transaction(async (tx) => {
      // Phase 12C: the copies are new storage, reserved like uploads.
      if (copies.length) {
        await this.quota.reserve(
          tx,
          ownerUserId,
          copies.reduce((sum, c) => sum + c.row.sizeBytes, 0),
        );
      }
      await tx.message.create({
        data: {
          id: messageId,
          ownerUserId,
          title: draft.title,
          contentType: draft.contentType,
          textContent: draft.textContent,
          status: MessageStatus.DRAFT,
          recipients: {
            create: draft.recipientIds.map((recipientId) => ({ recipientId })),
          },
          mediaAssets: {
            // Media lists are ordered by createdAt: 1 ms apart keeps the picked order.
            create: copies.map(({ row }, i) => ({
              ...row,
              ownerUserId,
              createdAt: new Date(now + i),
            })),
          },
        },
        select: { id: true },
      });
    });

    // ponytail: copies run in the request, one at a time; queue them if many large videos are copied.
    for (const copy of copies) await this.copyOne(copy);
    return this.messages.findOwnedById(ownerUserId, messageId);
  }

  /**
   * Copy, then the full upload check (provider, magic bytes, malware scan):
   * a copy is never trusted because its source was READY. Any failure marks
   * the copy FAILED (the draft stays a draft, the Customer removes it) and
   * removes the copied file through MediaCleanup. The source is never touched.
   */
  private async copyOne({
    source,
    row,
  }: {
    source: StoredRef;
    row: {
      id: string;
      storageKey: string;
      mimeType: string;
      sizeBytes: number;
    };
  }) {
    let fileId: string | null = null;
    try {
      fileId = await this.storage.copyObject(
        source,
        row.storageKey,
        AbortSignal.timeout(this.scanTimeoutMs),
      );
      const check = await checkUpload(
        this.storage,
        this.scanner,
        row,
        fileId,
        this.scanTimeoutMs,
      );
      if (check.status === 'ok') {
        // Still pending and live: the message was not deleted meanwhile.
        const { count } = await this.prisma.mediaAsset.updateMany({
          where: {
            id: row.id,
            status: MediaAssetStatus.PENDING_UPLOAD,
            deletedAt: null,
          },
          data: {
            status: MediaAssetStatus.READY,
            uploadedAt: new Date(),
            providerFileId: check.ref.providerFileId,
          },
        });
        if (count) return;
      }
    } catch {
      this.logger.warn(`Message media ${row.id} copy failed`);
    }
    const failed = await this.prisma.mediaAsset.update({
      where: { id: row.id },
      data: { status: MediaAssetStatus.FAILED, providerFileId: fileId },
      select: storedRefSelect,
    });
    await this.cleanup.purge('mediaAsset', [failed]);
  }
}
