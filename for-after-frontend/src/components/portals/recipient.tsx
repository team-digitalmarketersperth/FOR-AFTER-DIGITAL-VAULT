'use client';

import { Mail } from 'lucide-react';
import Link from 'next/link';
import { MediaManager } from '@/components/media/media-manager';
import { CONTENT_TYPE_INFO } from '@/components/messages/message-bits';
import { OtpSignIn, WrongPlaceNote } from '@/components/portals/otp-sign-in';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyState, QueryView } from '@/components/shared/states';
import { useReleasedMessage, useReleasedMessages } from '@/hooks/use-portals';
import { formatDate } from '@/lib/format';

export function RecipientSignIn() {
  return (
    <div className="grid gap-8">
      <OtpSignIn
        portal="recipient"
        intro={
          <div className="grid gap-3">
            <p className="eyebrow">Recipient access</p>
            <h1 className="text-[40px] leading-[1.05]">
              Messages <em>shared with you</em>
            </h1>
            <p className="text-foreground-muted">
              Enter the email address the message was sent to. We&apos;ll email you a 6-digit code, with no password
              or account needed.
            </p>
          </div>
        }
      />
      <WrongPlaceNote />
    </div>
  );
}

export function ReleasedMessageList() {
  const list = useReleasedMessages();
  return (
    <>
      <PageHeader title={<>Messages <em>shared with you</em></>} description="Open one whenever you're ready." />
      <QueryView query={list} loadingLabel="Loading your messages">
        {(messages) =>
          messages.length === 0 ? (
            <EmptyState icon={Mail} title="There aren't any messages here right now" />
          ) : (
            <ul className="grid gap-3">
              {messages.map((m) => {
                const Icon = CONTENT_TYPE_INFO[m.contentType].icon;
                return (
                  <li key={m.id}>
                    <Link
                      href={`/recipient/messages/${m.id}`}
                      className="flex items-center gap-4 rounded-lg border border-border bg-surface p-5 outline-none transition-colors hover:border-border-strong focus-visible:outline-2 focus-visible:outline-ring sm:p-6"
                    >
                      <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-primary-soft text-primary">
                        <Icon aria-hidden strokeWidth={1.5} className="size-5" />
                      </span>
                      <span className="grid min-w-0 gap-1">
                        <span className="font-heading text-2xl leading-tight break-words">{m.title}</span>
                        <span className="text-sm text-foreground-muted">
                          {CONTENT_TYPE_INFO[m.contentType].label} · Shared {formatDate(m.releasedAt)}
                        </span>
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )
        }
      </QueryView>
    </>
  );
}

export function ReleasedMessageView({ id }: { id: string }) {
  const item = useReleasedMessage(id);
  return (
    <QueryView
      query={item}
      notFound={{ title: 'We couldn’t find this message', backHref: '/recipient/messages', backLabel: 'Back to messages' }}
    >
      {(m) => (
        <article className="grid gap-8">
          <PageHeader
            back={{ href: '/recipient/messages', label: 'Messages' }}
            eyebrow={`Shared ${formatDate(m.releasedAt)}`}
            title={m.title}
          />
          {m.textContent && (
            <div className="rounded-xl border border-border bg-surface px-6 py-8 sm:px-12 sm:py-12">
              {/* Plain text, preserved line breaks; never HTML. */}
              <p className="mx-auto max-w-[65ch] font-heading text-xl leading-relaxed whitespace-pre-wrap break-words sm:text-[22px]">
                {m.textContent}
              </p>
            </div>
          )}
          {/* Photos, audio and (Phase 12) video, each from a short-lived signed URL. */}
          {m.hasMedia && <MediaManager scope={{ kind: 'recipient/messages', id: m.id }} kinds={[]} editable={false} />}
        </article>
      )}
    </QueryView>
  );
}
