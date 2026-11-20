'use client';

import { Eye, History } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import Link from 'next/link';
import { Spinner } from '@/components/shared/states';
import { Button } from '@/components/ui/button';
import { useCurrentUser } from '@/hooks/use-auth';
import type { DraftEditor } from '@/hooks/use-draft-editor';
import type { DraftPayload, DraftType } from '@/lib/api/drafts';
import { dropLocalDraft, localDraftKey, readLocalDraft } from '@/lib/local-drafts';
import { formatDateTime } from '@/lib/format';

const ago = (at: Date, now: number) => {
  const minutes = Math.floor((now - at.getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'} ago`;
};

/**
 * Small, quiet autosave status beside the Save button. "Autosaved" (never
 * "Saved"): the explicit Save is still what keeps the change. Only a failure
 * is announced to screen readers; routine autosaves stay silent.
 */
export function AutosaveStatus({ editor }: { editor: DraftEditor<DraftPayload> }) {
  const [now, setNow] = useState(() => Date.now());
  const { status, savedAt, unsaved } = editor;
  useEffect(() => {
    if (!savedAt) return;
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [savedAt]);
  if (status === 'plan') {
    return (
      <p role="alert" className="text-sm text-foreground-secondary">
        <strong className="font-medium">Not saved to your account.</strong> Your plan doesn’t include editing now. Your
        words stay on this page, and where your browser allows, this tab keeps a temporary copy. It may disappear when
        you close the tab, and it is removed when you sign out.{' '}
        <Link href="/settings/plan" className="underline underline-offset-2">
          View plans
        </Link>
      </p>
    );
  }
  if (status === 'error') {
    return (
      <p role="alert" className="flex flex-wrap items-center gap-2 text-sm text-danger">
        Couldn&apos;t keep your latest changes.
        <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={editor.retry}>
          Retry
        </Button>
      </p>
    );
  }
  const text =
    status === 'saving'
      ? 'Keeping your changes…'
      : unsaved
        ? 'Unsaved changes'
        : savedAt
          ? `Autosaved ${ago(savedAt, Math.max(now, savedAt.getTime()))}`
          : null;
  if (!text) return null;
  return (
    <p className="inline-flex items-center gap-2 text-sm text-foreground-muted" title="Autosave keeps unfinished work safe. Save keeps the change.">
      {status === 'saving' && <Spinner />}
      {text}
    </p>
  );
}

/**
 * Offered when the editor opens on unsaved changes from an earlier visit.
 * Nothing is restored automatically. If the saved item changed since (another
 * tab or device), restoring is not offered: the Customer can read the
 * recovered text and copy what they need, or discard it.
 */
export function RecoveryNotice<P extends DraftPayload>({
  editor,
  onRestore,
  describe,
}: {
  editor: DraftEditor<P>;
  onRestore: (values: P) => void;
  /** The recovered text, as the Customer would recognise it. */
  describe: (payload: P) => { title?: string; text: string };
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const d = editor.offer;
  if (!d) return null;
  const preview = describe(d.payload);
  return (
    <section
      aria-labelledby="recovery-heading"
      className="mb-8 grid max-w-3xl gap-4 rounded-xl border border-border bg-primary-soft p-6 sm:p-8"
    >
      <div className="flex gap-3">
        <History aria-hidden strokeWidth={1.5} className="mt-1 size-5 shrink-0 text-primary" />
        <div className="grid gap-2">
          <h2 id="recovery-heading" className="text-2xl">
            Unsaved changes found
          </h2>
          {d.local ? (
            <p className="text-foreground-secondary">
              <strong className="font-medium">Not saved to your account.</strong> This browser tab kept changes from{' '}
              {formatDateTime(d.updatedAt)} that couldn&apos;t be saved. The copy is temporary: it may disappear when
              you close this tab, and it&apos;s removed when you sign out. Restore them and press Save to keep them.
            </p>
          ) : (
          <p className="text-foreground-secondary">
            {d.conflict
              ? `We found changes from ${formatDateTime(d.updatedAt)}, but this was saved again after they were made, so they can't be restored over it. You can read them below and copy anything you need, or discard them.`
              : `We found changes from ${formatDateTime(d.updatedAt)} that weren't part of your last save.`}
          </p>
          )}
        </div>
      </div>
      <details className="rounded-lg border border-border bg-surface px-5 py-3" open={d.conflict}>
        <summary className="cursor-pointer text-sm font-medium">Preview the unsaved changes</summary>
        <div className="mt-3 grid gap-2">
          {preview.title && <p className="font-medium">{preview.title}</p>}
          <p className="whitespace-pre-wrap break-words text-foreground-secondary">
            {preview.text || <span className="text-foreground-muted">No written text.</span>}
          </p>
        </div>
      </details>
      {failed && (
        <p role="alert" className="text-sm text-danger">
          We couldn&apos;t discard them. Please try again.
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        {!d.conflict && (
          <Button type="button" onClick={() => onRestore(editor.restore())}>
            Restore changes
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setFailed(false);
            editor
              .discard()
              .catch(() => setFailed(true))
              .finally(() => setBusy(false));
          }}
        >
          {busy && <Spinner />}
          Discard
        </Button>
      </div>
    </section>
  );
}

/**
 * Step 7 close-out: on a read-only page (no write access), a copy kept in this tab after a refused autosave can still be
 * read ("View unsaved draft") or discarded. Reading only: nothing here edits, restores or saves, and the server is
 * never asked. Nothing is shown without a copy for this account.
 */
export function KeptDraft({
  type,
  draftKey,
  text,
}: {
  type: DraftType;
  draftKey: string | null;
  text: (payload: Record<string, unknown>) => string;
}) {
  const userId = useCurrentUser().data?.id;
  const storageKey = userId ? localDraftKey(userId, type, draftKey) : null;
  const [gone, setGone] = useState(false);
  const [open, setOpen] = useState(false);
  const panel = useId();
  const kept = storageKey && !gone ? readLocalDraft<Record<string, unknown>>(storageKey) : null;
  if (!storageKey || !kept) return null;
  return (
    <section aria-labelledby={`${panel}-h`} className="mb-6 grid max-w-3xl gap-3 rounded-xl border border-border bg-primary-soft p-5">
      <h2 id={`${panel}-h`} className="text-lg">
        Unsaved draft in this tab
      </h2>
      <p className="text-sm text-foreground-secondary">
        <strong className="font-medium">Not saved to your account.</strong> Changes from {formatDateTime(kept.updatedAt)}{' '}
        couldn&apos;t be saved. This tab keeps a temporary copy: it may disappear when you close the tab, and it&apos;s
        removed when you sign out. You can read it and copy anything you need.
      </p>
      <div className="flex flex-wrap gap-3">
        <Button type="button" variant="outline" aria-expanded={open} aria-controls={panel} onClick={() => setOpen((o) => !o)}>
          <Eye aria-hidden strokeWidth={1.5} />
          {open ? 'Hide unsaved draft' : 'View unsaved draft'}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            dropLocalDraft(storageKey);
            setGone(true);
          }}
        >
          Discard
        </Button>
      </div>
      {open && (
        <div id={panel} role="region" aria-label="Unsaved draft" className="rounded-lg border border-border bg-surface px-5 py-3">
          <p className="whitespace-pre-wrap break-words text-foreground-secondary">
            {text(kept.payload) || <span className="text-foreground-muted">No written text.</span>}
          </p>
        </div>
      )}
    </section>
  );
}

/** A kept message copy as the Customer wrote it: title, then text. */
export const messageDraftText = (d: Record<string, unknown>) =>
  [d.title, d.textContent].filter((v) => typeof v === 'string' && v).join('\n\n');