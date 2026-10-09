import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import {
  MediaAssetStatus,
  MediaStorageProvider,
  MessageStatus,
  Prisma,
} from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  CreateMediaUploadDto,
  MIME_TYPES,
  type UploadKind,
} from './dto/create-media-upload.dto.js';
import { MediaCleanup } from './media-cleanup.service.js';
import { MalwareScanner } from './scanner/malware-scanner.service.js';
import { StorageQuota } from './storage-quota.service.js';
import {
  MediaStorage,
  type StoredObject,
  type StoredRef,
  type UploadTarget,
} from './storage/media-storage.service.js';

// storageKey, storageProvider, providerFileId, ownerUserId, messageId and
// deletedAt never leave the API. Also used for Memory Vault media and
// Recipient photos (same fields).
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

// What deleting a file needs (any media table).
export const storedRefSelect = {
  id: true,
  storageKey: true,
  storageProvider: true,
  providerFileId: true,
  createdAt: true,
} satisfies Prisma.MediaAssetSelect;

export type MediaResponse = Prisma.MediaAssetGetPayload<{
  select: typeof mediaSelect;
}>;
// The browser POSTs `upload.fields` + the file to `upload.url` (ImageKit),
// then calls complete with the fileId ImageKit returned.
export type UploadUrlResponse = {
  mediaAssetId: string;
  upload: UploadTarget;
  expiresAt: Date;
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
// Malware scan outcomes: generic on purpose (no scanner names or output).
export const UPLOAD_REJECTED =
  'This file could not be accepted. Please choose a different file.';
export const SCAN_UNAVAILABLE =
  "We couldn't finish checking this file. Please try again.";

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

const MB = 1024 * 1024;

// The rules below are shared by every media owner (messages, Memory Vault,
// Recipient photos), so all follow the same limits, allowlist and checks.
// Default sizes follow ImageKit's Free plan upload limits (audio 25 MB, video
// 100 MB; images 25 MB, kept at 20 MB, its image-processing limit). A provider
// limit, not a product decision: raise with the plan (docs/media-storage.md).
export const mediaSettings = (config: ConfigService) => ({
  uploadTtl: positiveInt(config, 'MEDIA_UPLOAD_URL_TTL_SECONDS', 600),
  accessTtl: positiveInt(config, 'MEDIA_ACCESS_URL_TTL_SECONDS', 300),
  // Download + malware scan of one file, VIDEO included.
  scanTimeoutMs: positiveInt(config, 'MEDIA_MALWARE_SCAN_TIMEOUT_MS', 120_000),
  maxBytes: {
    PHOTO: positiveInt(config, 'MEDIA_PHOTO_MAX_BYTES', 20 * MB),
    AUDIO: positiveInt(config, 'MEDIA_AUDIO_MAX_BYTES', 25 * MB),
    VIDEO: positiveInt(config, 'MEDIA_VIDEO_MAX_BYTES', 100 * MB),
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

/**
 * Server-chosen provider path: ids only (no names or other personal data),
 * one folder per owner, parent and kind, e.g.
 * /for-after/users/<userId>/messages/<messageId>/photo/<assetId>.jpg
 */
export const mediaKey = (
  ownerUserId: string,
  parent: string,
  kind: string,
  id: string,
  extension: string,
) =>
  `/for-after/users/${ownerUserId}/${parent}/${kind.toLowerCase()}/${id}.${extension}`;

// Names providers use for the same allowlisted type. The file signature check
// below is what proves the type; this only rejects a clear disagreement.
const MIME_ALIASES: Record<string, string[]> = {
  'image/jpeg': ['image/jpg'],
  'audio/mpeg': ['audio/mp3'],
  'audio/mp4': ['audio/x-m4a', 'audio/m4a', 'video/mp4'],
  'audio/webm': ['video/webm'],
  'audio/wav': ['audio/x-wav', 'audio/wave', 'audio/vnd.wave'],
};

// Size must match exactly and the file must be private; the type too, when
// the provider reports one.
export const matchesUpload = (
  stored: StoredObject,
  expected: { sizeBytes: number; mimeType: string },
) => {
  const storedType = stored.contentType?.split(';')[0].trim().toLowerCase();
  return (
    stored.sizeBytes === expected.sizeBytes &&
    stored.isPrivate !== false &&
    (!storedType ||
      storedType === expected.mimeType ||
      (MIME_ALIASES[expected.mimeType] ?? []).includes(storedType))
  );
};

export const SIGNATURE_BYTES = 16;
const startsWith = (
  bytes: Uint8Array,
  offset: number,
  sig: string | number[],
) =>
  [...(typeof sig === 'string' ? Buffer.from(sig, 'latin1') : sig)].every(
    (b, i) => bytes[offset + i] === b,
  );

/**
 * Magic-byte check: the file's first bytes must match its allowlisted type,
 * whatever its name or declared Content-Type. Type validation only: it is not
 * malware scanning.
 */
export const hasFileSignature = (mimeType: string, bytes: Uint8Array) => {
  switch (mimeType) {
    case 'image/jpeg':
      return startsWith(bytes, 0, [0xff, 0xd8, 0xff]);
    case 'image/png':
      return startsWith(
        bytes,
        0,
        [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      );
    case 'image/webp':
      return startsWith(bytes, 0, 'RIFF') && startsWith(bytes, 8, 'WEBP');
    case 'audio/wav':
      return startsWith(bytes, 0, 'RIFF') && startsWith(bytes, 8, 'WAVE');
    case 'audio/mpeg':
      // ID3 tag, or an MPEG frame sync (11 set bits).
      return (
        startsWith(bytes, 0, 'ID3') ||
        (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0)
      );
    case 'audio/mp4':
    case 'video/mp4':
      return startsWith(bytes, 4, 'ftyp');
    case 'audio/webm':
    case 'video/webm':
      return startsWith(bytes, 0, [0x1a, 0x45, 0xdf, 0xa3]);
    default:
      return false;
  }
};

// The 400 for a FAILED upload: type mismatch, or the generic malware refusal.
export const rejected = (status: 'mismatch' | 'infected') =>
  new BadRequestException(
    status === 'infected' ? UPLOAD_REJECTED : UPLOAD_MISMATCH,
  );

export type UploadCheck =
  | { status: 'missing' }
  | { status: 'mismatch' | 'infected' | 'ok'; ref: StoredRef };

const scanLogger = new Logger('MalwareScan');

// The stream may never yield more than the verified size.
async function* capped(file: AsyncIterable<Uint8Array>, maxBytes: number) {
  let total = 0;
  for await (const chunk of file) {
    total += chunk.byteLength;
    if (total > maxBytes) throw new Error('ScanSizeExceeded');
    yield chunk;
  }
}

/**
 * The server's verification of a direct upload; the browser is never trusted.
 * The provider must hold a file at exactly this row's path (`missing`
 * otherwise, never touching someone else's file), private, with the declared
 * size, a matching provider MIME and a matching file signature (`mismatch`).
 * Only then is the whole file streamed to the malware scanner (`infected`).
 * A scan that cannot finish (scanner down, timeout, odd reply) throws 503 and
 * leaves the row PENDING_UPLOAD: fail closed, retryable.
 */
export const checkUpload = async (
  storage: MediaStorage,
  scanner: MalwareScanner,
  row: { id: string; storageKey: string; mimeType: string; sizeBytes: number },
  providerFileId: string,
  scanTimeoutMs: number,
): Promise<UploadCheck> => {
  const stored = await storage.verifyUpload(row.storageKey, providerFileId);
  if (!stored) return { status: 'missing' };
  const ref = {
    storageKey: row.storageKey,
    storageProvider: MediaStorageProvider.IMAGEKIT,
    providerFileId: stored.providerFileId ?? providerFileId,
  };
  if (!matchesUpload(stored, row)) return { status: 'mismatch', ref };
  const head = await storage.readStart(ref, SIGNATURE_BYTES);
  if (!hasFileSignature(row.mimeType, head)) return { status: 'mismatch', ref };

  let verdict: string;
  try {
    const signal = AbortSignal.timeout(scanTimeoutMs);
    const file = await storage.openRead(ref, signal);
    verdict = await scanner.scan(capped(file, row.sizeBytes), signal);
  } catch (err) {
    // Error class only: never paths, URLs or scanner output.
    scanLogger.error(
      `Media ${row.id} malware scan failed (${err instanceof Error ? err.name : 'UNKNOWN'}); left pending`,
    );
    throw new ServiceUnavailableException(SCAN_UNAVAILABLE);
  }
  if (verdict === 'INFECTED') {
    scanLogger.warn(`Media ${row.id} rejected by malware scan`);
    return { status: 'infected', ref };
  }
  if (verdict !== 'CLEAN')
    throw new ServiceUnavailableException(SCAN_UNAVAILABLE);
  return { status: 'ok', ref };
};

/**
 * Media attached to a customer's own messages. File bytes go straight between
 * the browser and the private provider (ImageKit) via signed upload tokens and
 * short-lived signed URLs; this service only authorizes, records metadata and
 * verifies uploads (type checks, then a malware scan; docs/media-storage.md).
 */
@Injectable()
export class MediaService {
  private readonly uploadTtl: number;
  private readonly accessTtl: number;
  private readonly maxBytes: Record<UploadKind, number>;
  private readonly scanTimeoutMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: MediaStorage,
    private readonly scanner: MalwareScanner,
    private readonly cleanup: MediaCleanup,
    private readonly quota: StorageQuota,
    config: ConfigService,
  ) {
    ({
      uploadTtl: this.uploadTtl,
      accessTtl: this.accessTtl,
      maxBytes: this.maxBytes,
      scanTimeoutMs: this.scanTimeoutMs,
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
    // Server-chosen path: no client filename or extension reaches it.
    const id = randomUUID();
    const storageKey = mediaKey(
      ownerUserId,
      `messages/${messageId}`,
      dto.kind,
      id,
      extension,
    );
    const upload = await this.inDraft(ownerUserId, messageId, async (tx) => {
      // Phase 12C: quota is checked before the row exists or anything is signed.
      await this.quota.reserve(tx, ownerUserId, dto.sizeBytes);
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
      return this.storage.createUpload(
        storageKey,
        dto.mimeType,
        dto.sizeBytes,
        this.uploadTtl,
      );
    });
    if (!upload) throw await this.notDraft(ownerUserId, messageId);
    return { mediaAssetId: id, upload, expiresAt: expiresAt(this.uploadTtl) };
  }

  // PENDING_UPLOAD → READY only after the provider confirms the file and the
  // malware scan is clean (see checkUpload). A mismatch or an infected file →
  // FAILED for good and the file is removed. READY is returned unchanged.
  async complete(
    ownerUserId: string,
    messageId: string,
    id: string,
    providerFileId: string,
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
    // storageKey is taken out so it never reaches the response.
    const { storageKey: _storageKey, message, ...safe } = asset;
    if (asset.status === MediaAssetStatus.READY) return safe;
    if (message.status !== MessageStatus.DRAFT) {
      throw new ConflictException(NOT_DRAFT);
    }
    if (asset.status === MediaAssetStatus.FAILED) {
      throw new ConflictException(UPLOAD_FAILED);
    }

    const check = await checkUpload(
      this.storage,
      this.scanner,
      asset,
      providerFileId,
      this.scanTimeoutMs,
    );
    if (check.status === 'missing') throw new ConflictException(NOT_UPLOADED);
    if (check.status !== 'ok') {
      const failed = await this.prisma.mediaAsset.update({
        where: { id },
        data: {
          status: MediaAssetStatus.FAILED,
          providerFileId: check.ref.providerFileId,
        },
        select: storedRefSelect,
      });
      await this.cleanup.purge('mediaAsset', [failed]);
      throw rejected(check.status);
    }

    let ready: MediaResponse | null;
    try {
      ready = await this.inDraft(ownerUserId, messageId, (tx) =>
        tx.mediaAsset.update({
          where: {
            ...this.ownedAsset(ownerUserId, messageId, id),
            status: MediaAssetStatus.PENDING_UPLOAD,
          },
          data: {
            status: MediaAssetStatus.READY,
            uploadedAt: new Date(),
            providerFileId: check.ref.providerFileId,
          },
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
      select: { status: true, ...storedRefSelect },
    });
    if (!asset) throw new NotFoundException(MEDIA_NOT_FOUND);
    if (asset.status !== MediaAssetStatus.READY) {
      throw new ConflictException(NOT_READY);
    }
    return {
      url: await this.storage.createAccessUrl(asset, this.accessTtl),
      expiresAt: expiresAt(this.accessTtl),
    };
  }

  // Soft delete first (under the draft lock), then best-effort file removal.
  // A provider failure never restores access; the cleanup reconciler retries.
  async remove(ownerUserId: string, messageId: string, id: string) {
    let deleted: Prisma.MediaAssetGetPayload<{
      select: typeof storedRefSelect;
    }> | null;
    try {
      deleted = await this.inDraft(ownerUserId, messageId, (tx) =>
        tx.mediaAsset.update({
          where: this.ownedAsset(ownerUserId, messageId, id),
          data: { deletedAt: new Date() },
          select: storedRefSelect,
        }),
      );
    } catch (err) {
      if (isNoMatch(err)) throw new NotFoundException(MEDIA_NOT_FOUND);
      throw err;
    }
    if (!deleted) throw await this.notDraft(ownerUserId, messageId);
    await this.cleanup.purge('mediaAsset', [deleted]);
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
}
