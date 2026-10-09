import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { maskEmail } from '../auth/dto/register.dto.js';
import {
  MediaAssetStatus,
  MediaKind,
  MessageContentType,
  Prisma,
} from '../generated/prisma/client.js';
import {
  type AccessUrlResponse,
  expiresAt,
  mediaSettings,
} from '../media/media.service.js';
import { MediaStorage } from '../media/storage/media-storage.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { eligibleGrant } from '../recipient-auth/recipient-auth.service.js';

// READY, live PHOTO/AUDIO only; VIDEO stays unsupported.
const visibleMedia = {
  status: MediaAssetStatus.READY,
  deletedAt: null,
  kind: { in: [MediaKind.PHOTO, MediaKind.AUDIO, MediaKind.VIDEO] },
} satisfies Prisma.MediaAssetWhereInput;

// Released content only. Never ownerUserId, schedule, status, deletedAt,
// other recipients, grant ids or anything about the sender's account.
const messageSelect = {
  id: true,
  title: true,
  contentType: true,
  textContent: true,
  _count: { select: { mediaAssets: { where: visibleMedia } } },
} satisfies Prisma.MessageSelect;

// storageKey, ownerUserId, messageId and deletedAt never leave the API.
const recipientMediaSelect = {
  id: true,
  kind: true,
  originalFileName: true,
  mimeType: true,
  sizeBytes: true,
  uploadedAt: true,
} satisfies Prisma.MediaAssetSelect;

export type RecipientMessageSummary = {
  id: string;
  title: string;
  contentType: MessageContentType;
  releasedAt: Date;
  hasMedia: boolean;
};
export type RecipientMessageDetail = RecipientMessageSummary & {
  textContent: string | null;
};
export type RecipientMediaResponse = Prisma.MediaAssetGetPayload<{
  select: typeof recipientMediaSelect;
}>;

// 404 for missing, draft, scheduled, deleted and someone else's alike: a 403
// would confirm another person's released content exists.
const NOT_FOUND = 'Message not found.';
const MEDIA_NOT_FOUND = 'Media not found.';

/**
 * Read-only access to released Messages for an authenticated Recipient.
 * Authorization is always an eligible RecipientMessageAccessGrant for the
 * session's verified email, re-checked in PostgreSQL on every request; ids
 * from the URL are only ever looked up inside that grant.
 */
@Injectable()
export class RecipientMessagesService {
  private readonly logger = new Logger(RecipientMessagesService.name);
  private readonly accessTtl: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: MediaStorage,
    config: ConfigService,
  ) {
    this.accessTtl = mediaSettings(config).accessTtl;
  }

  // Newest release first. The same email may hold grants from several
  // Customers (expected) or twice for one Message (shown once).
  // ponytail: unpaginated; add take/cursor if a Recipient gets hundreds.
  async findAll(email: string): Promise<RecipientMessageSummary[]> {
    const grants = await this.prisma.recipientMessageAccessGrant.findMany({
      where: eligibleGrant(email),
      orderBy: [
        { messageRelease: { releasedAt: 'desc' } },
        { messageId: 'asc' },
      ],
      select: {
        messageRelease: { select: { releasedAt: true } },
        message: { select: messageSelect },
      },
    });
    const seen = new Set<string>();
    return grants
      .filter(({ message }) => !seen.has(message.id) && seen.add(message.id))
      .map((grant) => {
        const { textContent: _omit, ...summary } = toDetail(grant);
        return summary;
      });
  }

  async findOne(
    email: string,
    messageId: string,
  ): Promise<RecipientMessageDetail> {
    return toDetail(await this.authorize(email, messageId));
  }

  async findMedia(
    email: string,
    messageId: string,
  ): Promise<RecipientMediaResponse[]> {
    await this.authorize(email, messageId);
    return this.prisma.mediaAsset.findMany({
      where: { messageId, ...visibleMedia },
      orderBy: { createdAt: 'asc' },
      select: recipientMediaSelect,
    });
  }

  // Signed only after the grant check. The URL is never stored or logged.
  async createMediaAccessUrl(
    email: string,
    messageId: string,
    id: string,
  ): Promise<AccessUrlResponse> {
    await this.authorize(email, messageId);
    const asset = await this.prisma.mediaAsset.findFirst({
      where: { id, messageId, ...visibleMedia },
      select: { storageKey: true, storageProvider: true, providerFileId: true },
    });
    if (!asset) throw new NotFoundException(MEDIA_NOT_FOUND);
    const url = await this.storage.createAccessUrl(asset, this.accessTtl);
    this.logger.log(
      `recipient_media_access_granted message ${messageId} media ${id}`,
    );
    return { url, expiresAt: expiresAt(this.accessTtl) };
  }

  private async authorize(email: string, messageId: string) {
    const grant = await this.prisma.recipientMessageAccessGrant.findFirst({
      where: { ...eligibleGrant(email), messageId },
      select: {
        messageRelease: { select: { releasedAt: true } },
        message: { select: messageSelect },
      },
    });
    const who = `${maskEmail(email)} message ${messageId}`;
    if (!grant) {
      this.logger.warn(`recipient_message_access_denied ${who}`);
      throw new NotFoundException(NOT_FOUND);
    }
    this.logger.log(`recipient_message_access_granted ${who}`);
    return grant;
  }
}

type GrantRow = {
  messageRelease: { releasedAt: Date };
  message: Prisma.MessageGetPayload<{ select: typeof messageSelect }>;
};

const toDetail = ({
  messageRelease,
  message: { _count, ...message },
}: GrantRow): RecipientMessageDetail => ({
  ...message,
  releasedAt: messageRelease.releasedAt,
  hasMedia: _count.mediaAssets > 0,
});
