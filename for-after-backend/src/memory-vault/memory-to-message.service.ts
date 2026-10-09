import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { MediaAssetStatus } from '../generated/prisma/client.js';
import { storedRefSelect } from '../media/media.service.js';
import { MessageSnapshotService } from '../messages/message-snapshot.service.js';
import type { MessageResponse } from '../messages/messages.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { CreateMessageFromMemoryDto } from './dto/create-message-from-memory.dto.js';
import { MEMORY_NOT_FOUND } from './memory-vault.service.js';

// Same message whether a file is missing, deleted, not READY, another
// memory's or another Customer's.
export const INVALID_MEMORY_MEDIA = 'One or more memory files are invalid.';

// The copyable fields of a READY source file (shared with My Story).
export const snapshotSourceSelect = {
  kind: true,
  mimeType: true,
  sizeBytes: true,
  originalFileName: true,
  ...storedRefSelect,
} as const;

/**
 * Phase 13B: "sharing" a memory = a new, independent DRAFT Message made from
 * it (MessageSnapshotService). The memory stays private and is only read,
 * never changed; one memory can make any number of messages.
 */
@Injectable()
export class MemoryToMessageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly snapshot: MessageSnapshotService,
  ) {}

  async createMessage(
    ownerUserId: string,
    memoryId: string,
    dto: CreateMessageFromMemoryDto,
  ): Promise<MessageResponse> {
    // Owner-scoped like every memory read: someone else's memory or file is
    // indistinguishable from a missing one.
    const memory = await this.prisma.memoryVaultItem.findFirst({
      where: { id: memoryId, ownerUserId, deletedAt: null },
      select: {
        textContent: true,
        mediaAssets: {
          where: {
            id: { in: dto.mediaAssetIds },
            deletedAt: null,
            status: MediaAssetStatus.READY,
          },
          select: snapshotSourceSelect,
        },
      },
    });
    if (!memory) throw new NotFoundException(MEMORY_NOT_FOUND);
    if (memory.mediaAssets.length !== dto.mediaAssetIds.length) {
      throw new BadRequestException(INVALID_MEMORY_MEDIA);
    }
    return this.snapshot.create(ownerUserId, {
      title: dto.title,
      contentType: dto.contentType,
      textContent: dto.includeText ? memory.textContent : null,
      recipientIds: dto.recipientIds,
      media: dto.mediaAssetIds.map((id) =>
        memory.mediaAssets.find((m) => m.id === id)!,
      ),
    });
  }
}
