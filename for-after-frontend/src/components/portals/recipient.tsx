'use client';

import { ArrowLeft, ArrowRight, AudioLines, Film, Image as ImageIcon, Layers, Mail, PenLine, Play, type LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { AudioPreview, MediaError, PhotoPreview, VideoPreview } from '@/components/media/media-manager';
import { OtpSignIn, WrongPlaceNote } from '@/components/portals/otp-sign-in';
import { EmptyState, ErrorState, ListSkeleton, QueryView } from '@/components/shared/states';
import { Skeleton } from '@/components/ui/skeleton';
import { useMediaList } from '@/hooks/use-media';
import { useReleasedMessage, useReleasedMessages } from '@/hooks/use-portals';
import type { ContentType } from '@/lib/api/messages';
import type { ReleasedMessage } from '@/lib/api/portals';
import { formatDate, formatLongDate } from '@/lib/format';
import { cn } from '@/lib/utils';

export function RecipientSignIn() {
  return (
    <div className="grid gap-8">
      <OtpSignIn
        portal="recipient"
        sms
        intro={(channel) => (
          <div className="grid gap-3">
            <p className="eyebrow">Recipient access</p>
            <h1 className="text-[40px] leading-[1.05]">
              Messages <em>shared with you</em>
            </h1>
            <p className="text-foreground-muted">
              {channel === 'sms'
                ? 'Enter the mobile number the sender has for you. We’ll text you a 6-digit code, with no password or account needed.'
                : 'Enter the email address the message was sent to. We’ll email you a 6-digit code, with no password or account needed.'}
            </p>
          </div>
        )}
      />
      <WrongPlaceNote />
    </div>
  );
}

// Receiving, not managing: the Recipient side reads like a set of keepsakes.
// Only what the summary API sends is shown (title, type, release date): no text
// previews, no sender details (an open product decision) and no thumbnails, so
// nothing is signed until a message is opened.
const TYPE: Record<ContentType, { label: string; icon: LucideIcon }> = {
  TEXT: { label: 'Written message', icon: PenLine },
  PHOTO: { label: 'Photo message', icon: ImageIcon },
  AUDIO: { label: 'Voice message', icon: AudioLines },
  VIDEO: { label: 'Video message', icon: Film },
  MIXED: { label: 'Words, photos and sound', icon: Layers },
};

// Fixed bar heights: a drawn waveform, not the recording's.
const BARS = [30, 55, 40, 75, 50, 90, 60, 35, 70, 45, 85, 55, 30, 65, 40];

function Waveform({ className }: { className?: string }) {
  return (
    <span className={cn('flex h-16 items-center gap-1', className)}>
      {BARS.map((h, i) => (
        <span key={i} className="w-1 rounded-full bg-[var(--brand-lilac)]" style={{ height: `${h}%` }} />
      ))}
    </span>
  );
}

function PlayMark({ className }: { className?: string }) {
  return (
    <span className={cn('flex size-12 items-center justify-center rounded-full bg-primary text-primary-foreground', className)}>
      <Play strokeWidth={1.5} className="size-5 translate-x-px fill-current" />
    </span>
  );
}

function Print({ className }: { className?: string }) {
  return (
    <span className={cn('flex aspect-[4/5] w-24 items-center justify-center rounded-sm border border-border bg-surface shadow-sm', className)}>
      <ImageIcon strokeWidth={1.25} className="size-7 text-brand-bronze" />
    </span>
  );
}

/** The featured message's picture: drawn from its type, never from its content. */
function TypeArt({ type }: { type: ContentType }) {
  return (
    <div
      aria-hidden
      data-art={type}
      className="flex aspect-[4/3] items-center justify-center overflow-hidden bg-primary-soft sm:aspect-auto sm:min-h-72"
    >
      {type === 'TEXT' && (
        <span className="grid w-40 gap-3">
          <span className="font-heading text-8xl leading-[0.6] text-primary/25">&ldquo;</span>
          {[100, 85, 92, 60].map((w) => (
            <span key={w} className="h-px bg-primary/25" style={{ width: `${w}%` }} />
          ))}
        </span>
      )}
      {type === 'PHOTO' && (
        <span className="relative">
          <Print className="absolute -top-2 -left-10 -rotate-6" />
          <Print className="relative rotate-3" />
        </span>
      )}
      {type === 'AUDIO' && (
        <span className="flex items-center gap-5">
          <PlayMark />
          <Waveform />
        </span>
      )}
      {type === 'VIDEO' && (
        <span className="flex aspect-video w-56 items-center justify-center rounded-md bg-primary shadow-sm">
          <PlayMark className="bg-surface text-primary" />
        </span>
      )}
      {type === 'MIXED' && (
        <span className="flex items-center gap-3 sm:gap-4">
          <Print className="-rotate-3" />
          <span className="flex h-28 w-20 items-center justify-center rounded-sm bg-surface shadow-sm sm:w-24">
            <Waveform className="h-10 gap-0.5" />
          </span>
          <span className="flex h-28 w-20 rotate-2 items-start rounded-sm bg-surface p-3 font-heading text-5xl leading-none text-primary/30 shadow-sm sm:w-24">
            &ldquo;
          </span>
        </span>
      )}
    </div>
  );
}

const count = (n: number) => `${n} ${n === 1 ? 'message' : 'messages'} shared with you`;

// The whole card/row is clickable through the link's ::after; the link keeps a
// meaningful name ("Open message: <title>") and the focus ring goes on the card.
const stretched = 'outline-none after:absolute after:inset-0';
const ringOnCard = 'has-[a:focus-visible]:outline-2 has-[a:focus-visible]:outline-ring';

function FeaturedMessage({ message: m }: { message: ReleasedMessage }) {
  return (
    <article
      className={cn(
        'group relative grid overflow-hidden rounded-2xl border border-border bg-surface transition-colors hover:border-border-strong sm:grid-cols-2',
        ringOnCard,
        'has-[a:focus-visible]:outline-offset-2',
      )}
    >
      <TypeArt type={m.contentType} />
      <div className="grid content-center gap-6 p-6 sm:p-10">
        <div className="grid gap-3">
          <p className="text-sm text-brand-bronze">The most recent message shared with you</p>
          <h2 className="text-3xl leading-tight break-words sm:text-4xl">{m.title}</h2>
          <p className="grid text-foreground-secondary">
            {m.senderDisplayName && <span className="break-words">From {m.senderDisplayName}</span>}
            <span>{TYPE[m.contentType].label}</span>
            <span>Shared {formatLongDate(m.releasedAt)}</span>
          </p>
        </div>
        <Link
          href={`/recipient/messages/${m.id}`}
          aria-label={`Open message: ${m.title}`}
          className={cn(
            'inline-flex w-fit items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-colors group-hover:bg-primary-hover',
            stretched,
          )}
        >
          Open message
          <ArrowRight aria-hidden strokeWidth={1.5} className="size-4 transition-transform group-hover:translate-x-0.5" />
        </Link>
      </div>
    </article>
  );
}

function MessageRow({ message: m }: { message: ReleasedMessage }) {
  const { label, icon: Icon } = TYPE[m.contentType];
  return (
    <li
      className={cn(
        'group relative flex items-center gap-4 p-4 transition-colors first:rounded-t-2xl last:rounded-b-2xl hover:bg-surface-muted sm:gap-6 sm:px-6 sm:py-5',
        ringOnCard,
        'has-[a:focus-visible]:-outline-offset-2',
      )}
    >
      <span aria-hidden className="flex size-14 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary">
        <Icon strokeWidth={1.5} className="size-5" />
      </span>
      <div className="grid min-w-0 flex-1 gap-1">
        <h3 className="text-xl leading-tight break-words sm:text-2xl">{m.title}</h3>
        <p className="flex flex-wrap gap-x-3 text-sm text-foreground-muted">
          {m.senderDisplayName && <span className="min-w-0 break-words">From {m.senderDisplayName}</span>}
          <span>{label}</span>
          <span>Shared {formatDate(m.releasedAt)}</span>
        </p>
      </div>
      <Link
        href={`/recipient/messages/${m.id}`}
        aria-label={`Open message: ${m.title}`}
        className={cn('inline-flex shrink-0 items-center gap-1.5 text-sm font-medium text-primary', stretched)}
      >
        Open
        <ArrowRight aria-hidden strokeWidth={1.5} className="size-4 transition-transform group-hover:translate-x-0.5" />
      </Link>
    </li>
  );
}

export function ReleasedMessageList() {
  const list = useReleasedMessages();
  // Newest release first (the API's order); the newest is featured.
  const [featured, ...earlier] = list.data ?? [];
  return (
    <div className="grid gap-12 sm:gap-16">
      <header className="grid max-w-2xl gap-4">
        <h1 className="text-[40px] leading-[1.05] sm:text-5xl">A space shared with you</h1>
        <p className="text-lg text-foreground-secondary">
          These messages were created for you, to open when the time was right.
        </p>
        {/* Released messages only: nothing hints at anything not yet shared. */}
        {featured && <p className="text-sm text-foreground-muted">{count(list.data!.length)}</p>}
      </header>

      {list.isPending ? (
        <ListSkeleton label="Loading your messages" />
      ) : list.error ? (
        <ErrorState
          title="We couldn't load your messages right now."
          message="Please try again in a moment."
          onRetry={() => void list.refetch()}
        />
      ) : !featured ? (
        <EmptyState
          icon={Mail}
          title="Nothing has been shared with you yet."
          description="When something is ready for you, it will appear here."
        />
      ) : (
        <>
          <FeaturedMessage message={featured} />
          {earlier.length > 0 && (
            <section aria-labelledby="earlier-heading" className="grid gap-5">
              <h2 id="earlier-heading" className="text-2xl">
                Earlier messages
              </h2>
              <ul className="divide-y divide-border rounded-2xl border border-border bg-surface">
                {earlier.map((m) => (
                  <MessageRow key={m.id} message={m} />
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}

/** Photos first, as a gallery; then recordings and video. Each file fails on its own. */
function ReleasedMedia({ id }: { id: string }) {
  const scope = { kind: 'recipient/messages', id } as const;
  const list = useMediaList(scope);
  if (list.isPending) return <Skeleton className="aspect-[4/3] rounded-xl" />;
  if (!list.data) return <MediaError onRetry={() => void list.refetch()} />;
  const photos = list.data.filter((a) => a.kind === 'PHOTO');
  const players = list.data.filter((a) => a.kind !== 'PHOTO');
  return (
    <section aria-label="Photos and recordings" className="grid gap-6">
      {photos.length > 0 && (
        <ul className={cn('grid gap-4', photos.length > 1 && 'sm:grid-cols-2')}>
          {photos.map((a) => (
            <li key={a.id}>
              <PhotoPreview scope={scope} asset={a} alt="Photo shared with you" />
            </li>
          ))}
        </ul>
      )}
      {players.length > 0 && (
        <ul className="grid gap-4">
          {players.map((a) => (
            <li key={a.id}>
              {a.kind === 'VIDEO' ? <VideoPreview scope={scope} asset={a} /> : <AudioPreview scope={scope} asset={a} />}
            </li>
          ))}
        </ul>
      )}
    </section>
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
        // Editorial correspondence, not a card: the page is the paper, hairlines give
        // the structure, everything left-aligned except the date. The sender is a
        // line under the title (the name snapshotted at release), never a profile.
        <article className="mx-auto max-w-[780px] px-2 sm:px-0">
          <Link
            href="/recipient/messages"
            className="group inline-flex w-fit items-center gap-1.5 rounded-sm text-[13px] text-foreground-muted outline-none transition-colors duration-200 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
          >
            <ArrowLeft
              aria-hidden
              strokeWidth={1.5}
              className="size-3.5 transition-transform duration-200 group-hover:-translate-x-0.5"
            />
            Back to messages
          </Link>
          <header className="mt-10 sm:mt-12">
            <div className="flex flex-col gap-1 text-[11px] font-medium tracking-[0.22em] text-[#7a6450] uppercase sm:flex-row sm:items-baseline sm:justify-between">
              <p>Private message</p>
              <p>
                <time dateTime={m.releasedAt}>{formatLongDate(m.releasedAt)}</time>
              </p>
            </div>
            {/* User-entered casing kept as typed. */}
            <h1 className="mt-4 text-[36px] leading-[1.08] break-words sm:mt-5 sm:text-[48px]">{m.title}</h1>
            {m.senderDisplayName ? (
              <p className="mt-4 text-sm text-foreground-muted">
                From{' '}
                <span className="font-heading text-[19px] break-words text-foreground-secondary sm:text-[21px]">
                  {m.senderDisplayName}
                </span>
              </p>
            ) : (
              // Older messages carry no name: never a guessed one.
              <p className="mt-3 text-sm text-foreground-muted">Shared with you</p>
            )}
          </header>
          {/* Height follows the content: short notes stay short, long letters run on. */}
          <div className="mt-12 grid gap-12 border-y border-[rgb(72_58_79/0.14)] py-16 sm:mt-14 sm:py-[72px]">
            {m.textContent && (
              // Plain text with its line breaks; never HTML. ~60 characters a line.
              <p className="max-w-[28em] font-heading text-[20px] leading-[1.8] whitespace-pre-wrap break-words text-foreground sm:text-[24px] sm:leading-[1.75]">
                {m.textContent}
              </p>
            )}
            {/* Short-lived signed URLs, each asked for only when shown or played. */}
            {m.hasMedia && <ReleasedMedia id={m.id} />}
          </div>
          <p className="mt-6 text-xs tracking-wide text-foreground-muted sm:mt-8">Preserved privately for you.</p>
        </article>
      )}
    </QueryView>
  );
}
