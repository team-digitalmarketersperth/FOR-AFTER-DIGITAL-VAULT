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
import type { MyStoryPrompt } from './my-story.prompts.js';
import { RESPONSE_NOT_FOUND } from './my-story.service.js';

// Same message whether a file is missing, deleted, not READY, another
// answer's or another Customer's.
export const INVALID_STORY_MEDIA = 'One or more story files are invalid.';

/**
 * Phase 14B (approved policy): sharing a My Story answer = a new, independent
 * DRAFT Message made from the parts the Customer picks (MessageSnapshotService,
 * the same as Memory → Message). The answer stays private and is only read.
 * Its linked memories are never copied. Recipients, schedule and release are
 * the normal Message ones; one answer can make any number of messages.
 */
@Injectable()
export class StoryToMessageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly snapshot: MessageSnapshotService,
  ) {}

  async createMessage(
    ownerUserId: string,
    prompt: MyStoryPrompt,
    dto: CreateMessageFromContentDto,
  ): Promise<MessageResponse> {
    // Owner-scoped: someone else's answer or file looks like a missing one.
    const response = await this.prisma.myStoryResponse.findFirst({
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
      },
    });
    if (!response) throw new NotFoundException(RESPONSE_NOT_FOUND);
    if (response.mediaAssets.length !== dto.mediaAssetIds.length) {
      throw new BadRequestException(INVALID_STORY_MEDIA);
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
