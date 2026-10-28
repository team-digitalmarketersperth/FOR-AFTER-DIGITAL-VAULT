'use client';

import { AlertCircle, AudioLines, Clock, Film, ImagePlus, Play, Trash2, Upload } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Recorder } from '@/components/media/recorder';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { Spinner } from '@/components/shared/states';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { useAccessUrl, useMediaList, useRemoveMedia, useUpload } from '@/hooks/use-media';
import { MIME_TYPES, type MediaAsset, type MediaKind, type MediaScope } from '@/lib/api/media';
import { formatBytes } from '@/lib/format';

/**
 * Photos, audio and video for a message or memory. Files go straight from the
 * browser to the private media provider; previews use short-lived signed URLs
 * that are requested only when shown. `editable` false = view only (e.g. a
 * scheduled message), so no control is offered that the API would refuse.
 */
export function MediaManager({
  scope,
  kinds,
  editable,
  title = 'Photos and voice',
}: {
  scope: MediaScope;
  kinds: MediaKind[];
  editable: boolean;
  title?: string;
}) {
  const list = useMediaList(scope);
  const { state, upload, cancel, reset } = useUpload(scope);
  const [recorderKeys, setRecorderKeys] = useState({ AUDIO: 0, VIDEO: 0 });
  const [lastFile, setLastFile] = useState<{ kind: MediaKind; file: File } | null>(null);
  const busy = state.phase === 'uploading' || state.phase === 'confirming';

  const start = async (kind: MediaKind, file: File) => {
    setLastFile({ kind, file });
    const asset = await upload(kind, file);
    if (!asset) return;
    toast.success(`${KIND_LABEL[kind]} added`);
    // A fresh recorder (and freed preview) once its recording is READY; a failed
    // upload keeps the recording for "Try again".
    if (kind !== 'PHOTO') setRecorderKeys((k) => ({ ...k, [kind]: k[kind] + 1 }));
  };


  const items = list.data ?? [];
  return (
    // A size container: the tile columns follow this section's own width (beside
    // the schedule panel or not), and its contents can't widen the page.
    <section aria-labelledby="media-heading" className="@container grid gap-5 rounded-xl border border-border bg-surface p-6 sm:p-8">
      <h2 id="media-heading" className="text-2xl">
        {title}
      </h2>

      {list.isPending ? (
        <Skeleton className="h-32 rounded-lg" />
      ) : list.error ? (
        <p role="alert" className="text-sm text-danger">
          {list.error.message}{' '}
          <button type="button" className="underline" onClick={() => void list.refetch()}>
            Try again
          </button>
        </p>
      ) : items.length === 0 ? (
        <p className="text-foreground-muted">{editable ? 'Nothing added yet.' : 'No photos, audio or video.'}</p>
      ) : (
        <ul className="grid grid-cols-1 gap-4 @lg:grid-cols-2">
          {items.map((asset) => (
            <li key={asset.id}>
              <MediaTile scope={scope} asset={asset} editable={editable} />
            </li>
          ))}
        </ul>
      )}

      {editable && (
        <div className="grid gap-4 border-t border-border pt-5">
          {busy ? (
            <UploadProgress state={state} onCancel={cancel} />
          ) : (
            <div className="flex flex-wrap gap-3">
              {kinds.includes('PHOTO') && (
                <FilePick kind="PHOTO" label="Add a photo" icon={<ImagePlus aria-hidden strokeWidth={1.5} />} onPick={start} />
              )}
              {kinds.includes('AUDIO') && (
                <FilePick kind="AUDIO" label="Upload audio" icon={<Upload aria-hidden strokeWidth={1.5} />} onPick={start} />
              )}
              {kinds.includes('VIDEO') && (
                <FilePick kind="VIDEO" label="Add a video" icon={<Film aria-hidden strokeWidth={1.5} />} onPick={start} />
              )}
            </div>
          )}
          {state.phase === 'failed' && (
            <UploadFailed message={state.message} onRetry={lastFile ? () => start(lastFile.kind, lastFile.file) : undefined} onDismiss={reset} />
          )}
          {(['AUDIO', 'VIDEO'] as const).map(
            (kind) =>
              kinds.includes(kind) && (
                <Recorder key={`${kind}-${recorderKeys[kind]}`} kind={kind} disabled={busy} onUse={(file) => start(kind, file)} />
              ),
          )}
        </div>
      )}
    </section>
  );
}

export function FilePick({
  kind,
  label,
  icon,
  onPick,
}: {
  kind: MediaKind;
  label: string;
  icon: ReactNode;
  onPick: (kind: MediaKind, file: File) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        accept={MIME_TYPES[kind].join(',')}
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) onPick(kind, file);
        }}
      />
      <Button type="button" variant="outline" onClick={() => input.current?.click()}>
        {icon}
        {label}
      </Button>
    </>
  );
}

/** A failed upload (refused locally or by the server's checks), with Try again for the same file. */
export function UploadFailed({ message, onRetry, onDismiss }: { message: string; onRetry?: () => void; onDismiss: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3 rounded-md bg-danger/8 px-4 py-3 text-sm text-danger">
      <AlertCircle aria-hidden className="size-4" />
      <span className="min-w-0 flex-1">Upload failed: {message}</span>
      {onRetry && (
        <Button type="button" size="sm" variant="outline" onClick={onRetry}>
          Try again
        </Button>
      )}
      <Button type="button" size="sm" variant="ghost" onClick={onDismiss}>
        Dismiss
      </Button>
    </div>
  );
}

export function UploadProgress({
  state,
  onCancel,
}: {
  state: Extract<ReturnType<typeof useUpload>['state'], { phase: 'uploading' | 'confirming' }>;
  onCancel: () => void;
}) {
  const percent = state.phase === 'uploading' ? Math.round(state.progress * 100) : 100;
  return (
    <div className="grid gap-3 rounded-lg bg-surface-muted p-4">
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="min-w-0 truncate">{state.fileName}</span>
        <span className="shrink-0 text-foreground-muted" aria-live="polite">
          {state.phase === 'uploading' ? `Uploading ${percent}%` : 'Checking the upload…'}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={`Uploading ${state.fileName}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="h-1.5 overflow-hidden rounded-full bg-brand-lilac-grey"
      >
        <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${percent}%` }} />
      </div>
      {state.phase === 'uploading' && (
        <div>
          <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
            Cancel upload
          </Button>
        </div>
      )}
    </div>
  );
}

export function MediaTile({ scope, asset, editable }: { scope: MediaScope; asset: MediaAsset; editable: boolean }) {
  const remove = useRemoveMedia(scope);
  const ready = asset.status === 'READY';
  return (
    // grid-cols-1 (minmax(0, 1fr)), not the implicit auto column, which grows
    // to the full width of a long file name and pushes everything out of the card.
    <div className="grid h-full grid-cols-1 content-start gap-3 rounded-lg border border-border bg-surface p-3">
      {ready ? (
        asset.kind === 'PHOTO' ? (
          <PhotoPreview scope={scope} asset={asset} />
        ) : asset.kind === 'VIDEO' ? (
          <VideoPreview scope={scope} asset={asset} />
        ) : (
          <AudioPreview scope={scope} asset={asset} />
        )
      ) : (
        <div className="flex min-h-24 items-center gap-3 rounded-md bg-surface-muted p-4 text-sm">
          {asset.status === 'FAILED' ? (
            <>
              <AlertCircle aria-hidden className="size-4 text-danger" />
              <span className="text-danger">Upload failed. Remove it and try again.</span>
            </>
          ) : (
            <>
              <Clock aria-hidden strokeWidth={1.5} className="size-4 text-foreground-muted" />
              <span className="text-foreground-secondary">Upload not finished. Remove it and upload again.</span>
            </>
          )}
        </div>
      )}
      <div className="flex items-center gap-2 px-1 text-xs text-foreground-muted">
        <span className="shrink-0 font-semibold text-foreground-secondary">{KIND_LABEL[asset.kind]}</span>
        <span className="min-w-0 flex-1 truncate" title={asset.originalFileName}>
          {asset.originalFileName}
        </span>
        <span className="shrink-0">· {formatBytes(asset.sizeBytes)}</span>
        {editable && (
          <ConfirmDialog
            trigger={
              <Button type="button" size="icon-sm" variant="ghost" className="shrink-0" aria-label={`Remove ${asset.originalFileName}`}>
                <Trash2 aria-hidden strokeWidth={1.5} className="size-4" />
              </Button>
            }
            title={`Remove this ${KIND_LABEL[asset.kind].toLowerCase()}?`}
            description="It will be removed from here. You can add it again later."
            confirmLabel="Remove"
            pending={remove.isPending}
            error={remove.error}
            onConfirm={() => remove.mutateAsync(asset.id).then(() => toast.success('Removed'))}
          />
        )}
      </div>
    </div>
  );
}

export const KIND_LABEL: Record<MediaKind, string> = { PHOTO: 'Photo', AUDIO: 'Audio', VIDEO: 'Video' };

/** One item's failure stays local to that item, with a way to try again. */
export function MediaError({ onRetry }: { onRetry: () => void }) {
  return (
    <div role="alert" className="flex min-h-24 flex-wrap items-center gap-3 rounded-md bg-surface-muted p-4 text-sm">
      <AlertCircle aria-hidden className="size-4 text-foreground-muted" />
      <span className="flex-1 text-foreground-secondary">This couldn&apos;t be loaded.</span>
      <Button type="button" size="sm" variant="outline" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

// Photos and videos share one responsive frame, so tiles side by side line up.
const PREVIEW_FRAME = 'block aspect-[4/3] w-full rounded-md';

/** `alt`: the Recipient Portal passes a generic one; the Customer sees the file name. */
export function PhotoPreview({ scope, asset, alt = asset.originalFileName }: { scope: MediaScope; asset: MediaAsset; alt?: string }) {
  const access = useAccessUrl(scope, asset.id);
  if (!access.data) {
    return access.error ? (
      <MediaError onRetry={() => void access.refetch()} />
    ) : (
      <Skeleton className={PREVIEW_FRAME} />
    );
  }
  // Signed, short-lived URL from private storage: plain <img>, not next/image
  // (whose optimizer would fetch and cache it server-side). An expired link
  // fails to load and asks for a fresh one.
  const image = (className: string) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={access.data.url} alt={alt} loading="lazy" className={className} onError={() => void access.refetch()} />
  );
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          aria-label={`Enlarge ${alt}`}
          className="block w-full cursor-zoom-in rounded-md outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {image(`${PREVIEW_FRAME} bg-surface-muted object-contain`)}
        </button>
      </DialogTrigger>
      <DialogContent className="max-w-[calc(100%-2rem)] bg-surface p-3 sm:max-w-4xl">
        <DialogTitle className="sr-only">{alt}</DialogTitle>
        {image('max-h-[80vh] w-full rounded-md object-contain')}
      </DialogContent>
    </Dialog>
  );
}

export function AudioPreview({ scope, asset }: { scope: MediaScope; asset: MediaAsset }) {
  const [wanted, setWanted] = useState(false);
  const access = useAccessUrl(scope, asset.id, wanted);
  if (!wanted) {
    return (
      <div className="flex min-h-24 items-center gap-3 rounded-md bg-primary-soft p-4">
        <AudioLines aria-hidden strokeWidth={1.5} className="size-5 text-primary" />
        <Button type="button" size="sm" variant="secondary" className="bg-surface" onClick={() => setWanted(true)}>
          <Play aria-hidden strokeWidth={1.5} className="size-4" />
          Listen
        </Button>
      </div>
    );
  }
  return (
    <div className="flex min-h-24 items-center rounded-md bg-primary-soft p-4">
      {access.data ? (
        <audio
          controls
          autoPlay
          src={access.data.url}
          className="w-full min-w-0"
          aria-label={`Play ${asset.originalFileName}`}
          onError={() => void access.refetch()}
        />
      ) : access.error ? (
        <MediaError onRetry={() => void access.refetch()} />
      ) : (
        <span className="inline-flex items-center gap-2 text-sm text-foreground-secondary">
          <Spinner /> Loading…
        </span>
      )}
    </div>
  );
}

/**
 * The original video as uploaded, from a short-lived signed URL requested only
 * when the person chooses to watch (no autoload of large files, no download
 * control). An expired link fails and asks for a fresh one.
 */
export function VideoPreview({ scope, asset }: { scope: MediaScope; asset: MediaAsset }) {
  const [wanted, setWanted] = useState(false);
  const access = useAccessUrl(scope, asset.id, wanted);
  if (!wanted) {
    return (
      <div className={`${PREVIEW_FRAME} flex flex-col items-center justify-center gap-3 bg-primary-soft p-4`}>
        <Film aria-hidden strokeWidth={1.5} className="size-5 text-primary" />
        <Button type="button" size="sm" variant="secondary" className="bg-surface" onClick={() => setWanted(true)}>
          <Play aria-hidden strokeWidth={1.5} className="size-4" />
          Watch
        </Button>
      </div>
    );
  }
  return access.data ? (
    <video
      controls
      autoPlay
      playsInline
      controlsList="nodownload"
      src={access.data.url}
      className={`${PREVIEW_FRAME} bg-black object-contain`}
      aria-label={`Play ${asset.originalFileName}`}
      onError={() => void access.refetch()}
    />
  ) : access.error ? (
    <MediaError onRetry={() => void access.refetch()} />
  ) : (
    <div className={`${PREVIEW_FRAME} flex items-center justify-center bg-primary-soft p-4`}>
      <span className="inline-flex items-center gap-2 text-sm text-foreground-secondary">
        <Spinner /> Loading…
      </span>
    </div>
  );
}
