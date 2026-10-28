'use client';

import { History } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Spinner } from '@/components/shared/states';
import { Button } from '@/components/ui/button';
import type { DraftEditor } from '@/hooks/use-draft-editor';
import type { DraftPayload } from '@/lib/api/drafts';
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
          <p className="text-foreground-secondary">
            {d.conflict
              ? `We found changes from ${formatDateTime(d.updatedAt)}, but this was saved again after they were made, so they can't be restored over it. You can read them below and copy anything you need, or discard them.`
              : `We found changes from ${formatDateTime(d.updatedAt)} that weren't part of your last save.`}
          </p>
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
