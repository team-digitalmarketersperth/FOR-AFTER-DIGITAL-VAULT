'use client';

import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type Draft, type DraftPayload, type DraftType, draftsApi } from '@/lib/api/drafts';
import type { ApiError } from '@/lib/api/errors';
import { queryKeys } from '@/lib/query/query-client';

/** After the last change; one request per pause, never per keystroke. */
export const AUTOSAVE_DELAY_MS = 2500;

export type AutosaveStatus = 'idle' | 'saving' | 'saved' | 'error';

export type DraftEditor<P extends DraftPayload> = {
  /** A recovered draft waiting for the Customer's decision (nothing autosaves meanwhile). */
  offer: Draft<P> | null;
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
}): DraftEditor<P> {
  const recovery = useQuery<Draft | null, ApiError>({
    queryKey: queryKeys.draft(type, draftKey),
    queryFn: ({ signal }) => (draftKey ? draftsApi.get(type, draftKey, signal) : draftsApi.latestNew(signal)),
    staleTime: Infinity,
    gcTime: 0,
  });
  const [resolved, setResolved] = useState(false);
  const offer = !resolved && recovery.data ? (recovery.data as Draft<P>) : null;
  // A failed lookup must not block writing: autosave goes ahead.
  const ready = recovery.isError || (recovery.isSuccess && !offer);

  const json = JSON.stringify(current);
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
      } catch {
        setStatus('error');
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

  const enabled = active && ready;
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
    restore: () => {
      const d = offer!;
      // In the editor's own field order (the API's JSON may order keys differently).
      const values = Object.fromEntries(Object.keys(saved).map((k) => [k, d.payload[k as keyof P]])) as unknown as P;
      key.current = d.key;
      setStored(JSON.stringify(values));
      setResolved(true);
      return values;
    },
    discard: async () => {
      await draftsApi.discard(type, offer!.key);
      setResolved(true);
    },
    unsaved: json !== stored,
    status,
    savedAt,
    retry: () => void save(),
    draftKey: () => key.current,
  };
}
