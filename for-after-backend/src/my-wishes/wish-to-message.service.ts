import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { MediaAssetStatus } from '../generated/prisma/client.js';
import { snapshotSourceSelect } from '../memory-vault/memory-to-message.service.js';
import { CreateMessageFromContentDto } from '../messages/dto/create-message-from-content.dto.js';
import { MessageSnapshotService } from '../messages/message-snapshot.service.js';
import type { MessageResponse } from '../messages/messages.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { MyWishPrompt } from './my-wishes.prompts.js';
import { WISH_NOT_FOUND } from './my-wishes.service.js';

// Same message whether a file is missing, deleted, not READY, another
// wish's or another Customer's.
export const INVALID_WISH_MEDIA = 'One or more wish files are invalid.';

/**
 * Phase 15B (approved policy): sharing a wish = a new, independent DRAFT
 * Message made from the parts the Customer picks (MessageSnapshotService, the
 * same as Memory → Message and Story → Message). The wish stays private and
 * is only read. Recipients, schedule (ON_DEATH / AFTER_DEATH for after-death
 * sharing), verified-death release, grants and the Recipient Portal are the
 * normal Message ones; one wish can make any number of messages. Reading a
 * wish needs no notice acknowledgement (Phase 15A gates writing wishes only).
 */
@Injectable()
export class WishToMessageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly snapshot: MessageSnapshotService,
  ) {}

  async createMessage(
    ownerUserId: string,
    prompt: MyWishPrompt,
    dto: CreateMessageFromContentDto,
  ): Promise<MessageResponse> {
    // Owner-scoped: someone else's wish or file looks like a missing one.
    const response = await this.prisma.myWishResponse.findFirst({
      where: { ownerUserId, promptKey: prompt.key, deletedAt: null },
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
        _count: {
          select: {
            mediaAssets: {
              where: { deletedAt: null, status: MediaAssetStatus.READY },
            },
          },
        },
      },
    });
    // An upload shell (no text, no READY file) is not a wish yet.
    if (
      !response ||
      (!response.textContent?.trim() && !response._count.mediaAssets)
    ) {
      throw new NotFoundException(WISH_NOT_FOUND);
    }
    if (response.mediaAssets.length !== dto.mediaAssetIds.length) {
      throw new BadRequestException(INVALID_WISH_MEDIA);
    }
    return this.snapshot.create(ownerUserId, {
      title: dto.title,
      contentType: dto.contentType,
      textContent: dto.includeText ? response.textContent : null,
      recipientIds: dto.recipientIds,
      media: dto.mediaAssetIds.map((id) =>
        response.mediaAssets.find((m) => m.id === id)!,
      ),
    });
  }
}
