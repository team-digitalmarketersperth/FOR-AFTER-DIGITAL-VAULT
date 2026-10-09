import { MediaStorageProvider } from '../../generated/prisma/client.js';

/** What the provider reports about an uploaded file. */
export type StoredObject = {
  sizeBytes: number;
  contentType?: string;
  /** false = the provider would serve it without a signature. */
  isPrivate?: boolean;
  providerFileId?: string;
};

/** A stored file as recorded in PostgreSQL (any media table). */
export type StoredRef = {
  storageKey: string;
  storageProvider: MediaStorageProvider;
  providerFileId: string | null;
};

/**
 * A direct browser upload: multipart POST of `fields` plus the file as `file`
 * to `url`. Every field is part of a server-made signature, so the browser can
 * change none of them (path, privacy, size check).
 */
export type UploadTarget = { url: string; fields: Record<string, string> };

/**
 * Provider-neutral media storage used by every media service. Also the DI
 * token: MediaModule binds it to ImageKitMediaStorage, tests bind a fake.
 * New uploads always go to the active provider; reads and deletes follow the
 * row's storageProvider. Implementations must never let credentials, signed
 * URLs or raw provider errors escape (throw a sanitized error instead).
 */
export abstract class MediaStorage {
  /** Signed direct-upload instructions for exactly this key, type and size. */
  abstract createUpload(
    key: string,
    contentType: string,
    sizeBytes: number,
    ttlSeconds: number,
  ): Promise<UploadTarget>;

  /**
   * The uploaded file, looked up by the provider id the browser reported, but
   * only if it really sits at `key`; otherwise null (never someone else's).
   */
  abstract verifyUpload(
    key: string,
    providerFileId: string,
  ): Promise<StoredObject | null>;

  /** The first bytes of a stored file, for file-signature checks. */
  abstract readStart(ref: StoredRef, bytes: number): Promise<Uint8Array>;

  /** The whole stored file as a stream, for malware scanning; `signal` aborts it. */
  abstract openRead(
    ref: StoredRef,
    signal: AbortSignal,
  ): Promise<AsyncIterable<Uint8Array>>;

  /**
   * Server-side copy of a stored file to a new key (private, never replacing
   * a file); returns the new file's provider id. The copy is untrusted until
   * checked like any upload (checkUpload). `signal` aborts it.
   */
  abstract copyObject(
    source: StoredRef,
    key: string,
    signal: AbortSignal,
  ): Promise<string>;

  /** Short-lived signed GET for this file. */
  abstract createAccessUrl(ref: StoredRef, ttlSeconds: number): Promise<string>;

  /** Deleting a missing file succeeds. */
  abstract deleteObject(ref: StoredRef): Promise<void>;
}
