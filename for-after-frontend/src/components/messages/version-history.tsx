'use client';

import { ChevronLeft, History } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { CONTENT_TYPE_INFO } from '@/components/messages/message-bits';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { EmptyState, QueryView } from '@/components/shared/states';
import { Button } from '@/components/ui/button';
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { useRestoreVersion, useVersion, useVersions } from '@/hooks/use-vault';
import type { Message, MessageVersionSummary, VersionReason } from '@/lib/api/messages';

const REASON: Record<VersionReason, string> = {
  CREATED: 'Created',
  EDITED: 'Edited',
  RESTORED: 'Restored an earlier version',
};

// "12 Oct 2026, 11:08 am" in the viewer's timezone.
const when = (iso: string) =>
  new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(
    new Date(iso),
  );

/**
 * Saved versions of a message's title and words: read any, restore one while
 * the message is a draft. Autosaves are never versions; media, recipients and
 * the schedule are not part of a version.
 */
export function VersionHistory({ message: m }: { message: Message }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const list = useVersions(m.id, open);
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setSelected(null);
      }}
    >
      <SheetTrigger asChild>
        <Button variant="ghost">
          <History aria-hidden strokeWidth={1.5} />
          Version history
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="w-full gap-0 overflow-y-auto bg-surface sm:max-w-md">
        <SheetHeader className="gap-2 border-b border-border p-6 pr-14">
          <SheetTitle className="font-heading text-[28px] leading-tight font-normal">Version history</SheetTitle>
          <SheetDescription className="text-[15px] text-foreground-muted">
            A version is kept each time you save changes to the title or words. Photos, recordings and videos
            aren&apos;t part of a version.
          </SheetDescription>
        </SheetHeader>
        <div className="p-6">
          {selected ? (
            <VersionPreview message={m} versionId={selected} onBack={() => setSelected(null)} />
          ) : (
            <QueryView query={list} loadingLabel="Loading versions">
              {(versions) =>
                versions.length ? (
                  <ol aria-label="Saved versions" className="grid gap-2">
                    {versions.map((v) => (
                      <li key={v.id}>
                        <VersionRow version={v} onOpen={() => setSelected(v.id)} />
                      </li>
                    ))}
                  </ol>
                ) : (
                  <EmptyState
                    icon={History}
                    title="No earlier versions yet"
                    description="The next time you save changes, the version before them is kept here."
                  />
                )
              }
            </QueryView>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function VersionRow({ version: v, onOpen }: { version: MessageVersionSummary; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="grid w-full gap-1 rounded-lg border border-border bg-surface px-5 py-4 text-left transition-colors outline-none hover:border-border-strong focus-visible:outline-2 focus-visible:outline-ring"
    >
      <span className="flex items-center justify-between gap-3">
        <span className="font-medium">Version {v.version}</span>
        {v.isCurrent && <span className="rounded-full bg-primary-soft px-2.5 py-0.5 text-xs text-primary">Current</span>}
      </span>
      <span className="text-sm text-foreground-muted">
        {REASON[v.reason]} · {when(v.createdAt)}
      </span>
    </button>
  );
}

function VersionPreview({ message: m, versionId, onBack }: { message: Message; versionId: string; onBack: () => void }) {
  const version = useVersion(m.id, versionId);
  const restore = useRestoreVersion(m.id);
  return (
    <div className="grid gap-6">
      <div>
        <Button type="button" variant="link" size="sm" onClick={onBack}>
          <ChevronLeft aria-hidden strokeWidth={1.5} />
          All versions
        </Button>
      </div>
      <QueryView query={version} loadingLabel="Loading version">
        {(v) => (
          <>
            <article aria-labelledby="version-heading" className="grid gap-3">
              <p className="text-sm text-foreground-muted">
                Version {v.version} · {REASON[v.reason]} · {when(v.createdAt)}
              </p>
              <h3 id="version-heading" className="text-2xl">
                {v.title}
              </h3>
              <p className="text-sm text-foreground-muted">{CONTENT_TYPE_INFO[v.contentType].label} message</p>
              <div className="rounded-lg border border-border bg-surface-muted p-5">
                {v.textContent ? (
                  <p className="font-heading text-lg leading-relaxed whitespace-pre-wrap break-words">{v.textContent}</p>
                ) : (
                  <p className="text-foreground-muted">No written text.</p>
                )}
              </div>
            </article>
            {v.isCurrent ? (
              <p className="text-sm text-foreground-muted">This is the current version.</p>
            ) : m.status === 'DRAFT' ? (
              <div className="grid gap-2">
                <ConfirmDialog
                  tone="default"
                  trigger={<Button type="button">Restore this version</Button>}
                  title="Restore this version?"
                  description="Your current draft will be kept in version history, so you can return to it later. Only the title, type and words are restored: photos, recordings, videos and the people it's for stay as they are."
                  confirmLabel="Restore version"
                  pending={restore.isPending}
                  error={restore.error}
                  onOpenChange={(o) => !o && restore.reset()}
                  onConfirm={() =>
                    restore.mutateAsync(v.id).then(() => {
                      toast.success('Earlier version restored');
                      onBack();
                    })
                  }
                />
                <p className="text-sm text-foreground-muted">This restores the written content only.</p>
              </div>
            ) : (
              <div className="grid gap-3">
                <Button type="button" disabled>
                  Restore this version
                </Button>
                <p className="text-sm text-foreground-secondary">
                  {m.status === 'SCHEDULED'
                    ? 'This message is scheduled. Unschedule it before restoring an earlier version.'
                    : "Released messages can't be replaced."}
                </p>
                {m.status === 'SCHEDULED' && (
                  <SheetClose asChild>
                    <Button asChild variant="outline">
                      <Link href={`/messages/${m.id}?focus=schedule`}>Unschedule to edit</Link>
                    </Button>
                  </SheetClose>
                )}
              </div>
            )}
          </>
        )}
      </QueryView>
    </div>
  );
}
