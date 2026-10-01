import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MediaStorage, type StoredObject } from './media-storage.service.js';

const REQUIRED = [
  'OBJECT_STORAGE_REGION',
  'OBJECT_STORAGE_BUCKET',
  'OBJECT_STORAGE_ENDPOINT',
  'OBJECT_STORAGE_ACCESS_KEY_ID',
  'OBJECT_STORAGE_SECRET_ACCESS_KEY',
] as const;

// Only these reach logs: the provider's error name and HTTP status.
const errorInfo = (err: unknown) =>
  err instanceof S3ServiceException
    ? `${err.name}, HTTP ${err.$metadata.httpStatusCode ?? '?'}`
    : err instanceof Error
      ? err.name
      : 'UNKNOWN';

/**
 * Any S3-compatible bucket (Backblaze B2 in development; AWS S3, R2 or MinIO
 * by configuration only). The one place an S3Client is built. Missing config
 * stops the app at startup: there is no fallback storage.
 */
@Injectable()
export class S3MediaStorage extends MediaStorage {
  private readonly logger = new Logger(S3MediaStorage.name);
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: ConfigService) {
    super();
    const missing = REQUIRED.filter((key) => !config.get<string>(key)?.trim());
    if (missing.length) {
      throw new Error(
        `Object storage is not configured. Set ${missing.join(', ')} in .env.`,
      );
    }
    const get = (key: (typeof REQUIRED)[number]) =>
      config.get<string>(key)!.trim();
    // Signing uses the region, so a hostname here fails every request.
    if (get('OBJECT_STORAGE_REGION').includes('.')) {
      throw new Error(
        'OBJECT_STORAGE_REGION must be a region such as us-east-005, not a hostname.',
      );
    }
    this.bucket = get('OBJECT_STORAGE_BUCKET');
    this.client = new S3Client({
      region: get('OBJECT_STORAGE_REGION'),
      endpoint: get('OBJECT_STORAGE_ENDPOINT'),
      credentials: {
        accessKeyId: get('OBJECT_STORAGE_ACCESS_KEY_ID'),
        secretAccessKey: get('OBJECT_STORAGE_SECRET_ACCESS_KEY'),
      },
      forcePathStyle:
        config.get<string>('OBJECT_STORAGE_FORCE_PATH_STYLE') === 'true',
      // Newer SDKs add CRC checksums to uploads by default, which a presigned
      // PUT from Postman/browsers cannot supply; only use them when required.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  // Content-Type is part of the signature, so the upload must send exactly it.
  createUploadUrl(key: string, contentType: string, ttlSeconds: number) {
    return getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
      }),
      // The presigner signs only host unless told otherwise.
      { expiresIn: ttlSeconds, signableHeaders: new Set(['content-type']) },
    );
  }

  createAccessUrl(key: string, ttlSeconds: number) {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: ttlSeconds },
    );
  }

  async headObject(key: string): Promise<StoredObject | null> {
    try {
      const head = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        sizeBytes: head.ContentLength ?? 0,
        contentType: head.ContentType,
      };
    } catch (err) {
      if (
        err instanceof S3ServiceException &&
        err.$metadata.httpStatusCode === 404
      ) {
        return null;
      }
      throw this.unavailable('head', err);
    }
  }

  async deleteObject(key: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
      );
    } catch (err) {
      throw this.unavailable('delete', err);
    }
  }

  // Raw SDK errors can carry bucket, key or endpoint details: log the category
  // only and give the client a generic 503.
  private unavailable(operation: string, err: unknown) {
    this.logger.error(`Object storage ${operation} failed (${errorInfo(err)})`);
    return new ServiceUnavailableException(
      'Media storage is temporarily unavailable.',
    );
  }
}
