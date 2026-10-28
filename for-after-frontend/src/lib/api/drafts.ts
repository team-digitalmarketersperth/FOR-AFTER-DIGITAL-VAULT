import { apiRequest } from './client';

/**
 * Server-side autosave of unsaved edits (draft recovery). Never browser
 * storage: drafts are private content and live only in the API, for the
 * signed-in Customer. A draft is not the saved item: the explicit Save is.
 */
export type DraftType = 'MESSAGE' | 'NEW_MESSAGE' | 'MY_STORY' | 'MY_WISHES';

/** Only the editor's text fields; the API refuses anything else. */
export type DraftPayload =
  | { title: string; contentType: string; textContent: string }
  | { textContent: string };

export type Draft<P extends DraftPayload = DraftPayload> = {
  key: string;
  payload: P;
  baseRevision: string;
  currentRevision: string;
  /** The saved item changed after this draft started (another tab or device). */
  conflict: boolean;
  updatedAt: string;
};

const path = (type: DraftType, key: string) => `/users/me/drafts/${type}/${encodeURIComponent(key)}`;
// The API answers "nothing to recover" with an empty body.
const orNull = <T,>(d: T | undefined) => d ?? null;

export const draftsApi = {
  get: (type: DraftType, key: string, signal?: AbortSignal) =>
    apiRequest<Draft | undefined>(path(type, key), { signal }).then(orNull),
  /** The newest never-saved new message. */
  latestNew: (signal?: AbortSignal) =>
    apiRequest<Draft | undefined>('/users/me/drafts/NEW_MESSAGE', { signal }).then(orNull),
  /** First autosave of a never-saved message: the server issues its key. */
  createNew: (payload: DraftPayload, keepalive?: boolean) =>
    apiRequest<Draft>('/users/me/drafts/NEW_MESSAGE', { method: 'POST', body: { payload }, keepalive }),
  put: (type: DraftType, key: string, payload: DraftPayload, baseRevision: string, keepalive?: boolean) =>
    apiRequest<Draft>(path(type, key), { method: 'PUT', body: { payload, baseRevision }, keepalive }),
  discard: (type: DraftType, key: string) => apiRequest<void>(path(type, key), { method: 'DELETE' }),
};

/**
 * Base revision of a My Story / My Wishes answer: FNV-1a of its saved text,
 * identical to the API's textRevision (same test vectors on both sides).
 */
export function textRevision(text: string | null | undefined) {
  let h = 0x811c9dc5;
  for (const c of text ?? '') {
    h ^= c.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `t${h.toString(16).padStart(8, '0')}`;
}
