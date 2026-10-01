import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import {
  MediaAssetStatus,
  MessageStatus,
  Prisma,
} from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  CreateMediaUploadDto,
  MIME_TYPES,
  type UploadKind,
} from './dto/create-media-upload.dto.js';
import {
  MediaStorage,
  type StoredObject,
} from './storage/media-storage.service.js';

// storageKey, ownerUserId, messageId and deletedAt never leave the API.
// Also used for Memory Vault media (same fields).
export const mediaSelect = {
  id: true,
  kind: true,
  status: true,
  originalFileName: true,
  mimeType: true,
  sizeBytes: true,
  uploadedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.MediaAssetSelect;

export type MediaResponse = Prisma.MediaAssetGetPayload<{
  select: typeof mediaSelect;
}>;
export type UploadUrlResponse = {
  mediaAssetId: string;
  uploadUrl: string;
  expiresAt: Date;
  requiredHeaders: { 'Content-Type': string };
};
export type AccessUrlResponse = { url: string; expiresAt: Date };

// Same message whether the row is missing, deleted or someone else's.
const MESSAGE_NOT_FOUND = 'Message not found.';
const MEDIA_NOT_FOUND = 'Media not found.';
export const NOT_DRAFT =
  'Media can only be changed on a draft message. Unschedule it first.';
export const NOT_UPLOADED = 'The file has not been uploaded yet.';
export const UPLOAD_MISMATCH =
  'The uploaded file does not match the upload request. Request a new upload URL.';
export const UPLOAD_FAILED =
  'This upload failed verification. Request a new upload URL.';
export const NOT_READY = 'Media is not ready.';

export const isNoMatch = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025';

// Positive whole number from config, with a default; bad values stop startup.
export const positiveInt = (
  config: ConfigService,
  key: string,
  fallback: number,
) => {
  const value = Number(config.get<string>(key) ?? fallback);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${key} must be a positive whole number.`);
  }
  return value;
};

export const expiresAt = (ttlSeconds: number) =>
  new Date(Date.now() + ttlSeconds * 1000);

// The rules below are shared by every media owner (messages, Memory Vault),
// so both follow the same limits, allowlist and verification.
export const mediaSettings = (config: ConfigService) => ({
  uploadTtl: positiveInt(config, 'MEDIA_UPLOAD_URL_TTL_SECONDS', 600),
  accessTtl: positiveInt(config, 'MEDIA_ACCESS_URL_TTL_SECONDS', 300),
  maxBytes: {
    PHOTO: positiveInt(config, 'MEDIA_PHOTO_MAX_BYTES', 20 * 1024 * 1024),
    AUDIO: positiveInt(config, 'MEDIA_AUDIO_MAX_BYTES', 100 * 1024 * 1024),
  } as Record<UploadKind, number>,
});

// Kind/MIME pairing and size limit; returns the storage-key extension.
export const uploadExtension = (
  dto: CreateMediaUploadDto,
  maxBytes: Record<UploadKind, number>,
) => {
  const types: Record<string, string> = MIME_TYPES[dto.kind];
  const extension = types[dto.mimeType];
  if (!extension) {
    throw new BadRequestException(
      `mimeType ${dto.mimeType} is not allowed for ${dto.kind}.`,
    );
  }
  if (dto.sizeBytes > maxBytes[dto.kind]) {
    throw new BadRequestException(
      `sizeBytes exceeds the ${dto.kind} limit of ${maxBytes[dto.kind]} bytes.`,
    );
  }
  return extension;
};

// Size must match; type too, when storage reports one.
export const matchesUpload = (
  stored: StoredObject,
  expected: { sizeBytes: number; mimeType: string },
) => {
  const storedType = stored.contentType?.split(';')[0].trim().toLowerCase();
  return (
    stored.sizeBytes === expected.sizeBytes &&
    (!storedType || storedType === expected.mimeType)
  );
};

// ponytail: no retry/outbox; orphaned objects need a future reconciliation job.
export const deleteObjectQuietly = async (
  storage: MediaStorage,
  logger: Logger,
  id: string,
  storageKey: string,
) => {
  try {
    await storage.deleteObject(storageKey);
  } catch {
    logger.warn(`Media ${id} object cleanup failed; left for reconciliation`);
  }
};

/**
 * Media attached to a customer's own messages. File bytes go straight between
 * the client and the private bucket via short-lived signed URLs; this service
 * only authorizes, records metadata and verifies uploads. MIME and size checks
 * are not content validation (no scanning yet, see docs/media-storage.md).
 */
@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);
  private readonly uploadTtl: number;
  private readonly accessTtl: number;
  private readonly maxBytes: Record<UploadKind, number>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: MediaStorage,
    config: ConfigService,
  ) {
    ({
      uploadTtl: this.uploadTtl,
      accessTtl: this.accessTtl,
      maxBytes: this.maxBytes,
    } = mediaSettings(config));
  }

  private ownedMessage(ownerUserId: string, messageId: string) {
    return { id: messageId, ownerUserId, deletedAt: null };
  }

  // Ownership is part of every asset query: the asset, its message and the
  // route's messageId must all line up, never checked after fetching by id.
  private ownedAsset(ownerUserId: string, messageId: string, id: string) {
    return {
      id,
      ownerUserId,
      messageId,
      deletedAt: null,
      message: this.ownedMessage(ownerUserId, messageId),
    };
  }

  async createUploadUrl(
    ownerUserId: string,
    messageId: string,
    dto: CreateMediaUploadDto,
  ): Promise<UploadUrlResponse> {
    const extension = uploadExtension(dto, this.maxBytes);
    // Server-chosen key: no client filename or extension reaches the path.
    const id = randomUUID();
    const storageKey = `users/${ownerUserId}/messages/${messageId}/${id}.${extension}`;
    const uploadUrl = await this.inDraft(ownerUserId, messageId, async (tx) => {
      await tx.mediaAsset.create({
        data: {
          id,
          ownerUserId,
          messageId,
          kind: dto.kind,
          storageKey,
          originalFileName: dto.originalFileName,
          mimeType: dto.mimeType,
          sizeBytes: dto.sizeBytes,
        },
        select: { id: true },
      });
      return this.storage.createUploadUrl(
        storageKey,
        dto.mimeType,
        this.uploadTtl,
      );
    });
    if (!uploadUrl) throw await this.notDraft(ownerUserId, messageId);
    return {
      mediaAssetId: id,
      uploadUrl,
      expiresAt: expiresAt(this.uploadTtl),
      requiredHeaders: { 'Content-Type': dto.mimeType },
    };
  }

  // PENDING_UPLOAD → READY only after storage confirms the object's size (and
  // type, when reported). A mismatch → FAILED. READY is returned unchanged.
  async complete(
    ownerUserId: string,
    messageId: string,
    id: string,
  ): Promise<MediaResponse> {
    const asset = await this.prisma.mediaAsset.findFirst({
      where: this.ownedAsset(ownerUserId, messageId, id),
      select: {
        ...mediaSelect,
        storageKey: true,
        message: { select: { status: true } },
      },
    });
    if (!asset) throw new NotFoundException(MEDIA_NOT_FOUND);
    const { storageKey, message, ...safe } = asset;
    if (asset.status === MediaAssetStatus.READY) return safe;
    if (message.status !== MessageStatus.DRAFT) {
      throw new ConflictException(NOT_DRAFT);
    }
    if (asset.status === MediaAssetStatus.FAILED) {
      throw new ConflictException(UPLOAD_FAILED);
    }

    const stored = await this.storage.headObject(storageKey);
    if (!stored) throw new ConflictException(NOT_UPLOADED);
    if (!matchesUpload(stored, asset)) {
      await this.prisma.mediaAsset.update({
        where: { id },
        data: { status: MediaAssetStatus.FAILED },
      });
      this.logger.warn(`Media ${id} failed upload verification`);
      await this.tryDeleteObject(id, storageKey);
      throw new BadRequestException(UPLOAD_MISMATCH);
    }

    let ready: MediaResponse | null;
    try {
      ready = await this.inDraft(ownerUserId, messageId, (tx) =>
        tx.mediaAsset.update({
          where: {
            ...this.ownedAsset(ownerUserId, messageId, id),
            status: MediaAssetStatus.PENDING_UPLOAD,
          },
          data: { status: MediaAssetStatus.READY, uploadedAt: new Date() },
          select: mediaSelect,
        }),
      );
    } catch (err) {
      // Deleted or completed meanwhile; a retry sees the new state.
      if (isNoMatch(err)) throw new ConflictException(NOT_READY);
      throw err;
    }
    if (!ready) throw await this.notDraft(ownerUserId, messageId);
    return ready;
  }

  async findAllForMessage(
    ownerUserId: string,
    messageId: string,
  ): Promise<MediaResponse[]> {
    const found = await this.prisma.message.count({
      where: this.ownedMessage(ownerUserId, messageId),
    });
    if (!found) throw new NotFoundException(MESSAGE_NOT_FOUND);
    return this.prisma.mediaAsset.findMany({
      where: { messageId, ownerUserId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: mediaSelect,
    });
  }

  // Owner-only, READY only, any message status. The URL is never stored or logged.
  async createAccessUrl(
    ownerUserId: string,
    messageId: string,
    id: string,
  ): Promise<AccessUrlResponse> {
    const asset = await this.prisma.mediaAsset.findFirst({
      where: this.ownedAsset(ownerUserId, messageId, id),
      select: { status: true, storageKey: true },
    });
    if (!asset) throw new NotFoundException(MEDIA_NOT_FOUND);
    if (asset.status !== MediaAssetStatus.READY) {
      throw new ConflictException(NOT_READY);
    }
    return {
      url: await this.storage.createAccessUrl(asset.storageKey, this.accessTtl),
      expiresAt: expiresAt(this.accessTtl),
    };
  }

  // Soft delete first (under the draft lock), then best-effort object
  // removal. A storage failure never restores access; the object is left for
  // future reconciliation.
  async remove(ownerUserId: string, messageId: string, id: string) {
    let deleted: { storageKey: string } | null;
    try {
      deleted = await this.inDraft(ownerUserId, messageId, (tx) =>
        tx.mediaAsset.update({
          where: this.ownedAsset(ownerUserId, messageId, id),
          data: { deletedAt: new Date() },
          select: { storageKey: true },
        }),
      );
    } catch (err) {
      if (isNoMatch(err)) throw new NotFoundException(MEDIA_NOT_FOUND);
      throw err;
    }
    if (!deleted) throw await this.notDraft(ownerUserId, messageId);
    await this.tryDeleteObject(id, deleted.storageKey);
  }

  // Media changes run under the same message-row lock as scheduling: a
  // conditional UPDATE (owned, live, DRAFT) inside a transaction. A concurrent
  // DRAFT → SCHEDULED either waits for this change and validates it, or wins
  // and this sees SCHEDULED (null). Touches Message.updatedAt as a side effect.
  private inDraft<T>(
    ownerUserId: string,
    messageId: string,
    write: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T | null> {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.message.updateMany({
        where: {
          ...this.ownedMessage(ownerUserId, messageId),
          status: MessageStatus.DRAFT,
        },
        data: { status: MessageStatus.DRAFT },
      });
      return count ? write(tx) : null;
    });
  }

  // Why inDraft matched nothing: someone else's/missing message (404) or not DRAFT (409).
  private async notDraft(ownerUserId: string, messageId: string) {
    const found = await this.prisma.message.count({
      where: this.ownedMessage(ownerUserId, messageId),
    });
    return found
      ? new ConflictException(NOT_DRAFT)
      : new NotFoundException(MESSAGE_NOT_FOUND);
  }

  private tryDeleteObject(id: string, storageKey: string) {
    return deleteObjectQuietly(this.storage, this.logger, id, storageKey);
  }
}
