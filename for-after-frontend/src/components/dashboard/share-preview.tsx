'use client';

import {
  AudioLines,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Clock,
  Clapperboard,
  Film,
  Image as ImageIcon,
  Lock,
  Pause,
  Play,
  Smartphone,
  Users,
  X,
} from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { MediaError, PhotoPreview, AudioPreview, VideoPreview } from '@/components/media/media-manager';
import { SectionHeading } from '@/components/shared/section-heading';
import { Spinner } from '@/components/shared/states';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { useDeliveryTimeline } from '@/hooks/use-delivery-timeline';
import { useAccessUrl, useMediaList } from '@/hooks/use-media';
import { messages } from '@/hooks/use-vault';
import type { ConditionalDelivery, UpcomingDelivery } from '@/lib/api/delivery-timeline';
import type { MediaAsset } from '@/lib/api/media';
import type { Message } from '@/lib/api/messages';
import { conditionalLabel, upcomingDetail, whenLabel } from '@/lib/delivery-timeline';
import { cn } from '@/lib/utils';

/*
 * Dashboard: preview a scheduled message as a Story before it is delivered. Owner-only and read-only: it uses the same GETs as the message
 * page (GET /messages/:id, its media list and signed access URLs), so it never
 * sends, schedules, releases or marks anything, and creates no public link.
 * The private note is never shown. Recipients do not get a Story view yet, so
 * this previews the format, not a copy of the Recipient Portal.
 */

type Candidate = {
  messageId: string;
  title: string;
  /** Badge text: the date, or the after-death rule (no invented date). */
  when: string;
  /** Plain-language timing for the details row. */
  timing: string;
  fixedDate: boolean;
  /** No date exists before a verified death. */
  afterDeath: boolean;
  recipients: string[];
};

/** One entry per scheduled message (repeating schedules list each recipient's date). */
export function candidatesOf(upcoming: UpcomingDelivery[], conditional: ConditionalDelivery[]): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const e of upcoming) {
    if (seen.has(e.messageId)) continue;
    seen.add(e.messageId);
    const detail = upcomingDetail(e);
    out.push({
      messageId: e.messageId,
      title: e.title,
      when: whenLabel(e),
      timing: [whenLabel(e), detail].filter(Boolean).join(' · '),
      fixedDate: e.triggerType === 'FIXED_DATE',
      afterDeath: false,
      recipients: e.recipients,
    });
  }
  for (const e of conditional) {
    if (seen.has(e.messageId)) continue;
    seen.add(e.messageId);
    const label = conditionalLabel(e);
    out.push({ messageId: e.messageId, title: e.title, when: label, timing: label, fixedDate: false, afterDeath: true, recipients: e.recipients });
  }
  return out;
}

/** The next fixed-date message first; otherwise the next dated one; otherwise after-death. */
export const defaultCandidate = (list: Candidate[]) => list.find((c) => c.fixedDate) ?? list[0];

type Item =
  | { kind: 'TEXT'; text: string }
  | { kind: 'PHOTO' | 'VIDEO' | 'AUDIO'; asset: MediaAsset };

/** What a preview shows: READY files (videos, photos, audio), then the written message. */
function itemsOf(m: Message, media: MediaAsset[]): Item[] {
  const ready = media.filter((a) => a.status === 'READY');
  const order = ['VIDEO', 'PHOTO', 'AUDIO'] as const;
  const files = order.flatMap((k) => ready.filter((a) => a.kind === k).map((asset) => ({ kind: k, asset })));
  return [...files, ...(m.textContent?.trim() ? [{ kind: 'TEXT' as const, text: m.textContent }] : [])];
}

const recipientNames = (m: Message | undefined, fallback: string[]) =>
  m ? m.recipients.map((r) => [r.firstName, r.lastName].filter(Boolean).join(' ')) : fallback;

const listNames = (names: string[]) =>
  names.length <= 2 ? names.join(' and ') : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;

const KIND_LABEL = { TEXT: 'Written message', PHOTO: 'Photo message', AUDIO: 'Voice message', VIDEO: 'Video message', MIXED: 'Message with photos and recordings' };

export function SharePreview() {
  const timeline = useDeliveryTimeline();
  const [chosen, setChosen] = useState<string>();
  const candidates = timeline.data ? candidatesOf(timeline.data.upcoming, timeline.data.conditional) : [];
  // A deleted or unscheduled choice falls back to the default.
  const selected = candidates.find((c) => c.messageId === chosen) ?? defaultCandidate(candidates);
  return (
    <section aria-labelledby="share-preview">
      <SectionHeading
        id="share-preview"
        title={<>Preview how it will be <em>shared</em></>}
        description="See your scheduled message as a Story before it’s delivered."
      />
      {timeline.isPending ? (
        <div aria-busy="true" aria-label="Loading your scheduled messages" className="grid h-64 animate-pulse rounded-xl border border-border bg-surface-muted" />
      ) : timeline.isError ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-surface p-6 text-[15px]">
          <span className="text-foreground-secondary">Your scheduled messages couldn’t be loaded.</span>
          <Button type="button" size="sm" variant="outline" onClick={() => void timeline.refetch()}>
            Try again
          </Button>
        </div>
      ) : !selected ? (
        <div className="grid justify-items-center gap-3 rounded-xl border border-border bg-brand-ivory px-6 py-12 text-center">
          <span className="grid size-12 place-items-center rounded-full bg-surface">
            <Clapperboard aria-hidden strokeWidth={1.5} className="size-5 text-primary" />
          </span>
          <h3 className="text-[28px] leading-tight">Your next message starts here.</h3>
          <p className="max-w-sm text-sm text-foreground-muted">Create and schedule a message to preview it as a Story.</p>
          <Button asChild className="mt-2">
            <Link href="/messages/new">Create a message</Link>
          </Button>
        </div>
      ) : (
        <Panel candidates={candidates} selected={selected} onChoose={setChosen} onGone={() => void timeline.refetch()} />
      )}
    </section>
  );
}

type Open = 'message' | 'story' | null;

function Panel({
  candidates,
  selected,
  onChoose,
  onGone,
}: {
  candidates: Candidate[];
  selected: Candidate;
  onChoose: (id: string) => void;
  onGone: () => void;
}) {
  const message = messages.useItem(selected.messageId);
  // Deleted (or no longer this owner's) since the timeline loaded: reload the list.
  const gone = message.error?.status === 404;
  useEffect(() => {
    if (gone) onGone();
  }, [gone, onGone]);
  const media = useMediaList({ kind: 'messages', id: selected.messageId });
  const [open, setOpen] = useState<Open>(null);
  // Opened from buttons, not DialogTrigger, so return focus to the control used.
  const opener = useRef<HTMLElement | null>(null);
  const show = (which: Open) => {
    opener.current = document.activeElement as HTMLElement | null;
    setOpen(which);
  };
  const close = () => setOpen(null);
  const refocus = (e: Event) => {
    e.preventDefault();
    opener.current?.focus();
  };
  const m = message.data;
  const items = m && media.data ? itemsOf(m, media.data) : [];
  const waiting = media.data?.filter((a) => a.status === 'PENDING_UPLOAD').length ?? 0;
  const failed = media.data?.filter((a) => a.status === 'FAILED').length ?? 0;
  const loading = message.isPending || media.isPending;
  const canPlay = !loading && items.length > 0;
  const names = recipientNames(m, selected.recipients);
  const excerpt = m?.textContent?.trim();
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface">
      <div className="grid lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="grid content-start gap-5 p-6 sm:p-8">
          {candidates.length > 1 && (
            <div className="grid gap-1.5">
              <label htmlFor="preview-message" className="text-xs font-medium text-foreground-muted">
                Message to preview
              </label>
              <select
                id="preview-message"
                value={selected.messageId}
                onChange={(e) => onChoose(e.target.value)}
                className="h-10 w-full rounded-sm border border-input bg-surface px-3 text-sm outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-solid focus-visible:outline-ring"
              >
                {candidates.map((c) => (
                  <option key={c.messageId} value={c.messageId}>
                    {c.title} · {c.when}
                  </option>
                ))}
              </select>
            </div>
          )}
          <p className="inline-flex w-fit items-center gap-2 rounded-full bg-brand-ivory px-3 py-1 text-xs font-medium text-foreground-secondary">
            <CalendarDays aria-hidden strokeWidth={1.5} className="size-3.5 text-primary" />
            {selected.afterDeath ? selected.when : `Scheduled · ${selected.when}`}
          </p>
          <div className="grid gap-2">
            <h3 className="text-[32px] leading-[1.1] break-words">{selected.title}</h3>
            {m && <p className="text-sm text-foreground-muted">{KIND_LABEL[m.contentType]}</p>}
          </div>
          <hr className="border-border" />
          <dl className="grid gap-3 text-[15px]">
            <Row icon={Users} label="To">
              {names.length ? listNames(names) : 'No one chosen yet'}
            </Row>
            <Row icon={Clock} label="Delivery">
              {selected.timing}
            </Row>
          </dl>
          {excerpt && <p className="line-clamp-3 border-l-2 border-border pl-4 text-[15px] leading-relaxed text-foreground-secondary italic">{excerpt}</p>}
          {(waiting > 0 || failed > 0) && (
            <p role="status" className="text-sm text-foreground-muted">
              {waiting > 0 && `${waiting} ${waiting === 1 ? 'file is' : 'files are'} still uploading or being checked and won’t appear yet. `}
              {failed > 0 && `${failed} ${failed === 1 ? 'file' : 'files'} couldn’t be processed and won’t be included.`}
            </p>
          )}
          {message.isError || media.isError ? (
            <MediaError onRetry={() => void Promise.all([message.refetch(), media.refetch()])} />
          ) : (
            <div>
              <Button type="button" disabled={loading} onClick={() => show('message')}>
                Preview message
              </Button>
            </div>
          )}
        </div>
        <div className="grid border-t border-border lg:border-t-0 lg:border-l">
          <PreviewColumn
            icon={Smartphone}
            title="Story Preview"
            helper="How it will look as a Story."
            action="Preview Story"
            m={m}
            items={items}
            loading={loading}
            disabled={!canPlay}
            onOpen={() => show('story')}
          />
        </div>
      </div>
      <p className="flex items-center gap-2 border-t border-border bg-brand-ivory px-6 py-3 text-xs text-foreground-muted sm:px-8">
        <Lock aria-hidden strokeWidth={1.5} className="size-3.5" />A private preview only visible to you.
      </p>
      {m && (
        <>
          <MessageDialog open={open === 'message'} onClose={close} onCloseAutoFocus={refocus} m={m} names={names} timing={selected.timing} media={media.data ?? []} />
          <StoryDialog open={open === 'story'} onClose={close} onCloseAutoFocus={refocus} m={m} items={items} names={names} />
        </>
      )}
    </div>
  );
}

function Row({ icon: Icon, label, children }: { icon: typeof Users; label: string; children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <Icon aria-hidden strokeWidth={1.5} className="mt-0.5 size-4 shrink-0 text-foreground-muted" />
      <dt className="sr-only">{label}</dt>
      <dd className="text-foreground-secondary">{children}</dd>
    </div>
  );
}

function PreviewColumn({
  icon: Icon,
  title,
  helper,
  action,
  m,
  items,
  loading,
  disabled,
  onOpen,
}: {
  icon: typeof Users;
  title: string;
  helper: string;
  action: string;
  m: Message | undefined;
  items: Item[];
  loading: boolean;
  disabled: boolean;
  onOpen: () => void;
}) {
  return (
    <div className="grid content-start justify-items-center gap-4 p-6 text-center sm:p-8">
      <div className="grid gap-1">
        <h4 className="flex items-center justify-center gap-2 font-sans text-sm font-medium text-foreground">
          <Icon aria-hidden strokeWidth={1.5} className="size-4 text-primary" />
          {title}
        </h4>
        <p className="text-xs text-foreground-muted">{helper}</p>
      </div>
      <button
        type="button"
        onClick={onOpen}
        disabled={disabled}
        aria-label={`${action}${m ? `: ${m.title}` : ''}`}
        className="group relative aspect-[9/16] w-full max-w-[200px] overflow-hidden rounded-lg border border-brand-stone bg-brand-ivory text-left shadow-soft outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-brand-maroon disabled:cursor-not-allowed"
      >
        <Thumb m={m} items={items} loading={loading} />
        {!disabled && (
          <span className="absolute top-1/2 left-1/2 grid size-11 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-brand-maroon text-primary-foreground transition-transform group-hover:scale-105 motion-reduce:transition-none">
            <Play aria-hidden strokeWidth={1.5} className="ml-0.5 size-5" />
          </span>
        )}
      </button>
      <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={onOpen}>
        {action}
      </Button>
      {!loading && items.length === 0 && <p className="text-xs text-foreground-muted">Nothing ready to preview yet.</p>}
    </div>
  );
}

/** Matches the Story viewer: the real title on ivory, and the first photo whole when there is one. Never a stand-in image. */
function Thumb({ m, items, loading }: { m: Message | undefined; items: Item[]; loading: boolean }) {
  const photo = items.find((i) => i.kind === 'PHOTO');
  if (loading) return <span className="absolute inset-0 grid place-items-center"><Spinner /></span>;
  const kind = items[0]?.kind;
  const Icon = kind === 'VIDEO' ? Film : kind === 'AUDIO' ? AudioLines : kind === 'PHOTO' ? ImageIcon : null;
  return (
    <span className="absolute inset-0 flex flex-col gap-2 p-3">
      <span className="h-[2px] rounded-full bg-brand-stone" />
      <span className="line-clamp-3 font-heading text-lg leading-tight text-foreground">{m?.title}</span>
      {photo && photo.kind === 'PHOTO' ? (
        <SignedImage messageId={m!.id} asset={photo.asset} className="min-h-0 w-full flex-1 rounded-sm object-contain" />
      ) : (
        <span className="mt-auto flex items-center gap-2 text-xs text-foreground-muted">
          {Icon && <Icon aria-hidden strokeWidth={1.5} className="size-4 text-brand-maroon" />}
        </span>
      )}
    </span>
  );
}

function SignedImage({ messageId, asset, className }: { messageId: string; asset: MediaAsset; className: string }) {
  const access = useAccessUrl({ kind: 'messages', id: messageId }, asset.id);
  if (!access.data) return null;
  // Signed private URL: plain <img>, never the Next optimizer.
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={access.data.url} alt="" className={className} onError={() => void access.refetch()} />;
}

const SLIDE_MS = 6000;

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

/**
 * Story preview: a portrait keepsake viewer, one slide at a time. Header and
 * footer stay put; the content scrolls. Fits the viewport (never a rigid
 * 9:16 that shrinks text); full screen on phones.
 */
function StoryDialog({
  open,
  onClose,
  onCloseAutoFocus,
  m,
  items,
  names,
}: {
  open: boolean;
  onClose: () => void;
  onCloseAutoFocus: (e: Event) => void;
  m: Message;
  items: Item[];
  names: string[];
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        showCloseButton={false}
        onCloseAutoFocus={onCloseAutoFocus}
        className="flex h-[min(calc(100dvh-3rem),860px)] w-[min(calc(100vw-2rem),440px)] max-w-none flex-col gap-0 overflow-hidden rounded-xl bg-brand-ivory p-0 text-foreground shadow-menu ring-0 sm:max-w-none max-sm:h-dvh max-sm:w-screen max-sm:rounded-none max-sm:pt-[env(safe-area-inset-top)] max-sm:pb-[env(safe-area-inset-bottom)]"
      >
        {/* Unmounted on close: timers clear and media pauses. */}
        <StoryViewer m={m} items={items} names={names} />
      </DialogContent>
    </Dialog>
  );
}

/**
 * Photos advance after 6 s (paused from the start with reduced motion);
 * written slides never advance on their own, so nobody is moved on mid-read;
 * video and audio advance when they end and their bar is the real position.
 * Play/pause always does something: media on media slides, the slideshow on
 * photo slides, and it is absent on written slides.
 */
function StoryViewer({ m, items, names }: { m: Message; items: Item[]; names: string[] }) {
  const [index, setIndex] = useState(0);
  const [progress, setProgress] = useState(0);
  const [autoplay, setAutoplay] = useState(() => !reducedMotion());
  const [media, setMedia] = useState<HTMLMediaElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const item = items[index];
  const last = items.length - 1;
  const isMedia = item.kind === 'VIDEO' || item.kind === 'AUDIO';
  const go = (to: number) => {
    setProgress(0);
    setPlaying(false);
    setIndex(Math.max(0, Math.min(last, to)));
  };

  useEffect(() => {
    if (item.kind !== 'PHOTO' || !autoplay) return;
    const started = Date.now() - progress * SLIDE_MS;
    const t = setInterval(() => {
      const p = Math.min(1, (Date.now() - started) / SLIDE_MS);
      setProgress(p);
      if (p >= 1) {
        clearInterval(t);
        if (index < last) go(index + 1);
      }
    }, 100);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, autoplay]);

  useEffect(() => {
    if (!media) return;
    const tick = () => setProgress(media.duration ? media.currentTime / media.duration : 0);
    const on = () => setPlaying(true);
    const off = () => setPlaying(false);
    const end = () => {
      setPlaying(false);
      if (index < last) go(index + 1);
    };
    media.addEventListener('timeupdate', tick);
    media.addEventListener('play', on);
    media.addEventListener('pause', off);
    media.addEventListener('ended', end);
    return () => {
      // Leaving the slide or closing: never let it play on detached.
      media.pause();
      media.removeEventListener('timeupdate', tick);
      media.removeEventListener('play', on);
      media.removeEventListener('pause', off);
      media.removeEventListener('ended', end);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [media]);

  const center = isMedia ? (
    <RoundButton
      primary
      label={`${playing ? 'Pause' : 'Play'} ${item.kind === 'VIDEO' ? 'video' : 'recording'}`}
      disabled={!media}
      onClick={() => (media?.paused ? void media.play() : media?.pause())}
    >
      {playing ? <Pause aria-hidden strokeWidth={1.5} /> : <Play aria-hidden strokeWidth={1.5} className="ml-0.5" />}
    </RoundButton>
  ) : item.kind === 'PHOTO' ? (
    <RoundButton primary label={autoplay ? 'Pause slideshow' : 'Play slideshow'} onClick={() => setAutoplay((a) => !a)}>
      {autoplay ? <Pause aria-hidden strokeWidth={1.5} /> : <Play aria-hidden strokeWidth={1.5} className="ml-0.5" />}
    </RoundButton>
  ) : (
    <span aria-hidden className="size-12" />
  );

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      onKeyDown={(e) => {
        // Leave keys to native media controls and form fields.
        if ((e.target as HTMLElement).closest('video, audio, input, select, textarea')) return;
        if (e.key === 'ArrowRight') go(index + 1);
        if (e.key === 'ArrowLeft') go(index - 1);
      }}
    >
      {/* SHORT: phones held sideways; the logo gives way so the content keeps room. */}
      <header className="grid shrink-0 gap-3 px-5 pt-4 pb-3 sm:px-6 [@media(max-height:500px)]:gap-1 [@media(max-height:500px)]:pt-2 [@media(max-height:500px)]:pb-1">
        <DialogTitle className="sr-only">Story preview: {m.title}</DialogTitle>
        <DialogDescription className="sr-only">A private preview only visible to you. Nothing is sent.</DialogDescription>
        <ol aria-label={`Part ${index + 1} of ${items.length}`} className="flex gap-1">
          {items.map((_, i) => (
            <li key={i} className="h-[3px] flex-1 overflow-hidden rounded-full bg-brand-stone">
              <span
                className="block h-full bg-brand-maroon"
                style={{ width: `${i < index ? 100 : i === index ? (item.kind === 'TEXT' ? 100 : progress * 100) : 0}%` }}
              />
            </li>
          ))}
        </ol>
        <div className="flex items-center justify-between gap-3">
          <Image src="/brand/for-after-logo.png" alt="For After" width={592} height={161} className="h-7 w-auto [@media(max-height:500px)]:hidden" />
          <div className="hidden min-w-0 flex-1 items-baseline gap-4 text-[11px] font-medium tracking-[0.18em] uppercase [@media(max-height:500px)]:flex">
            <span className="shrink-0 text-foreground-muted">Private preview</span>
          {names.length > 0 && <span className="truncate text-brand-maroon">For {listNames(names)}</span>}
          </div>
          <DialogClose asChild>
            <RoundButton label="Close preview" quiet>
              <X aria-hidden strokeWidth={1.5} />
            </RoundButton>
          </DialogClose>
        </div>
        <div className="flex items-baseline justify-between gap-4 text-[11px] font-medium tracking-[0.18em] uppercase [@media(max-height:500px)]:hidden">
          <span className="shrink-0 text-foreground-muted">Private preview</span>
          {names.length > 0 && <span className="truncate text-brand-maroon">For {listNames(names)}</span>}
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto border-t border-brand-stone px-6 py-7 sm:px-8 [@media(max-height:500px)]:py-4">
        <StorySlide key={index} m={m} item={item} onMedia={isMedia ? setMedia : undefined} />
      </div>
      <footer className="grid shrink-0 gap-2 border-t border-brand-stone px-4 py-3 sm:px-6 [@media(max-height:500px)]:py-1.5">
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
        <span className="text-xs text-foreground-muted tabular-nums">
          {index + 1} / {items.length}
        </span>
        <div className="flex items-center gap-2">
          <RoundButton label="Previous" disabled={index === 0} onClick={() => go(index - 1)}>
            <ChevronLeft aria-hidden strokeWidth={1.5} />
          </RoundButton>
          {center}
          <RoundButton label="Next" disabled={index === last} onClick={() => go(index + 1)}>
            <ChevronRight aria-hidden strokeWidth={1.5} />
          </RoundButton>
        </div>
        <span className="hidden items-center justify-end gap-1.5 text-right text-xs text-foreground-muted sm:flex">
          <Lock aria-hidden strokeWidth={1.5} className="size-3.5 shrink-0" />
          Only visible to you
        </span>
        </div>
        {/* Phones: its own line, so it never crowds the controls. */}
        <span className="flex items-center justify-center gap-1.5 text-xs text-foreground-muted sm:hidden">
          <Lock aria-hidden strokeWidth={1.5} className="size-3.5 shrink-0" />
          Only visible to you
        </span>
      </footer>
    </div>
  );
}

/**
 * 44px+ round control in the viewer's maroon outline style. "Disabled" is
 * aria-disabled, so a focused Next at the last slide keeps focus in the viewer.
 */
function RoundButton({
  label,
  primary,
  quiet,
  disabled,
  onClick,
  className,
  ...props
}: ComponentProps<'button'> & { label: string; primary?: boolean; quiet?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-disabled={disabled || undefined}
      onClick={(e) => !disabled && onClick?.(e)}
      className={cn(
        'grid shrink-0 place-items-center rounded-full outline-none transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-brand-maroon aria-disabled:cursor-not-allowed aria-disabled:opacity-35 motion-reduce:transition-none [&_svg]:size-5',
        primary
          ? 'size-12 bg-brand-maroon text-primary-foreground hover:bg-brand-maroon/90'
          : quiet
            ? 'size-11 text-brand-maroon hover:bg-brand-maroon/8'
            : 'size-11 border border-brand-maroon/35 text-brand-maroon hover:bg-brand-maroon/8',
        className,
      )}
      {...props}
    />
  );
}

/** One slide: the real title, then the real content. Media keeps its whole picture on ivory. */
function StorySlide({ m, item, onMedia }: { m: Message; item: Item; onMedia?: (el: HTMLMediaElement | null) => void }) {
  const scope = { kind: 'messages', id: m.id } as const;
  const access = useAccessUrl(scope, item.kind === 'TEXT' ? '' : item.asset.id, item.kind !== 'TEXT');
  const [large, setLarge] = useState(false);
  const [duration, setDuration] = useState<number>();
  const title = <h2 className="text-[30px] leading-[1.1] break-words sm:text-[34px] [@media(max-height:500px)]:text-2xl">{m.title}</h2>;
  if (item.kind === 'TEXT') {
    return (
      <article className="grid gap-5">
        {title}
        <span aria-hidden className="block h-px w-12 bg-brand-maroon/50" />
        {/* Plain text with its own line breaks, never HTML. */}
        <p className="font-heading text-[19px] leading-[1.75] whitespace-pre-wrap break-words">{item.text}</p>
      </article>
    );
  }
  const what = { PHOTO: 'photo', VIDEO: 'video', AUDIO: 'recording' }[item.kind];
  const body = !access.data ? (
    access.error ? (
      <MediaError onRetry={() => void access.refetch()} />
    ) : (
      <p className="flex items-center gap-2 text-sm text-foreground-muted" role="status">
        <Spinner /> Loading the {what}…
      </p>
    )
  ) : item.kind === 'PHOTO' ? (
    <figure className="grid gap-2">
      <div className={cn(large && 'max-h-[60dvh] overflow-auto rounded-md')}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={access.data.url}
          alt="Photo in this message"
          className={large ? 'max-w-none rounded-md' : 'mx-auto max-h-[min(52dvh,560px)] w-auto max-w-full rounded-md object-contain'}
          onError={() => void access.refetch()}
        />
      </div>
      <button
        type="button"
        aria-pressed={large}
        onClick={() => setLarge((l) => !l)}
        className="w-fit rounded-sm text-xs font-medium text-brand-maroon underline-offset-4 outline-none hover:underline focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-brand-maroon"
      >
        {large ? 'Fit to screen' : 'View full size'}
      </button>
    </figure>
  ) : item.kind === 'VIDEO' ? (
    <video
      ref={onMedia}
      src={access.data.url}
      controls
      playsInline
      preload="metadata"
      controlsList="nodownload"
      aria-label="Video in this message"
      className="mx-auto max-h-[min(56dvh,600px)] w-auto max-w-full rounded-md"
      onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
      onError={() => void access.refetch()}
    />
  ) : (
    <div className="grid gap-4 rounded-lg border border-brand-stone bg-surface p-5">
      <span className="grid size-12 place-items-center rounded-full bg-brand-ivory">
        <AudioLines aria-hidden strokeWidth={1.5} className="size-5 text-brand-maroon" />
      </span>
      <audio
        ref={onMedia}
        src={access.data.url}
        controls
        preload="metadata"
        aria-label="Voice recording in this message"
        className="w-full"
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
        onError={() => void access.refetch()}
      />
    </div>
  );
  return (
    <article className="grid gap-5">
      {title}
      {body}
      {duration !== undefined && Number.isFinite(duration) && <p className="text-xs text-foreground-muted">Length {clock(duration)}</p>}
    </article>
  );
}

/** "Preview message": the written message and its files, read-only, as a letter. No private note. */
function MessageDialog({
  open,
  onClose,
  onCloseAutoFocus,
  m,
  names,
  timing,
  media,
}: {
  open: boolean;
  onClose: () => void;
  onCloseAutoFocus: (e: Event) => void;
  m: Message;
  names: string[];
  timing: string;
  media: MediaAsset[];
}) {
  const scope = { kind: 'messages', id: m.id } as const;
  const ready = media.filter((a) => a.status === 'READY');
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent onCloseAutoFocus={onCloseAutoFocus} className="max-h-[88vh] overflow-y-auto bg-surface p-6 sm:max-w-2xl sm:p-10">
        <p className="text-[11px] font-medium tracking-[0.22em] text-foreground-muted uppercase">Private message · preview</p>
        <DialogTitle className="text-[32px] leading-[1.1] font-normal break-words sm:text-[40px]">{m.title}</DialogTitle>
        <DialogDescription>
          {names.length ? `For ${listNames(names)}` : 'No one chosen yet'} · {timing}
        </DialogDescription>
        {m.textContent && (
          <p className="border-y border-border py-8 font-heading text-[20px] leading-[1.75] whitespace-pre-wrap break-words">{m.textContent}</p>
        )}
        {ready.length > 0 && (
          <ul className="grid gap-4">
            {ready.map((a) => (
              <li key={a.id}>
                {a.kind === 'PHOTO' ? (
                  <PhotoPreview scope={scope} asset={a} alt="Photo in this message" />
                ) : a.kind === 'VIDEO' ? (
                  <VideoPreview scope={scope} asset={a} />
                ) : (
                  <AudioPreview scope={scope} asset={a} />
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="flex items-center gap-2 text-xs text-foreground-muted">
          <Lock aria-hidden strokeWidth={1.5} className="size-3.5" />A private preview only visible to you. Nothing is sent.
        </p>
      </DialogContent>
    </Dialog>
  );
}
