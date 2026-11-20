/**
 * Trial Step 7 (approved): when the server refuses an autosave because the plan doesn't include editing (402), the
 * unsaved words are kept in this browser tab only (sessionStorage), so a reload or a trip to the plan page doesn't lose
 * them. Never permanent: the tab closing, sign-out, another person signing in or clearing site data removes them, and
 * the app says "Not saved to your account." Keys carry the account id, so one person's text is never offered to another.
 * Every access is guarded: storage can be unavailable (private mode, blocked site data) and then nothing is kept.
 */
const PREFIX = 'for-after:unsaved:';

export type LocalDraft<P> = { payload: P; updatedAt: string };

export const localDraftKey = (userId: string, type: string, key: string | null) =>
  `${PREFIX}${userId}:${type}:${key ?? 'new'}`;

export function readLocalDraft<P>(storageKey: string): LocalDraft<P> | null {
  try {
    const raw = sessionStorage.getItem(storageKey);
    return raw ? (JSON.parse(raw) as LocalDraft<P>) : null;
  } catch {
    return null;
  }
}

export function writeLocalDraft(storageKey: string, payload: unknown) {
  try {
    sessionStorage.setItem(storageKey, JSON.stringify({ payload, updatedAt: new Date().toISOString() }));
  } catch {
    // Unavailable or full: the text stays in the open form, as before.
  }
}

export function dropLocalDraft(storageKey: string) {
  try {
    sessionStorage.removeItem(storageKey);
  } catch {
    // Nothing to do.
  }
}

/** On sign-in, sign-out and session expiry: removes every kept draft that isn't this account's (all of them when signed out). */
export function clearLocalDrafts(keepUserId?: string | null) {
  try {
    const keep = keepUserId ? `${PREFIX}${keepUserId}:` : null;
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const k = sessionStorage.key(i);
      if (k?.startsWith(PREFIX) && !(keep && k.startsWith(keep))) sessionStorage.removeItem(k);
    }
  } catch {
    // Nothing to do.
  }
}
