import ImageKit, {
  APIError,
  BadRequestError,
  NotFoundError,
} from '@imagekit/nodejs';
import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import { MediaStorageProvider } from '../../generated/prisma/client.js';
import {
  LegacyB2MediaStorage,
  legacyB2Configured,
} from './legacy-b2-media-storage.service.js';
import {
  MediaStorage,
  type StoredObject,
  type StoredRef,
  type UploadTarget,
} from './media-storage.service.js';

const REQUIRED = [
  'IMAGEKIT_PUBLIC_KEY',
  'IMAGEKIT_PRIVATE_KEY',
  'IMAGEKIT_URL_ENDPOINT',
] as const;

/** ImageKit Upload API V2: every parameter is fixed by the signed JWT. */
export const IMAGEKIT_UPLOAD_URL =
  'https://upload.imagekit.io/api/v2/files/upload';
// ImageKit refuses a token living longer than an hour.
const MAX_TOKEN_SECONDS = 3600;

/**
 * The V2 upload token: an HS256 JWT (kid = public key) whose payload holds
 * every upload parameter as a string, plus iat/exp. ImageKit rejects an
 * upload whose form fields differ from the payload.
 */
export const signUploadToken = (
  payload: Record<string, string>,
  publicKey: string,
  privateKey: string,
  ttlSeconds: number,
  now = Date.now(),
) => {
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  const iat = Math.floor(now / 1000);
  const unsigned = `${encode({ alg: 'HS256', typ: 'JWT', kid: publicKey })}.${encode(
    { ...payload, iat, exp: iat + Math.min(ttlSeconds, MAX_TOKEN_SECONDS) },
  )}`;
  const signature = createHmac('sha256', privateKey)
    .update(unsigned)
    .digest('base64url');
  return `${unsigned}.${signature}`;
};

/** "/a/b/c.jpg" → folder "/a/b/", fileName "c.jpg". */
const splitKey = (key: string) => {
  const slash = key.lastIndexOf('/');
  return { folder: key.slice(0, slash + 1), fileName: key.slice(slash + 1) };
};

// Only these reach logs: the SDK error class and HTTP status (SDK errors
// keep name "Error", so the class name is used).
const errorInfo = (err: unknown) =>
  err instanceof APIError
    ? `${err.constructor.name}, HTTP ${err.status ?? '?'}`
    : err instanceof Error
      ? err.name
      : 'UNKNOWN';

/**
 * The active media provider (Phase 12): every new PHOTO/AUDIO/VIDEO upload goes
 * to ImageKit as a private file (only signed, expiring URLs serve it) at a
 * server-chosen path. The one place the ImageKit SDK is used. Rows still on
 * Backblaze B2 are served and deleted through the legacy adapter. Missing
 * config stops the app at startup: there is no fallback storage.
 */
@Injectable()
export class ImageKitMediaStorage extends MediaStorage {
  private readonly logger = new Logger(ImageKitMediaStorage.name);
  private readonly client: ImageKit;
  private readonly publicKey: string;
  private readonly privateKey: string;
  private readonly urlEndpoint: string;
  private readonly legacy: LegacyB2MediaStorage | null;

  constructor(config: ConfigService) {
    super();
    const missing = REQUIRED.filter((key) => !config.get<string>(key)?.trim());
    if (missing.length) {
      throw new Error(
        `Media storage is not configured. Set ${missing.join(', ')} in .env.`,
      );
    }
    const get = (key: (typeof REQUIRED)[number]) =>
      config.get<string>(key)!.trim();
    this.publicKey = get('IMAGEKIT_PUBLIC_KEY');
    this.privateKey = get('IMAGEKIT_PRIVATE_KEY');
    this.urlEndpoint = get('IMAGEKIT_URL_ENDPOINT');
    this.client = new ImageKit({ privateKey: this.privateKey });
    this.legacy = legacyB2Configured(config)
      ? new LegacyB2MediaStorage(config)
      : null;
  }

  createUpload(
    key: string,
    _contentType: string,
    sizeBytes: number,
    ttlSeconds: number,
  ): Promise<UploadTarget> {
    const { folder, fileName } = splitKey(key);
    // Private, exactly this path, never replacing a file, at most the declared
    // size. The type is checked on complete (provider MIME + file signature).
    const fields = {
      fileName,
      folder,
      isPrivateFile: 'true',
      useUniqueFileName: 'false',
      overwriteFile: 'false',
      checks: `"file.size" <= ${sizeBytes}`,
    };
    const token = signUploadToken(
      fields,
      this.publicKey,
      this.privateKey,
      ttlSeconds,
    );
    return Promise.resolve({
      url: IMAGEKIT_UPLOAD_URL,
      fields: { ...fields, token },
    });
  }

  async verifyUpload(
    key: string,
    providerFileId: string,
  ): Promise<StoredObject | null> {
    try {
      const file = await this.client.files.get(providerFileId);
      // Another path means it is not this upload (or not this user's).
      if (file.filePath !== key) return null;
      return {
        sizeBytes: file.size ?? 0,
        contentType: file.mime,
        isPrivate: file.isPrivateFile,
        providerFileId: file.fileId,
      };
    } catch (err) {
      if (err instanceof NotFoundError || err instanceof BadRequestError) {
        return null;
      }
      throw this.unavailable('verify', err);
    }
  }

  async readStart(ref: StoredRef, bytes: number): Promise<Uint8Array> {
    if (ref.storageProvider !== MediaStorageProvider.IMAGEKIT) {
      throw this.unavailable('read', new Error('LegacyRead'));
    }
    try {
      const res = await fetch(this.signedUrl(ref.storageKey, 60), {
        headers: { Range: `bytes=0-${bytes - 1}` },
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      // Never download a whole video for a few header bytes.
      const reader = res.body.getReader();
      const { value } = await reader.read();
      await reader.cancel();
      return (value ?? new Uint8Array()).slice(0, bytes);
    } catch (err) {
      throw this.unavailable('read', err);
    }
  }

  // Streamed, never buffered whole: the caller bounds size and time.
  async openRead(
    ref: StoredRef,
    signal: AbortSignal,
  ): Promise<AsyncIterable<Uint8Array>> {
    if (ref.storageProvider !== MediaStorageProvider.IMAGEKIT) {
      throw this.unavailable('read', new Error('LegacyRead'));
    }
    try {
      const res = await fetch(this.signedUrl(ref.storageKey, 60), { signal });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      return res.body;
    } catch (err) {
      throw this.unavailable('read', err);
    }
  }

  // ImageKit's copy API keeps the source file name and returns no file id
  // (files.copy -> void), so the bytes are re-uploaded to the exact new path
  // instead: private, no overwrite, and the new fileId comes back at once.
  // The source is read through its own short-lived signed URL (B2 included).
  // ponytail: the SDK buffers the upload (<= 25 MB for Memory Vault media); stream it if larger files are ever copied.
  async copyObject(
    source: StoredRef,
    key: string,
    signal: AbortSignal,
  ): Promise<string> {
    try {
      const res = await fetch(await this.createAccessUrl(source, 60), {
        signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { folder, fileName } = splitKey(key);
      const file = await this.client.files.upload(
        {
          file: res,
          fileName,
          folder,
          isPrivateFile: true,
          useUniqueFileName: false,
          overwriteFile: false,
        },
        { signal },
      );
      if (!file.fileId) throw new Error('NoFileId');
      return file.fileId;
    } catch (err) {
      throw this.unavailable('copy', err);
    }
  }

  async createAccessUrl(ref: StoredRef, ttlSeconds: number): Promise<string> {
    if (ref.storageProvider === MediaStorageProvider.B2) {
      return this.legacyStorage().createAccessUrl(ref.storageKey, ttlSeconds);
    }
    return this.signedUrl(ref.storageKey, ttlSeconds);
  }

  async deleteObject(ref: StoredRef): Promise<void> {
    if (ref.storageProvider === MediaStorageProvider.B2) {
      return this.legacyStorage().deleteObject(ref.storageKey);
    }
    try {
      // No id yet (never completed): look the file up at its own path.
      const fileId =
        ref.providerFileId ?? (await this.findFileId(ref.storageKey));
      if (fileId) await this.client.files.delete(fileId);
    } catch (err) {
      if (err instanceof NotFoundError) return;
      throw this.unavailable('delete', err);
    }
  }

  // The original file as uploaded (orig-true: no optimization, no video
  // processing), signed with an expiry. The private file serves nothing else.
  private signedUrl(key: string, ttlSeconds: number) {
    return this.client.helper.buildSrc({
      urlEndpoint: this.urlEndpoint,
      src: key,
      transformation: [{ original: true }],
      expiresIn: ttlSeconds,
    });
  }

  private async findFileId(key: string) {
    // The list API matches a folder given without its trailing slash (an
    // upload's "folder" has one), and lags a few seconds behind new uploads;
    // MediaCleanup only looks up id-less rows once their upload token has
    // expired. Both checked against ImageKit, 2026-10-07.
    const path = splitKey(key).folder.replace(/\/$/, '');
    const files = await this.client.assets.list({ path, type: 'file' });
    return files.find((f) => f.filePath === key)?.fileId ?? null;
  }

  private legacyStorage() {
    if (this.legacy) return this.legacy;
    throw this.unavailable('legacy', new Error('LegacyB2NotConfigured'));
  }

  // Raw SDK errors can carry paths, ids or account details: log the category
  // only and give the client a generic 503.
  private unavailable(operation: string, err: unknown) {
    this.logger.error(`Media storage ${operation} failed (${errorInfo(err)})`);
    return new ServiceUnavailableException(
      'Media storage is temporarily unavailable.',
    );
  }
}
