'use client';

import { Mail, PenLine } from 'lucide-react';
import Link from 'next/link';
import { CONTENT_TYPE_INFO, StatusBadge, recipientSummary } from '@/components/messages/message-bits';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyState, QueryView } from '@/components/shared/states';
import { Button } from '@/components/ui/button';
import { messages } from '@/hooks/use-vault';
import type { MessageStatus, MessageSummary } from '@/lib/api/messages';
import { formatDate } from '@/lib/format';

const newButton = (
  <Button asChild>
    <Link href="/messages/new">
      <PenLine aria-hidden strokeWidth={1.5} />
      Write a message
    </Link>
  </Button>
);

// Groups in the order a person works through them; CANCELLED only if present.
const GROUPS: { status: MessageStatus; title: string; note: string }[] = [
  { status: 'DRAFT', title: 'Drafts', note: 'Still yours to shape. Only drafts can be changed.' },
  { status: 'SCHEDULED', title: 'Scheduled', note: 'Waiting for the moment you chose.' },
  { status: 'RELEASED', title: 'Released', note: 'Shared with the people you chose.' },
  { status: 'CANCELLED', title: 'Cancelled', note: '' },
];

export function MessageList() {
  const list = messages.useList();
  return (
    <>
      <PageHeader
        eyebrow="Preserve"
        title={<>Your <em>messages</em></>}
        description="Write and prepare messages for the people you love, to be shared when the time is right."
        action={list.data?.length ? newButton : undefined}
      />
      <QueryView query={list} loadingLabel="Loading your messages">
        {(all) =>
          all.length === 0 ? (
            <EmptyState
              icon={Mail}
              title="No messages yet"
              description="Start with a few words. A message stays a private draft until you choose when it should be shared."
              action={newButton}
            />
          ) : (
            <div className="grid gap-12">
              {GROUPS.map((group) => {
                const items = all.filter((m) => m.status === group.status);
                if (items.length === 0) return null;
                return (
                  <section key={group.status} aria-labelledby={`group-${group.status}`}>
                    <div className="mb-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                      <h2 id={`group-${group.status}`} className="text-3xl">
                        {group.title}
                      </h2>
                      <span className="text-sm text-foreground-muted">
                        {items.length} · {group.note}
                      </span>
                    </div>
                    <ul className="grid gap-3">
                      {items.map((m) => (
                        <li key={m.id}>
                          <MessageRow message={m} />
                        </li>
                      ))}
                    </ul>
                  </section>
                );
              })}
            </div>
          )
        }
      </QueryView>
    </>
  );
}

function MessageRow({ message: m }: { message: MessageSummary }) {
  const type = CONTENT_TYPE_INFO[m.contentType];
  return (
    <Link
      href={`/messages/${m.id}`}
      className="flex items-start gap-4 rounded-lg border border-border bg-surface p-5 outline-none transition-colors hover:border-border-strong focus-visible:outline-2 focus-visible:outline-ring sm:p-6"
    >
      <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-primary-soft text-primary">
        <type.icon aria-hidden strokeWidth={1.5} className="size-5" />
      </span>
      <span className="grid min-w-0 flex-1 gap-1.5">
        <span className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="min-w-0 truncate font-heading text-2xl leading-tight">{m.title}</span>
          <StatusBadge status={m.status} />
        </span>
        {m.textPreview && (
          <span className="line-clamp-2 text-[15px] text-foreground-secondary">{m.textPreview}</span>
        )}
        <span className="flex flex-wrap gap-x-3 text-sm text-foreground-muted">
          <span>{recipientSummary(m.recipients)}</span>
          <span aria-hidden>·</span>
          <span>{type.label}</span>
          <span aria-hidden>·</span>
          <span>Updated {formatDate(m.updatedAt)}</span>
        </span>
      </span>
    </Link>
  );
}
