'use client';

import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useCurrentUser } from '@/hooks/use-auth';
import { type Draft, type DraftPayload, type DraftType, draftsApi } from '@/lib/api/drafts';
import { dropLocalDraft, type LocalDraft, localDraftKey, readLocalDraft, writeLocalDraft } from '@/lib/local-drafts';
import { isApiError, type ApiError } from '@/lib/api/errors';
import { queryKeys } from '@/lib/query/query-client';

/** After the last change; one request per pause, never per keystroke. */
export const AUTOSAVE_DELAY_MS = 2500;

// 'plan': the API refused the autosave (402, e.g. the trial ended); retrying can't help until a plan is active.
export type AutosaveStatus = 'idle' | 'saving' | 'saved' | 'error' | 'plan';

export type DraftEditor<P extends DraftPayload> = {
  /**
   * A recovered draft waiting for the Customer's decision (nothing autosaves meanwhile). `local`: kept only in this
   * browser tab after the server refused it (Step 7), so it is labelled "Not saved to your account."
   */
  offer: (Draft<P> & { local?: boolean }) | null;
  /** The latest words are kept in this tab only (the server refused them): shown with the plan status. */
  keptLocally: boolean;
  /** Fills the editor with the draft: returns its values; the caller sets them. */
  restore: () => P;
  discard: () => Promise<void>;
  /** The current edits differ from what the server holds (saved item or draft). */
  unsaved: boolean;
  status: AutosaveStatus;
  savedAt: Date | null;
  retry: () => void;
  /** The draft's key: for a new message, the one its explicit Save clears. */
  draftKey: () => string | null;
};

/**
 * Recovery + autosave for one editor. On open it asks the API for an unsaved
 * draft; until the Customer restores or discards it nothing is autosaved (so
 * it is never overwritten unseen). Then, while `active`, edits are stored
 * server-side 2.5 s after typing stops, and once more when the page is
 * hidden or closed (keepalive). Same content twice is never sent.
 */
export function useDraftEditor<P extends DraftPayload>({
  type,
  draftKey,
  baseRevision,
  saved,
  current,
  active,
  submitted = false,
}: {
  type: DraftType;
  /** null for a never-saved message: the server issues a key on first autosave. */
  draftKey: string | null;
  baseRevision: string;
  /** What is saved now: the editor's starting values. */
  saved: P;
  current: P;
  /** False while locked or while the explicit Save runs (and after it). */
  active: boolean;
  /** The explicit Save succeeded: a copy kept in this tab is no longer needed. */
  submitted?: boolean;
}): DraftEditor<P> {
  // Trial Step 7: per account, per editor; null until the session is known (then nothing is kept or offered).
  const userId = useCurrentUser().data?.id;
  const localKey = userId ? localDraftKey(userId, type, draftKey) : null;
  const recovery = useQuery<Draft | null, ApiError>({
    queryKey: queryKeys.draft(type, draftKey),
    queryFn: ({ signal }) => (draftKey ? draftsApi.get(type, draftKey, signal) : draftsApi.latestNew(signal)),
    staleTime: Infinity,
    gcTime: 0,
  });
  const [resolved, setResolved] = useState(false);
  const json = JSON.stringify(current);
  const savedJson = JSON.stringify(saved);
  // Read once per editor and account; a copy that matches what is saved now is simply dropped (nothing to recover).
  const [local, setLocal] = useState<{ key: string; draft: LocalDraft<P> | null } | null>(null);
  if (localKey && local?.key !== localKey) {
    const kept = readLocalDraft<P>(localKey);
    // A copy identical to what is saved now has nothing to recover: removed here, where the saved text is known.
    const same = !!kept && JSON.stringify(kept.payload) === savedJson;
    if (same) dropLocalDraft(localKey);
    setLocal({ key: localKey, draft: same ? null : kept });
  }
  const serverOffer = recovery.data ? (recovery.data as Draft<P>) : null;
  const localOffer =
    !serverOffer && recovery.isFetched && local?.draft
      ? { key: draftKey ?? '', payload: local.draft.payload, baseRevision, currentRevision: baseRevision, conflict: false, updatedAt: local.draft.updatedAt, local: true }
      : null;
  const offer: DraftEditor<P>['offer'] = resolved ? null : (serverOffer ?? localOffer);
  // A failed lookup must not block writing: autosave goes ahead.
  const ready = recovery.isError || (recovery.isSuccess && !offer);

  const [stored, setStoredState] = useState(() => JSON.stringify(saved));
  const [status, setStatus] = useState<AutosaveStatus>('idle');
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  // Mirrors for the async save (callbacks and timers outlive a render).
  const latest = useRef(json);
  const storedRef = useRef(stored);
  const key = useRef(draftKey);
  const busy = useRef(false);
  const again = useRef(false);
  const setStored = (value: string) => {
    storedRef.current = value;
    setStoredState(value);
  };

  useEffect(() => {
    latest.current = json;
  }, [json]);

  const save = useCallback(
    async function self(keepalive = false): Promise<void> {
      const body = latest.current;
      if (body === storedRef.current) return;
      if (busy.current) {
        again.current = true;
        return;
      }
      busy.current = true;
      setStatus('saving');
      try {
        const payload = JSON.parse(body) as DraftPayload;
        const draft = key.current
          ? await draftsApi.put(type, key.current, payload, baseRevision, keepalive)
          : await draftsApi.createNew(payload, keepalive);
        key.current = draft.key;
        storedRef.current = body;
        setStoredState(body);
        setSavedAt(new Date());
        setStatus('saved');
      } catch (err) {
        setStatus(isApiError(err) && err.kind === 'plan_required' ? 'plan' : 'error');
      } finally {
        busy.current = false;
        if (again.current) {
          again.current = false;
          void self();
        }
      }
    },
    [type, baseRevision],
  );

  // Stops after a plan refusal: no retry loop; the text stays in the editor, and (Step 7) in this tab only.
  const enabled = active && ready && status !== 'plan';
  const keepLocal = status === 'plan' && !!localKey && json !== savedJson;
  useEffect(() => {
    if (!keepLocal || !localKey) return;
    const timer = setTimeout(() => writeLocalDraft(localKey, JSON.parse(json)), 500);
    return () => clearTimeout(timer);
  }, [keepLocal, localKey, json]);
  // The server holds these words now (an autosave, the item itself, or the explicit Save): the tab copy goes.
  // Only real evidence that the server holds these words removes the tab copy: a successful autosave or the explicit
  // Save. (Not "the form equals the saved text": that is also true for a moment on every page load, before the copy is
  // offered, and would delete it unseen.)
  const serverHasIt = status === 'saved' || submitted;
  useEffect(() => {
    if (localKey && serverHasIt) dropLocalDraft(localKey);
  }, [localKey, serverHasIt]);
  useEffect(() => {
    if (!enabled || json === storedRef.current) return;
    const timer = setTimeout(() => void save(), AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [enabled, json, save]);

  // Last chance when the tab is hidden or closed; the debounce stays primary.
  useEffect(() => {
    if (!enabled) return;
    const flush = () => void save(true);
    const onVisibility = () => document.visibilityState === 'hidden' && flush();
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [enabled, save]);

  return {
    offer,
    keptLocally: keepLocal,
    restore: () => {
      const d = offer!;
      // In the editor's own field order (the API's JSON may order keys differently).
      const values = Object.fromEntries(Object.keys(saved).map((k) => [k, d.payload[k as keyof P]])) as unknown as P;
      // A tab copy isn't on the server: it stays "unsaved" (leave-page warning, autosave) until it is saved. Never sent
      // by itself: the Customer still presses Save.
      if (!d.local) {
        key.current = d.key;
        setStored(JSON.stringify(values));
      }
      setResolved(true);
      return values;
    },
    discard: async () => {
      if (offer!.local) {
        if (localKey) dropLocalDraft(localKey);
      } else {
        await draftsApi.discard(type, offer!.key);
      }
      setResolved(true);
    },
    unsaved: json !== stored,
    status,
    savedAt,
    retry: () => void save(),
    draftKey: () => key.current,
  };
}
