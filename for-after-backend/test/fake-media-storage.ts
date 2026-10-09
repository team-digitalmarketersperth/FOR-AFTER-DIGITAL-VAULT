import { vi } from 'vitest';
import type {
  StoredRef,
  UploadTarget,
} from '../src/media/storage/media-storage.service.js';

const ascii = (text: string) => [...Buffer.from(text, 'latin1')];

// Real leading bytes per allowlisted type, so the server's file-signature
// check runs for real against fake uploads.
const SIGNATURES: Record<string, number[]> = {
  'image/jpeg': [0xff, 0xd8, 0xff, 0xe0],
  'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  'image/webp': [...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBP')],
  'audio/wav': [...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WAVE')],
  'audio/mpeg': ascii('ID3'),
  'audio/mp4': [0, 0, 0, 0x20, ...ascii('ftypM4A ')],
  'video/mp4': [0, 0, 0, 0x20, ...ascii('ftypisom')],
  'audio/webm': [0x1a, 0x45, 0xdf, 0xa3],
  'video/webm': [0x1a, 0x45, 0xdf, 0xa3],
};
export const fileStart = (mimeType: string) =>
  new Uint8Array([
    ...(SIGNATURES[mimeType] ?? ascii('not a media file')),
    0,
    0,
  ]);

type StoredFile = {
  key: string;
  sizeBytes: number;
  contentType: string;
  isPrivate: boolean;
  bytes: Uint8Array;
};

/**
 * In-memory stand-in for the media provider (ImageKit in the app). No network,
 * no credentials. Every method is a vi.fn, so tests can assert calls or make
 * one fail. `upload` plays the browser's direct upload to the provider.
 */
export class FakeMediaStorage {
  readonly files = new Map<string, StoredFile>();
  private nextId = 1;

  createUpload = vi.fn(
    async (
      key: string,
      _contentType: string,
      _sizeBytes: number,
      _ttlSeconds: number,
    ): Promise<UploadTarget> => {
      const slash = key.lastIndexOf('/');
      return {
        url: 'https://upload.test/files',
        fields: {
          folder: key.slice(0, slash + 1),
          fileName: key.slice(slash + 1),
          token: 'signed-upload-token',
        },
      };
    },
  );

  verifyUpload = vi.fn(async (key: string, providerFileId: string) => {
    const file = this.files.get(providerFileId);
    if (!file || file.key !== key) return null;
    return {
      sizeBytes: file.sizeBytes,
      contentType: file.contentType,
      isPrivate: file.isPrivate,
      providerFileId,
    };
  });

  readStart = vi.fn(async (ref: StoredRef, bytes: number) =>
    (this.byKey(ref.storageKey)?.bytes ?? new Uint8Array()).slice(0, bytes),
  );

  openRead = vi.fn(async (ref: StoredRef, _signal: AbortSignal) => {
    const bytes = this.byKey(ref.storageKey)?.bytes ?? new Uint8Array();
    return (async function* () {
      yield bytes;
    })();
  });

  // A provider-side copy: same bytes and type, a new id at the new key.
  copyObject = vi.fn(
    async (source: StoredRef, key: string, _signal: AbortSignal) => {
      const file = this.byKey(source.storageKey);
      if (!file) throw new Error('missing source');
      const id = `file${this.nextId++}`;
      this.files.set(id, { ...file, key, isPrivate: true });
      return id;
    },
  );

  createAccessUrl = vi.fn(
    async (_ref: StoredRef, ttlSeconds: number) =>
      `https://media.test/signed?expires=${ttlSeconds}`,
  );

  deleteObject = vi.fn(async (ref: StoredRef) => {
    for (const [id, file] of this.files) {
      if (file.key === ref.storageKey) this.files.delete(id);
    }
  });

  /** The browser's POST to the provider; returns the provider file id. */
  upload(
    target: UploadTarget,
    file: {
      sizeBytes: number;
      contentType: string;
      bytes?: Uint8Array;
      isPrivate?: boolean;
    },
  ): string {
    const id = `file${this.nextId++}`;
    this.files.set(id, {
      key: target.fields.folder + target.fields.fileName,
      sizeBytes: file.sizeBytes,
      contentType: file.contentType,
      isPrivate: file.isPrivate ?? true,
      bytes: file.bytes ?? fileStart(file.contentType),
    });
    return id;
  }

  private byKey(key: string) {
    return [...this.files.values()].find((f) => f.key === key);
  }
}
