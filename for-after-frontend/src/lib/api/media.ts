import { toQuery, type Page } from './admin';
import { apiRequest } from './client';
import { ApiError } from './errors';

// Message media and Memory Vault media share one contract under different
// owners. File bytes never pass through the API: the browser uploads them
// straight to the private media provider (ImageKit) with a short-lived,
// server-signed upload token, and views them through short-lived signed URLs.
export type MediaScope =
  | { kind: 'messages'; id: string }
  | { kind: 'memory-vault'; id: string }
  // A released message, viewed by a signed-in Recipient (read-only).
  | { kind: 'recipient/messages'; id: string }
  // Phase 09: a Person I Love's profile photo (PHOTO only, one current).
  | { kind: 'recipients'; id: string }
  // Phase 14B / 15B: a My Story answer or a wish, by prompt key (PHOTO/AUDIO/VIDEO).
  | { kind: 'my-story' | 'my-wishes'; id: string };

// VIDEO: message media only (Phase 12).
export type MediaKind = 'PHOTO' | 'AUDIO' | 'VIDEO';
export type MediaStatus = 'PENDING_UPLOAD' | 'READY' | 'FAILED';

export type MediaAsset = {
  id: string;
  kind: MediaKind;
  status: MediaStatus;
  originalFileName: string;
  mimeType: string;
  sizeBytes: number;
  uploadedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

// Multipart POST of `fields` plus the file (as `file`) to `url`. Every field
// is part of the server's signature: the browser cannot change any of them.
export type UploadTarget = { url: string; fields: Record<string, string> };
type UploadUrl = {
  mediaAssetId: string;
  upload: UploadTarget;
  expiresAt: string;
};

export type AccessUrl = { url: string; expiresAt: string };

// The backend allowlist (CreateMediaUploadDto.MIME_TYPES). No SVG.
export const MIME_TYPES: Record<MediaKind, readonly string[]> = {
  PHOTO: ['image/jpeg', 'image/png', 'image/webp'],
  AUDIO: ['audio/mpeg', 'audio/mp4', 'audio/webm', 'audio/wav'],
  VIDEO: ['video/mp4', 'video/webm'],
};
// Backend defaults (MEDIA_*_MAX_BYTES), set by the ImageKit Free plan's upload
// limits. The server may be configured differently and stays authoritative;
// this is early feedback.
export const MAX_BYTES: Record<MediaKind, number> = {
  PHOTO: 20 * 1024 * 1024,
  AUDIO: 25 * 1024 * 1024,
  VIDEO: 100 * 1024 * 1024,
};
const TYPE_HINT: Record<MediaKind, string> = {
  PHOTO: 'Please choose a JPEG, PNG or WebP photo.',
  AUDIO: 'Please choose an MP3, M4A, WebM or WAV audio file.',
  VIDEO: 'Please choose an MP4 or WebM video.',
};

// Backend default RECIPIENT_PHOTO_MAX_BYTES (Phase 09); the server stays authoritative.
export const RECIPIENT_PHOTO_MAX_BYTES = 5 * 1024 * 1024;

/** Client-side check before asking for an upload URL; null when acceptable. */
export function checkFile(
  kind: MediaKind,
  file: Pick<File, 'type' | 'size'>,
  maxBytes = MAX_BYTES[kind],
): string | null {
  // file.type comes from the browser's sniffing/OS mapping, not only the name.
  const type = file.type.split(';')[0].trim().toLowerCase();
  if (!MIME_TYPES[kind].includes(type)) return TYPE_HINT[kind];
  if (file.size <= 0) return 'This file is empty.';
  if (file.size > maxBytes) {
    return `This file is larger than ${maxBytes / 1024 / 1024} MB.`;
  }
  return null;
}

const base = (scope: MediaScope) =>
  scope.kind === 'recipients'
    ? `/recipients/${scope.id}/photo`
    : scope.kind === 'my-story' || scope.kind === 'my-wishes'
      ? `/${scope.kind}/prompts/${encodeURIComponent(scope.id)}/response/media`
      : `/${scope.kind}/${scope.id}/media`;

/** GET /users/me/storage (Phase 12C): READY bytes used, uploads in progress reserved. */
export type StorageLevel = 'NORMAL' | 'WARNING' | 'HIGH' | 'FULL';
export const STORAGE_SOURCES = ['MESSAGE', 'MEMORY_VAULT', 'MY_STORY', 'MY_WISHES', 'RECIPIENT_PHOTO'] as const;
export type StorageSource = (typeof STORAGE_SOURCES)[number];
export type StorageUsage = {
  usedBytes: number;
  reservedBytes: number;
  limitBytes: number;
  remainingBytes: number;
  percentage: number;
  level: StorageLevel;
  /** READY bytes per source; sums to usedBytes. */
  breakdown: { source: StorageSource; bytes: number }[];
};

/**
 * Storage Manager (GET /users/me/storage/items): one counted file. `sourceId`
 * is what the source feature's routes use (message, memory, prompt key or
 * Recipient id). No URL, storage key or provider id is ever included.
 */
export type StorageItem = {
  id: string;
  type: MediaKind;
  sizeBytes: number;
  source: StorageSource;
  sourceId: string;
  displayName: string;
  createdAt: string;
  canDelete: boolean;
  deleteRestriction: 'MESSAGE_SCHEDULED' | 'MESSAGE_RELEASED' | 'MESSAGE_LOCKED' | null;
};
export const STORAGE_SORTS = ['size_desc', 'created_desc', 'created_asc'] as const;
export type StorageSort = (typeof STORAGE_SORTS)[number];
export type StorageFilters = { type?: MediaKind; source?: StorageSource; sort?: StorageSort; page?: number };

/** The source feature's own media scope: Storage Manager deletes through it, never around it. */
export const storageItemScope = (item: StorageItem): MediaScope => {
  switch (item.source) {
    case 'MESSAGE':
      return { kind: 'messages', id: item.sourceId };
    case 'MEMORY_VAULT':
      return { kind: 'memory-vault', id: item.sourceId };
    case 'MY_STORY':
      return { kind: 'my-story', id: item.sourceId };
    case 'MY_WISHES':
      return { kind: 'my-wishes', id: item.sourceId };
    case 'RECIPIENT_PHOTO':
      return { kind: 'recipients', id: item.sourceId };
  }
};

/** Where the file is managed in the app. */
export const storageItemHref = ({ source, sourceId }: StorageItem) =>
  ({
    MESSAGE: `/messages/${sourceId}`,
    MEMORY_VAULT: `/memory-vault/${sourceId}`,
    MY_STORY: `/my-story/${encodeURIComponent(sourceId)}`,
    MY_WISHES: `/my-wishes/${encodeURIComponent(sourceId)}`,
    RECIPIENT_PHOTO: `/people/${sourceId}`,
  })[source];

export const storageApi = {
  usage: (signal?: AbortSignal) => apiRequest<StorageUsage>('/users/me/storage', { signal }),
  items: (filters: StorageFilters, signal?: AbortSignal) =>
    apiRequest<Page<StorageItem>>(`/users/me/storage/items${toQuery(filters)}`, { signal }),
};

export const mediaApi = {
  list: async (scope: MediaScope, signal?: AbortSignal) => {
    const items = await apiRequest<MediaAsset[]>(base(scope), { signal });
    // The Recipient API lists READY files only and sends no status.
    return scope.kind === 'recipient/messages' ? items.map((m) => ({ ...m, status: 'READY' as const })) : items;
  },
  requestUpload: (scope: MediaScope, kind: MediaKind, file: Pick<File, 'name' | 'type' | 'size'>) =>
    apiRequest<UploadUrl>(`${base(scope)}/upload-url`, {
      method: 'POST',
      body: {
        kind,
        originalFileName: file.name.slice(0, 255) || 'recording',
        mimeType: file.type.split(';')[0].trim().toLowerCase(),
        sizeBytes: file.size,
      },
    }),
  /** The backend verifies the provider's file (path, size, type); READY on success. */
  complete: (scope: MediaScope, assetId: string, providerFileId: string) =>
    apiRequest<MediaAsset>(`${base(scope)}/${assetId}/complete`, {
      method: 'POST',
      body: { providerFileId },
    }),
  accessUrl: (scope: MediaScope, assetId: string, signal?: AbortSignal) =>
    apiRequest<AccessUrl>(`${base(scope)}/${assetId}/access-url`, { signal }),
  remove: (scope: MediaScope, assetId: string) =>
    apiRequest<void>(`${base(scope)}/${assetId}`, { method: 'DELETE' }),
};

/**
 * Upload the file straight to the media provider: a multipart POST of the
 * signed fields plus the file. XMLHttpRequest (not fetch) because it reports
 * upload progress. No cookies go to the provider. Resolves with the provider's
 * file id (only a hint: the backend verifies the file itself). Rejects with an
 * ApiError, or a DOMException "AbortError" on cancel.
 */
export function uploadToProvider(
  upload: UploadTarget,
  file: Blob,
  { onProgress, signal }: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    // Cancelled while the upload URL was still being issued: never send the bytes.
    if (signal?.aborted) return reject(new DOMException('Upload cancelled', 'AbortError'));
    const form = new FormData();
    for (const [name, value] of Object.entries(upload.fields)) form.append(name, value);
    form.append('file', file);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', upload.url);
    xhr.responseType = 'json';
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded / e.total);
    };
    const refused = () => new ApiError('server', xhr.status, 'The upload was not accepted. Please try again.');
    xhr.onload = () => {
      const fileId = (xhr.response as { fileId?: unknown } | null)?.fileId;
      if (xhr.status >= 200 && xhr.status < 300 && typeof fileId === 'string') resolve(fileId);
      else reject(refused());
    };
    xhr.onerror = () =>
      reject(new ApiError('network', null, "We couldn't upload this file. Please check your connection and try again."));
    xhr.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'));
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(form);
  });
}
