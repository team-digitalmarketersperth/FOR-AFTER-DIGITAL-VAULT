import {
  DeleteObjectCommand,
  GetObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Logger, ServiceUnavailableException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

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

/** Whether the old bucket's settings are present (legacy reads are possible). */
export const legacyB2Configured = (config: ConfigService) =>
  REQUIRED.every((key) => config.get<string>(key)?.trim());

/**
 * LEGACY, read and delete only: media uploaded to the Backblaze B2 bucket
 * before Phase 12 moved every new upload to ImageKit. Rows with
 * storageProvider B2 stay viewable (short-lived presigned GET) and deletable by
 * their owner; nothing is ever uploaded here and nothing is deleted
 * automatically. Remove once no live B2 row remains (docs/media-storage.md).
 */
export class LegacyB2MediaStorage {
  private readonly logger = new Logger(LegacyB2MediaStorage.name);
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: ConfigService) {
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
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  createAccessUrl(key: string, ttlSeconds: number) {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: ttlSeconds },
    );
  }

  async deleteObject(key: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
      );
    } catch (err) {
      // Already gone counts as deleted.
      if (
        err instanceof S3ServiceException &&
        err.$metadata.httpStatusCode === 404
      ) {
        return;
      }
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
