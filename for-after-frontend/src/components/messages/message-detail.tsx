'use client';

import { Lock, Pencil, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { MediaManager } from '@/components/media/media-manager';
import { CONTENT_TYPE_INFO, StatusBadge, recipientSummary } from '@/components/messages/message-bits';
import { SchedulePanel } from '@/components/messages/schedule-panel';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { PageHeader } from '@/components/shared/page-header';
import { QueryView } from '@/components/shared/states';
import { Button } from '@/components/ui/button';
import { useMediaList } from '@/hooks/use-media';
import { messages, useSchedule } from '@/hooks/use-vault';
import type { MediaKind } from '@/lib/api/media';
import type { ContentType, Message } from '@/lib/api/messages';
import { compositionIssues } from '@/lib/composition';
import { formatDate, fullName } from '@/lib/format';

// Which uploads a draft offers; TEXT offers none (existing media still shows).
const KINDS: Record<ContentType, MediaKind[]> = {
  TEXT: [],
  PHOTO: ['PHOTO'],
  AUDIO: ['AUDIO'],
  VIDEO: ['VIDEO'],
  MIXED: ['PHOTO', 'AUDIO', 'VIDEO'],
};

export function MessageDetail({ id }: { id: string }) {
  const item = messages.useItem(id);
  return (
    <QueryView
      query={item}
      notFound={{ title: 'We couldn’t find this message', backHref: '/messages', backLabel: 'Back to Messages' }}
    >
      {(m) => <MessageView message={m} />}
    </QueryView>
  );
}

function MessageView({ message: m }: { message: Message }) {
  const router = useRouter();
  const remove = messages.useRemove(m.id);
  const scope = { kind: 'messages', id: m.id } as const;
  const media = useMediaList(scope);
  const schedule = useSchedule(m.id, m.status !== 'DRAFT');
  const draft = m.status === 'DRAFT';
  const type = CONTENT_TYPE_INFO[m.contentType];
  const showMedia = m.contentType !== 'TEXT' || (media.data?.length ?? 0) > 0;

  return (
    <>
      <PageHeader
        back={{ href: '/messages', label: 'Messages' }}
        eyebrow={`${type.label} message`}
        title={m.title}
        description={
          <span className="flex flex-wrap items-center gap-3 text-base">
            <StatusBadge status={m.status} />
            <span>{recipientSummary(m.recipients)}</span>
            <span aria-hidden>·</span>
            <span>Updated {formatDate(m.updatedAt)}</span>
          </span>
        }
        action={
          draft ? (
            <div className="flex flex-wrap gap-3">
              <Button asChild variant="outline">
                <Link href={`/messages/${m.id}/edit`}>
                  <Pencil aria-hidden strokeWidth={1.5} />
                  Edit
                </Link>
              </Button>
              <ConfirmDialog
                trigger={
                  <Button variant="ghost">
                    <Trash2 aria-hidden strokeWidth={1.5} />
                    Delete draft
                  </Button>
                }
                title="Delete this draft?"
                description="The draft and anything attached to it will be removed. This can't be undone."
                confirmLabel="Delete draft"
                pending={remove.isPending}
                error={remove.error}
                onConfirm={() =>
                  remove.mutateAsync().then(() => {
                    toast.success('Draft deleted');
                    router.replace('/messages');
                  })
                }
              />
            </div>
          ) : (
            <span className="inline-flex items-center gap-2 text-sm text-foreground-muted">
              <Lock aria-hidden strokeWidth={1.5} className="size-4" />
              {m.status === 'SCHEDULED' ? 'Locked while scheduled' : 'Can no longer be changed'}
            </span>
          )
        }
      />

      {/* Side by side only once the schedule column can be ~380px; below that it stacks under the message. */}
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px] xl:items-start">
        <div className="grid gap-6">
          <section aria-label="Message" className="rounded-xl border border-border bg-surface p-6 sm:p-10">
            {m.textContent ? (
              <p className="font-heading text-xl leading-relaxed whitespace-pre-wrap break-words sm:text-[22px]">
                {m.textContent}
              </p>
            ) : (
              <p className="text-foreground-muted">
                {m.contentType === 'TEXT' || m.contentType === 'MIXED' ? 'No words written yet.' : 'No written text.'}
              </p>
            )}
          </section>
          {showMedia && <MediaManager scope={scope} kinds={draft ? KINDS[m.contentType] : []} editable={draft} />}
        </div>

        <div className="grid gap-6">
          <SchedulePanel
            message={m}
            schedule={schedule.data ?? null}
            scheduleLoading={schedule.isPending && m.status !== 'DRAFT'}
            issues={draft && media.data ? compositionIssues(m.contentType, m.textContent, media.data) : []}
          />
          <section aria-labelledby="for-heading" className="grid gap-3 rounded-xl border border-border bg-surface p-6 sm:p-8">
            <h2 id="for-heading" className="text-2xl">
              For
            </h2>
            {m.recipients.length ? (
              <ul className="grid gap-2">
                {m.recipients.map((r) => (
                  <li key={r.id}>
                    <Link href={`/people/${r.id}`} className="rounded-sm underline-offset-4 outline-none hover:underline focus-visible:outline-2 focus-visible:outline-ring">
                      {fullName(r)}
                    </Link>
                    {r.relationship && <span className="text-foreground-muted"> · {r.relationship}</span>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-foreground-muted">No one is chosen. Edit the draft to choose who it is for.</p>
            )}
          </section>
        </div>
      </div>
    </>
  );
}
