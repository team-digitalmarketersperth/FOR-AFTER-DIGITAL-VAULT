import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { maskPrincipal } from '../otp-auth/otp-auth.service.js';
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
import {
  grantFor,
  type RecipientPrincipal,
} from '../recipient-auth/recipient-auth.service.js';

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
  /**
   * Phase 18: who it is from, as snapshotted when this Recipient got access.
   * Display name only (never the Customer's email, mobile or id); null for
   * grants from before the snapshot existed or a Customer with no name.
   */
  senderDisplayName: string | null;
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
 * session's verified email or mobile, re-checked in PostgreSQL on every request; ids
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

  // Newest release first. The same email or mobile may hold grants from several
  // Customers (expected) or twice for one Message (shown once).
  // ponytail: unpaginated; add take/cursor if a Recipient gets hundreds.
  async findAll(recipient: RecipientPrincipal): Promise<RecipientMessageSummary[]> {
    const grants = await this.prisma.recipientMessageAccessGrant.findMany({
      where: grantFor(recipient),
      orderBy: [
        { messageRelease: { releasedAt: 'desc' } },
        { messageId: 'asc' },
      ],
      select: {
        messageRelease: { select: { releasedAt: true } },
        senderDisplayNameSnapshot: true,
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
    recipient: RecipientPrincipal,
    messageId: string,
  ): Promise<RecipientMessageDetail> {
    return toDetail(await this.authorize(recipient, messageId));
  }

  async findMedia(
    recipient: RecipientPrincipal,
    messageId: string,
  ): Promise<RecipientMediaResponse[]> {
    await this.authorize(recipient, messageId);
    return this.prisma.mediaAsset.findMany({
      where: { messageId, ...visibleMedia },
      orderBy: { createdAt: 'asc' },
      select: recipientMediaSelect,
    });
  }

  // Signed only after the grant check. The URL is never stored or logged.
  async createMediaAccessUrl(
    recipient: RecipientPrincipal,
    messageId: string,
    id: string,
  ): Promise<AccessUrlResponse> {
    await this.authorize(recipient, messageId);
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

  private async authorize(recipient: RecipientPrincipal, messageId: string) {
    const grant = await this.prisma.recipientMessageAccessGrant.findFirst({
      where: { ...grantFor(recipient), messageId },
      select: {
        messageRelease: { select: { releasedAt: true } },
        senderDisplayNameSnapshot: true,
        message: { select: messageSelect },
      },
    });
    const who = `${maskPrincipal(recipient)} message ${messageId}`;
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
  senderDisplayNameSnapshot: string | null;
  message: Prisma.MessageGetPayload<{ select: typeof messageSelect }>;
};

const toDetail = ({
  messageRelease,
  senderDisplayNameSnapshot,
  message: { _count, ...message },
}: GrantRow): RecipientMessageDetail => ({
  ...message,
  releasedAt: messageRelease.releasedAt,
  hasMedia: _count.mediaAssets > 0,
  senderDisplayName: senderDisplayNameSnapshot,
});
