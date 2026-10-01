/** What storage reports about an uploaded object. */
export type StoredObject = { sizeBytes: number; contentType?: string };

/**
 * Provider-neutral object storage used by MediaService. Also the DI token:
 * MediaModule binds it to the S3-compatible adapter, tests bind a mock.
 * Implementations must never let credentials, signed URLs or raw provider
 * errors escape (throw a sanitized error instead).
 */
export abstract class MediaStorage {
  /** Presigned PUT for exactly this key and content type. */
  abstract createUploadUrl(
    key: string,
    contentType: string,
    ttlSeconds: number,
  ): Promise<string>;

  /** Presigned GET for this key. */
  abstract createAccessUrl(key: string, ttlSeconds: number): Promise<string>;

  /** Object metadata without downloading it; null when it does not exist. */
  abstract headObject(key: string): Promise<StoredObject | null>;

  /** Deleting a missing object succeeds. */
  abstract deleteObject(key: string): Promise<void>;
}
