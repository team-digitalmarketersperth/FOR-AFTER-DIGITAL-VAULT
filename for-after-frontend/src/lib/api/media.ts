import { apiRequest } from './client';
import { ApiError } from './errors';

// Message media and Memory Vault media share one contract under different
// owners. File bytes never pass through the API: the browser PUTs them straight
// to private object storage with a short-lived presigned URL.
export type MediaScope =
  | { kind: 'messages'; id: string }
  | { kind: 'memory-vault'; id: string }
  // A released message, viewed by a signed-in Recipient (read-only).
  | { kind: 'recipient/messages'; id: string }
  // Phase 09: a Person I Love's profile photo (PHOTO only, one current).
  | { kind: 'recipients'; id: string };

export type MediaKind = 'PHOTO' | 'AUDIO';
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

type UploadUrl = {
  mediaAssetId: string;
  uploadUrl: string;
  expiresAt: string;
  requiredHeaders: { 'Content-Type': string };
};

export type AccessUrl = { url: string; expiresAt: string };

// The backend allowlist (CreateMediaUploadDto.MIME_TYPES). No SVG, no video.
export const MIME_TYPES: Record<MediaKind, readonly string[]> = {
  PHOTO: ['image/jpeg', 'image/png', 'image/webp'],
  AUDIO: ['audio/mpeg', 'audio/mp4', 'audio/webm', 'audio/wav'],
};
// Backend defaults (MEDIA_PHOTO_MAX_BYTES / MEDIA_AUDIO_MAX_BYTES). The server
// may be configured differently and stays authoritative; this is early feedback.
export const MAX_BYTES: Record<MediaKind, number> = {
  PHOTO: 20 * 1024 * 1024,
  AUDIO: 100 * 1024 * 1024,
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
  if (!MIME_TYPES[kind].includes(type)) {
    return kind === 'PHOTO'
      ? 'Please choose a JPEG, PNG or WebP photo.'
      : 'Please choose an MP3, M4A, WebM or WAV audio file.';
  }
  if (file.size <= 0) return 'This file is empty.';
  if (file.size > maxBytes) {
    return `This file is larger than ${maxBytes / 1024 / 1024} MB.`;
  }
  return null;
}

const base = (scope: MediaScope) =>
  scope.kind === 'recipients' ? `/recipients/${scope.id}/photo` : `/${scope.kind}/${scope.id}/media`;

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
  /** Backend HEAD-checks the stored object; READY on success. */
  complete: (scope: MediaScope, assetId: string) =>
    apiRequest<MediaAsset>(`${base(scope)}/${assetId}/complete`, { method: 'POST' }),
  accessUrl: (scope: MediaScope, assetId: string, signal?: AbortSignal) =>
    apiRequest<AccessUrl>(`${base(scope)}/${assetId}/access-url`, { signal }),
  remove: (scope: MediaScope, assetId: string) =>
    apiRequest<void>(`${base(scope)}/${assetId}`, { method: 'DELETE' }),
};

/**
 * PUT the file to storage. XMLHttpRequest (not fetch) because it reports upload
 * progress. No cookies go to storage; only the Content-Type the URL was signed
 * with. Rejects with an ApiError, or a DOMException "AbortError" on cancel.
 */
export function putToStorage(
  upload: Pick<UploadUrl, 'uploadUrl' | 'requiredHeaders'>,
  file: Blob,
  { onProgress, signal }: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', upload.uploadUrl);
    xhr.setRequestHeader('Content-Type', upload.requiredHeaders['Content-Type']);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded / e.total);
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new ApiError('server', xhr.status, 'The upload was not accepted. Please try again.'));
    // Also what a storage CORS refusal looks like from the browser.
    xhr.onerror = () =>
      reject(new ApiError('network', null, "We couldn't upload this file. Please check your connection and try again."));
    xhr.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'));
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(file);
  });
}
