import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { MediaAssetStatus, MediaKind } from '../generated/prisma/client.js';
import { CreateMediaUploadDto } from '../media/dto/create-media-upload.dto.js';
import { MediaCleanup } from '../media/media-cleanup.service.js';
import {
  type AccessUrlResponse,
  checkUpload,
  expiresAt,
  isNoMatch,
  mediaKey,
  type MediaResponse,
  mediaSelect,
  mediaSettings,
  NOT_READY,
  NOT_UPLOADED,
  storedRefSelect,
  UPLOAD_FAILED,
  rejected,
  uploadExtension,
  type UploadUrlResponse,
} from '../media/media.service.js';
import { MalwareScanner } from '../media/scanner/malware-scanner.service.js';
import { StorageQuota } from '../media/storage-quota.service.js';
import { MediaStorage } from '../media/storage/media-storage.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { MEMORY_NOT_FOUND } from './memory-vault.service.js';

const MEDIA_NOT_FOUND = 'Media not found.';

/**
 * PHOTO/AUDIO on a customer's own Memory Vault item. Same storage, limits,
 * allowlist and upload lifecycle as message media (docs/media-storage.md),
 * without the DRAFT lock: memories have no status and are always editable.
 * No VIDEO: video was approved for messages only (Phase 12).
 */
@Injectable()
export class MemoryVaultMediaService {
  private readonly settings: ReturnType<typeof mediaSettings>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: MediaStorage,
    private readonly scanner: MalwareScanner,
    private readonly cleanup: MediaCleanup,
    private readonly quota: StorageQuota,
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
    if (dto.kind === MediaKind.VIDEO) {
      throw new BadRequestException('kind must be PHOTO or AUDIO');
    }
    const extension = uploadExtension(dto, this.settings.maxBytes);
    // Server-chosen path: no client filename or extension reaches it.
    const id = randomUUID();
    const storageKey = mediaKey(
      ownerUserId,
      `memory-vault/${itemId}`,
      dto.kind,
      id,
      extension,
    );
    // Signing inside the transaction: no PENDING row survives a signing failure.
    const upload = await this.prisma.$transaction(async (tx) => {
      const found = await tx.memoryVaultItem.count({
        where: this.ownedItem(ownerUserId, itemId),
      });
      if (!found) return null;
      // Phase 12C: quota is checked before the row exists or anything is signed.
      await this.quota.reserve(tx, ownerUserId, dto.sizeBytes);
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
      return this.storage.createUpload(
        storageKey,
        dto.mimeType,
        dto.sizeBytes,
        this.settings.uploadTtl,
      );
    });
    if (!upload) throw new NotFoundException(MEMORY_NOT_FOUND);
    return {
      mediaAssetId: id,
      upload,
      expiresAt: expiresAt(this.settings.uploadTtl),
    };
  }

  // PENDING_UPLOAD → READY only after the provider confirms the file (see
  // checkUpload). A mismatch → FAILED and the file is removed. READY is
  // returned unchanged.
  async complete(
    ownerUserId: string,
    itemId: string,
    id: string,
    providerFileId: string,
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

    const check = await checkUpload(
      this.storage,
      this.scanner,
      { ...asset, storageKey },
      providerFileId,
      this.settings.scanTimeoutMs,
    );
    if (check.status === 'missing') throw new ConflictException(NOT_UPLOADED);
    if (check.status !== 'ok') {
      const failed = await this.prisma.memoryVaultMediaAsset.update({
        where: { id },
        data: {
          status: MediaAssetStatus.FAILED,
          providerFileId: check.ref.providerFileId,
        },
        select: storedRefSelect,
      });
      await this.cleanup.purge('memoryVaultMediaAsset', [failed]);
      throw rejected(check.status);
    }

    try {
      return await this.prisma.memoryVaultMediaAsset.update({
        where: {
          ...this.ownedAsset(ownerUserId, itemId, id),
          status: MediaAssetStatus.PENDING_UPLOAD,
        },
        data: {
          status: MediaAssetStatus.READY,
          uploadedAt: new Date(),
          providerFileId: check.ref.providerFileId,
        },
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
      select: { status: true, ...storedRefSelect },
    });
    if (!asset) throw new NotFoundException(MEDIA_NOT_FOUND);
    if (asset.status !== MediaAssetStatus.READY) {
      throw new ConflictException(NOT_READY);
    }
    return {
      url: await this.storage.createAccessUrl(asset, this.settings.accessTtl),
      expiresAt: expiresAt(this.settings.accessTtl),
    };
  }

  // Soft delete first, then best-effort file removal. A provider failure
  // never restores access; the cleanup reconciler retries.
  async remove(ownerUserId: string, itemId: string, id: string) {
    let deleted;
    try {
      deleted = await this.prisma.memoryVaultMediaAsset.update({
        where: this.ownedAsset(ownerUserId, itemId, id),
        data: { deletedAt: new Date() },
        select: storedRefSelect,
      });
    } catch (err) {
      if (isNoMatch(err)) throw new NotFoundException(MEDIA_NOT_FOUND);
      throw err;
    }
    await this.cleanup.purge('memoryVaultMediaAsset', [deleted]);
  }
}
