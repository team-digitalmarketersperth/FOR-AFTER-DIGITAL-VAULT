import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { MediaAssetStatus } from '../generated/prisma/client.js';
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
  rejected,
  storedRefSelect,
  UPLOAD_FAILED,
  type UploadUrlResponse,
  uploadExtension,
} from '../media/media.service.js';
import { MalwareScanner } from '../media/scanner/malware-scanner.service.js';
import { StorageQuota } from '../media/storage-quota.service.js';
import { MediaStorage } from '../media/storage/media-storage.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { MyWishesDisclaimerService } from './my-wishes-disclaimer.service.js';
import type { MyWishPrompt } from './my-wishes.prompts.js';
import { liveWishId } from './my-wishes.service.js';

const MEDIA_NOT_FOUND = 'Media not found.';

/**
 * Phase 15B: PHOTO/AUDIO/VIDEO on the Customer's own wish. Same storage,
 * limits, allowlist, quota, upload checks (provider, magic bytes, malware
 * scan), signed URLs and cleanup as My Story media (docs/media-storage.md);
 * the browser never decides READY. Private: no Recipient, Trusted Contact or
 * admin route reaches these files. Adding a file is writing a wish, so it
 * needs the current notice acknowledged (Phase 15A); completing, viewing and
 * deleting never do.
 */
@Injectable()
export class MyWishesMediaService {
  private readonly settings: ReturnType<typeof mediaSettings>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: MediaStorage,
    private readonly scanner: MalwareScanner,
    private readonly cleanup: MediaCleanup,
    private readonly quota: StorageQuota,
    private readonly disclaimer: MyWishesDisclaimerService,
    config: ConfigService,
  ) {
    this.settings = mediaSettings(config);
  }

  // The file, its live wish and the route's prompt must all line up, owned.
  private ownedAsset(ownerUserId: string, prompt: MyWishPrompt, id: string) {
    return {
      id,
      ownerUserId,
      deletedAt: null,
      myWishResponse: { ownerUserId, promptKey: prompt.key, deletedAt: null },
    };
  }

  /**
   * Upload auth for the wish, creating its empty private shell if needed
   * (the file needs a row to belong to). Quota first, then the row, then the
   * signature, all in one transaction: no row survives a refusal.
   */
  async createUploadUrl(
    ownerUserId: string,
    prompt: MyWishPrompt,
    dto: CreateMediaUploadDto,
  ): Promise<UploadUrlResponse> {
    const extension = uploadExtension(dto, this.settings.maxBytes);
    await this.disclaimer.assertAcknowledged(ownerUserId);
    const id = randomUUID();
    const upload = await this.prisma.$transaction(async (tx) => {
      await this.quota.reserve(tx, ownerUserId, dto.sizeBytes);
      const responseId = await liveWishId(tx, ownerUserId, prompt);
      // Server-chosen path from ids only: no prompt text, wish or name.
      const storageKey = mediaKey(
        ownerUserId,
        `my-wishes/${responseId}`,
        dto.kind,
        id,
        extension,
      );
      await tx.myWishMediaAsset.create({
        data: {
          id,
          ownerUserId,
          myWishResponseId: responseId,
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
    return {
      mediaAssetId: id,
      upload,
      expiresAt: expiresAt(this.settings.uploadTtl),
    };
  }

  // PENDING_UPLOAD → READY only after the provider check, magic bytes and the
  // malware scan (checkUpload). Mismatch or infected → FAILED for good and
  // the file is removed. READY is returned unchanged.
  async complete(
    ownerUserId: string,
    prompt: MyWishPrompt,
    id: string,
    providerFileId: string,
  ): Promise<MediaResponse> {
    const asset = await this.prisma.myWishMediaAsset.findFirst({
      where: this.ownedAsset(ownerUserId, prompt, id),
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
      const failed = await this.prisma.myWishMediaAsset.update({
        where: { id },
        data: {
          status: MediaAssetStatus.FAILED,
          providerFileId: check.ref.providerFileId,
        },
        select: storedRefSelect,
      });
      await this.cleanup.purge('myWishMediaAsset', [failed]);
      throw rejected(check.status);
    }

    try {
      return await this.prisma.myWishMediaAsset.update({
        where: {
          ...this.ownedAsset(ownerUserId, prompt, id),
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

  // The wish's live files; none yet (or no wish) is an empty list.
  findAll(ownerUserId: string, prompt: MyWishPrompt): Promise<MediaResponse[]> {
    return this.prisma.myWishMediaAsset.findMany({
      where: {
        ownerUserId,
        deletedAt: null,
        myWishResponse: { ownerUserId, promptKey: prompt.key, deletedAt: null },
      },
      orderBy: { createdAt: 'asc' },
      select: mediaSelect,
    });
  }

  // Owner-only, READY only. The URL is never stored or logged.
  async createAccessUrl(
    ownerUserId: string,
    prompt: MyWishPrompt,
    id: string,
  ): Promise<AccessUrlResponse> {
    const asset = await this.prisma.myWishMediaAsset.findFirst({
      where: this.ownedAsset(ownerUserId, prompt, id),
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
  // never restores access; the cleanup reconciler retries. Copies already in
  // Messages are separate files and stay.
  async remove(ownerUserId: string, prompt: MyWishPrompt, id: string) {
    let deleted;
    try {
      deleted = await this.prisma.myWishMediaAsset.update({
        where: this.ownedAsset(ownerUserId, prompt, id),
        data: { deletedAt: new Date() },
        select: storedRefSelect,
      });
    } catch (err) {
      if (isNoMatch(err)) throw new NotFoundException(MEDIA_NOT_FOUND);
      throw err;
    }
    await this.cleanup.purge('myWishMediaAsset', [deleted]);
  }
}
