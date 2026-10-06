import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { MediaAssetStatus, MediaKind } from '../generated/prisma/client.js';
import { CreateMediaUploadDto } from '../media/dto/create-media-upload.dto.js';
import {
  type AccessUrlResponse,
  deleteObjectQuietly,
  expiresAt,
  isNoMatch,
  matchesUpload,
  type MediaResponse,
  mediaSelect,
  mediaSettings,
  NOT_READY,
  NOT_UPLOADED,
  positiveInt,
  UPLOAD_FAILED,
  UPLOAD_MISMATCH,
  uploadExtension,
  type UploadUrlResponse,
} from '../media/media.service.js';
import { MediaStorage } from '../media/storage/media-storage.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

// Same message whether missing, deleted or someone else's (no enumeration).
export const RECIPIENT_NOT_FOUND = 'Recipient not found.';
const PHOTO_NOT_FOUND = 'Photo not found.';

/**
 * Phase 09: one optional, private profile photo per Recipient, managed by its
 * Customer. Reuses the media storage, allowlist (JPEG/PNG/WebP, no SVG),
 * HEAD verification and signed URLs (docs/media-storage.md) with its own,
 * smaller size limit. Uploading never replaces the current photo until the
 * new one is verified READY.
 */
@Injectable()
export class RecipientPhotoService {
  private readonly logger = new Logger(RecipientPhotoService.name);
  private readonly settings: ReturnType<typeof mediaSettings>;
  private readonly maxBytes: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: MediaStorage,
    config: ConfigService,
  ) {
    this.settings = mediaSettings(config);
    this.maxBytes = positiveInt(
      config,
      'RECIPIENT_PHOTO_MAX_BYTES',
      5 * 1024 * 1024,
    );
  }

  private ownedRecipient(ownerUserId: string, recipientId: string) {
    return { id: recipientId, ownerUserId, deletedAt: null };
  }

  // The photo, its live Recipient and the route's ids must all line up.
  private ownedPhoto(ownerUserId: string, recipientId: string, id: string) {
    return {
      id,
      ownerUserId,
      recipientId,
      deletedAt: null,
      recipient: this.ownedRecipient(ownerUserId, recipientId),
    };
  }

  async createUploadUrl(
    ownerUserId: string,
    recipientId: string,
    dto: CreateMediaUploadDto,
  ): Promise<UploadUrlResponse> {
    if (dto.kind !== MediaKind.PHOTO) {
      throw new BadRequestException(
        'A Recipient photo must be a JPEG, PNG or WebP image.',
      );
    }
    const extension = uploadExtension(dto, {
      ...this.settings.maxBytes,
      PHOTO: this.maxBytes,
    });
    // Server-chosen key from ids only: no name, contact detail or note.
    const id = randomUUID();
    const storageKey = `users/${ownerUserId}/recipients/${recipientId}/photo/${id}.${extension}`;
    // Signing inside the transaction: no PENDING row survives a signing failure.
    const uploadUrl = await this.prisma.$transaction(async (tx) => {
      const found = await tx.recipient.count({
        where: this.ownedRecipient(ownerUserId, recipientId),
      });
      if (!found) return null;
      await tx.recipientPhoto.create({
        data: {
          id,
          ownerUserId,
          recipientId,
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
        this.settings.uploadTtl,
      );
    });
    if (!uploadUrl) throw new NotFoundException(RECIPIENT_NOT_FOUND);
    return {
      mediaAssetId: id,
      uploadUrl,
      expiresAt: expiresAt(this.settings.uploadTtl),
      requiredHeaders: { 'Content-Type': dto.mimeType },
    };
  }

  /**
   * PENDING_UPLOAD → READY once storage confirms the object, and it becomes
   * the Recipient's photo in the same transaction: the Recipient row is locked
   * (so concurrent completions serialise and a deleted Recipient is never
   * given a photo), the previous photo is soft-deleted, then this one is
   * marked READY. The partial unique index is the backstop. The old object is
   * removed after commit, best effort: a storage failure never undoes the swap.
   */
  async complete(
    ownerUserId: string,
    recipientId: string,
    id: string,
  ): Promise<MediaResponse> {
    const photo = await this.prisma.recipientPhoto.findFirst({
      where: this.ownedPhoto(ownerUserId, recipientId, id),
      select: { ...mediaSelect, storageKey: true },
    });
    if (!photo) throw new NotFoundException(PHOTO_NOT_FOUND);
    const { storageKey, ...safe } = photo;
    if (photo.status === MediaAssetStatus.READY) return safe;
    if (photo.status === MediaAssetStatus.FAILED) {
      throw new ConflictException(UPLOAD_FAILED);
    }

    const stored = await this.storage.headObject(storageKey);
    if (!stored) throw new ConflictException(NOT_UPLOADED);
    if (!matchesUpload(stored, photo)) {
      await this.prisma.recipientPhoto.update({
        where: { id },
        data: { status: MediaAssetStatus.FAILED },
      });
      this.logger.warn(`Recipient photo ${id} failed upload verification`);
      await deleteObjectQuietly(this.storage, this.logger, id, storageKey);
      throw new BadRequestException(UPLOAD_MISMATCH);
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const [live] = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "Recipient"
        WHERE id = ${recipientId}::uuid AND "ownerUserId" = ${ownerUserId}::uuid
          AND "deletedAt" IS NULL
        FOR UPDATE`;
      if (!live) return null;
      const replaced = await tx.recipientPhoto.findMany({
        where: {
          recipientId,
          status: MediaAssetStatus.READY,
          deletedAt: null,
          id: { not: id },
        },
        select: { id: true, storageKey: true },
      });
      const now = new Date();
      await tx.recipientPhoto.updateMany({
        where: { id: { in: replaced.map((r) => r.id) } },
        data: { deletedAt: now },
      });
      const { count } = await tx.recipientPhoto.updateMany({
        where: {
          id,
          recipientId,
          status: MediaAssetStatus.PENDING_UPLOAD,
          deletedAt: null,
        },
        data: { status: MediaAssetStatus.READY, uploadedAt: now },
      });
      // Removed or completed meanwhile: keep the current photo as it was.
      if (!count) throw new ConflictException(NOT_READY);
      return { replaced };
    });
    if (!result) throw new NotFoundException(RECIPIENT_NOT_FOUND);
    for (const old of result.replaced) {
      await deleteObjectQuietly(
        this.storage,
        this.logger,
        old.id,
        old.storageKey,
      );
    }
    return this.prisma.recipientPhoto.findUniqueOrThrow({
      where: { id },
      select: mediaSelect,
    });
  }

  // Owner-only, the current READY photo only. The URL is never stored or logged.
  async createAccessUrl(
    ownerUserId: string,
    recipientId: string,
    id: string,
  ): Promise<AccessUrlResponse> {
    const photo = await this.prisma.recipientPhoto.findFirst({
      where: this.ownedPhoto(ownerUserId, recipientId, id),
      select: { status: true, storageKey: true },
    });
    if (!photo) throw new NotFoundException(PHOTO_NOT_FOUND);
    if (photo.status !== MediaAssetStatus.READY) {
      throw new ConflictException(NOT_READY);
    }
    return {
      url: await this.storage.createAccessUrl(
        photo.storageKey,
        this.settings.accessTtl,
      ),
      expiresAt: expiresAt(this.settings.accessTtl),
    };
  }

  /**
   * Removes the current photo (the Recipient shows initials again) or cancels
   * a pending upload. Soft delete first, then best-effort object removal.
   */
  async remove(ownerUserId: string, recipientId: string, id: string) {
    let deleted: { storageKey: string };
    try {
      deleted = await this.prisma.recipientPhoto.update({
        where: this.ownedPhoto(ownerUserId, recipientId, id),
        data: { deletedAt: new Date() },
        select: { storageKey: true },
      });
    } catch (err) {
      if (isNoMatch(err)) throw new NotFoundException(PHOTO_NOT_FOUND);
      throw err;
    }
    await deleteObjectQuietly(
      this.storage,
      this.logger,
      id,
      deleted.storageKey,
    );
  }

  /**
   * After a Recipient is soft-deleted: its photos go too (routes already
   * refuse a deleted Recipient; this also clears the objects, best effort).
   */
  async removeAllForRecipient(ownerUserId: string, recipientId: string) {
    const photos = await this.prisma.recipientPhoto.findMany({
      where: { ownerUserId, recipientId, deletedAt: null },
      select: { id: true, storageKey: true },
    });
    if (!photos.length) return;
    await this.prisma.recipientPhoto.updateMany({
      where: { id: { in: photos.map((p) => p.id) } },
      data: { deletedAt: new Date() },
    });
    for (const p of photos) {
      await deleteObjectQuietly(this.storage, this.logger, p.id, p.storageKey);
    }
  }
}
