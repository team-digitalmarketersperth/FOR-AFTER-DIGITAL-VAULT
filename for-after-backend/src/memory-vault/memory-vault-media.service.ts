import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { MediaAssetStatus } from '../generated/prisma/client.js';
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
  UPLOAD_FAILED,
  UPLOAD_MISMATCH,
  uploadExtension,
  type UploadUrlResponse,
} from '../media/media.service.js';
import { MediaStorage } from '../media/storage/media-storage.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { MEMORY_NOT_FOUND } from './memory-vault.service.js';

const MEDIA_NOT_FOUND = 'Media not found.';

/**
 * PHOTO/AUDIO on a customer's own Memory Vault item. Same storage, limits,
 * allowlist and upload lifecycle as message media (docs/media-storage.md),
 * without the DRAFT lock: memories have no status and are always editable.
 */
@Injectable()
export class MemoryVaultMediaService {
  private readonly logger = new Logger(MemoryVaultMediaService.name);
  private readonly settings: ReturnType<typeof mediaSettings>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: MediaStorage,
    config: ConfigService,
  ) {
    this.settings = mediaSettings(config);
  }

  private ownedItem(ownerUserId: string, itemId: string) {
    return { id: itemId, ownerUserId, deletedAt: null };
  }

  // The asset, its live parent item and the route's item id must all line up.
  private ownedAsset(ownerUserId: string, itemId: string, id: string) {
    return {
      id,
      ownerUserId,
      memoryVaultItemId: itemId,
      deletedAt: null,
      memoryVaultItem: this.ownedItem(ownerUserId, itemId),
    };
  }

  async createUploadUrl(
    ownerUserId: string,
    itemId: string,
    dto: CreateMediaUploadDto,
  ): Promise<UploadUrlResponse> {
    const extension = uploadExtension(dto, this.settings.maxBytes);
    // Server-chosen key: no client filename or extension reaches the path.
    const id = randomUUID();
    const storageKey = `users/${ownerUserId}/memory-vault/${itemId}/${id}.${extension}`;
    // Signing inside the transaction: no PENDING row survives a signing failure.
    const uploadUrl = await this.prisma.$transaction(async (tx) => {
      const found = await tx.memoryVaultItem.count({
        where: this.ownedItem(ownerUserId, itemId),
      });
      if (!found) return null;
      await tx.memoryVaultMediaAsset.create({
        data: {
          id,
          ownerUserId,
          memoryVaultItemId: itemId,
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
        this.settings.uploadTtl,
      );
    });
    if (!uploadUrl) throw new NotFoundException(MEMORY_NOT_FOUND);
    return {
      mediaAssetId: id,
      uploadUrl,
      expiresAt: expiresAt(this.settings.uploadTtl),
      requiredHeaders: { 'Content-Type': dto.mimeType },
    };
  }

  // PENDING_UPLOAD → READY only after storage confirms the object's size (and
  // type, when reported). A mismatch → FAILED. READY is returned unchanged.
  async complete(
    ownerUserId: string,
    itemId: string,
    id: string,
  ): Promise<MediaResponse> {
    const asset = await this.prisma.memoryVaultMediaAsset.findFirst({
      where: this.ownedAsset(ownerUserId, itemId, id),
      select: { ...mediaSelect, storageKey: true },
    });
    if (!asset) throw new NotFoundException(MEDIA_NOT_FOUND);
    const { storageKey, ...safe } = asset;
    if (asset.status === MediaAssetStatus.READY) return safe;
    if (asset.status === MediaAssetStatus.FAILED) {
      throw new ConflictException(UPLOAD_FAILED);
    }

    const stored = await this.storage.headObject(storageKey);
    if (!stored) throw new ConflictException(NOT_UPLOADED);
    if (!matchesUpload(stored, asset)) {
      await this.prisma.memoryVaultMediaAsset.update({
        where: { id },
        data: { status: MediaAssetStatus.FAILED },
      });
      this.logger.warn(`Memory media ${id} failed upload verification`);
      await deleteObjectQuietly(this.storage, this.logger, id, storageKey);
      throw new BadRequestException(UPLOAD_MISMATCH);
    }

    try {
      return await this.prisma.memoryVaultMediaAsset.update({
        where: {
          ...this.ownedAsset(ownerUserId, itemId, id),
          status: MediaAssetStatus.PENDING_UPLOAD,
        },
        data: { status: MediaAssetStatus.READY, uploadedAt: new Date() },
        select: mediaSelect,
      });
    } catch (err) {
      // Deleted or completed meanwhile; a retry sees the new state.
      if (isNoMatch(err)) throw new ConflictException(NOT_READY);
      throw err;
    }
  }

  async findAllForItem(
    ownerUserId: string,
    itemId: string,
  ): Promise<MediaResponse[]> {
    const found = await this.prisma.memoryVaultItem.count({
      where: this.ownedItem(ownerUserId, itemId),
    });
    if (!found) throw new NotFoundException(MEMORY_NOT_FOUND);
    return this.prisma.memoryVaultMediaAsset.findMany({
      where: { memoryVaultItemId: itemId, ownerUserId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: mediaSelect,
    });
  }

  // Owner-only, READY only. The URL is never stored or logged.
  async createAccessUrl(
    ownerUserId: string,
    itemId: string,
    id: string,
  ): Promise<AccessUrlResponse> {
    const asset = await this.prisma.memoryVaultMediaAsset.findFirst({
      where: this.ownedAsset(ownerUserId, itemId, id),
      select: { status: true, storageKey: true },
    });
    if (!asset) throw new NotFoundException(MEDIA_NOT_FOUND);
    if (asset.status !== MediaAssetStatus.READY) {
      throw new ConflictException(NOT_READY);
    }
    return {
      url: await this.storage.createAccessUrl(
        asset.storageKey,
        this.settings.accessTtl,
      ),
      expiresAt: expiresAt(this.settings.accessTtl),
    };
  }

  // Soft delete first, then best-effort object removal. A storage failure
  // never restores access; the object is left for future reconciliation.
  async remove(ownerUserId: string, itemId: string, id: string) {
    let deleted: { storageKey: string };
    try {
      deleted = await this.prisma.memoryVaultMediaAsset.update({
        where: this.ownedAsset(ownerUserId, itemId, id),
        data: { deletedAt: new Date() },
        select: { storageKey: true },
      });
    } catch (err) {
      if (isNoMatch(err)) throw new NotFoundException(MEDIA_NOT_FOUND);
      throw err;
    }
    await deleteObjectQuietly(
      this.storage,
      this.logger,
      id,
      deleted.storageKey,
    );
  }
}
