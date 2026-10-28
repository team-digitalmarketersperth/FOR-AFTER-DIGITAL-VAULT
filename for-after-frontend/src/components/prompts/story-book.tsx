'use client';

import { ArrowLeft, ArrowRight, BookOpen, ChevronDown, Lock } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import { MediaError, AudioPreview, VideoPreview } from '@/components/media/media-manager';
import { playTurn, snapshot, turnMode, type Snapshot, type TurnMode } from '@/components/prompts/page-turn';
import { StoryProgress } from '@/components/prompts/prompts';
import { SectionHeading } from '@/components/shared/section-heading';
import { Spinner } from '@/components/shared/states';
import { Button } from '@/components/ui/button';
import { useCurrentUser } from '@/hooks/use-auth';
import { useAccessUrl, useMediaList } from '@/hooks/use-media';
import { usePrompts, useStoryBook } from '@/hooks/use-vault';
import type { MediaAsset } from '@/lib/api/media';
import type { BookEntry, StoryBook } from '@/lib/api/prompts';
import { fullName, humanize } from '@/lib/format';

/*
 * My Story as a book (2026-10-19): the owner's saved answers, grouped into
 * chapters by their prompt category in catalogue order, exactly as written.
 * Built by GET /my-story/book on every visit (no second copy, no private
 * notes); files come through the existing My Story media endpoints. Private:
 * no export, print, download or sharing.
 */

const BOOK = '/my-story/book';
/** Answers to prompts no longer in the catalogue: kept in their own, labelled chapter. */
const UNSORTED = 'more';

type Chapter = { key: string; title: string; note?: string; entries: BookEntry[] };

export function chaptersOf(book: StoryBook): Chapter[] {
  const chapters: Chapter[] = book.chapters.map((c) => ({ key: c.category, title: humanize(c.category), entries: c.entries }));
  if (book.unsorted.length) {
    chapters.push({
      key: UNSORTED,
      title: 'More of your story',
      note: 'Answers to questions that are no longer in the prompt list.',
      entries: book.unsorted,
    });
  }
  return chapters;
}

const chapterHref = (key: string) => `${BOOK}?chapter=${encodeURIComponent(key)}`;

// ─── Dashboard ───────────────────────────────────────────────────────────────

/** Compact: up to three chapter titles, real progress, and the way in. Never the answers themselves. */
export function StoryChapters() {
  const book = useStoryBook();
  const prompts = usePrompts('my-story');
  const failed = book.isError || prompts.isError;
  const chapters = book.data ? chaptersOf(book.data) : [];
  const answered = prompts.data?.filter((p) => p.answered).length ?? 0;
  return (
    <section aria-labelledby="story-chapters">
      <SectionHeading
        id="story-chapters"
        title={<>Your story, chapter by <em>chapter</em></>}
        description="Watch your memories come together into your life story."
      />
      {failed ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-surface p-6 text-[15px]">
          <span className="text-foreground-secondary">Your story couldn’t be loaded.</span>
          <Button type="button" size="sm" variant="outline" onClick={() => void Promise.all([book.refetch(), prompts.refetch()])}>
            Try again
          </Button>
        </div>
      ) : book.isPending || prompts.isPending ? (
        <div aria-busy="true" aria-label="Loading your story" className="h-40 animate-pulse rounded-xl border border-border bg-surface-muted" />
      ) : chapters.length === 0 ? (
        <div className="grid gap-3 rounded-xl border border-border bg-brand-ivory p-6 sm:p-8">
          <h3 className="text-[28px] leading-tight">Your story begins with a memory.</h3>
          <p className="text-[15px] text-foreground-secondary">Answer a few thoughtful prompts and watch your chapters take shape.</p>
          <div className="mt-2">
            <Button asChild>
              <Link href="/my-story">Begin your story</Link>
            </Button>
          </div>
        </div>
      ) : (
        <div className="grid gap-6 rounded-xl border border-border bg-brand-ivory p-6 sm:p-8 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
          <div className="grid gap-5">
            <ol aria-label="Your chapters" className="grid gap-2">
              {chapters.slice(0, 3).map((c, i) => (
                <li key={c.key}>
                  <Link
                    href={chapterHref(c.key)}
                    className="group inline-flex items-baseline gap-3 rounded-sm outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-brand-maroon"
                  >
                    <span className="w-20 shrink-0 text-xs font-medium tracking-[0.14em] text-brand-maroon uppercase">Chapter {i + 1}</span>
                    <span className="font-heading text-2xl leading-tight group-hover:underline group-hover:decoration-brand-maroon/40 group-hover:underline-offset-4">
                      {c.title}
                    </span>
                  </Link>
                </li>
              ))}
            </ol>
            {chapters.length > 3 && <p className="text-sm text-foreground-muted">and {chapters.length - 3} more {chapters.length - 3 === 1 ? 'chapter' : 'chapters'}</p>}
            <StoryProgress answered={answered} total={prompts.data!.length} className="max-w-md" />
          </div>
          <div className="flex flex-wrap gap-3">
            <Button asChild>
              <Link href={BOOK}>
                <BookOpen aria-hidden strokeWidth={1.5} />
                Preview My Story
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/my-story">Continue writing</Link>
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

// ─── Reader ──────────────────────────────────────────────────────────────────

/**
 * /my-story/book: cover, contents, one chapter at a time with natural
 * scrolling. ?chapter=KEY (a category key) is the source of truth: links,
 * Back/Forward and direct URLs all arrive through it.
 */
export function StoryBookReader() {
  const wanted = useSearchParams().get('chapter') ?? undefined;
  const book = useStoryBook();
  const me = useCurrentUser();
  const name = me.data ? fullName(me.data) : '';
  const back = (
    <Link
      href="/my-story"
      className="group inline-flex w-fit items-center gap-1.5 rounded-sm text-sm text-foreground-muted outline-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-solid focus-visible:outline-ring"
    >
      <ArrowLeft aria-hidden strokeWidth={1.5} className="size-4" />
      Back to writing
    </Link>
  );
  if (book.isPending) {
    return (
      <div className="grid gap-8">
        {back}
        <p role="status" className="flex items-center gap-2 text-foreground-muted">
          <Spinner /> Opening your story…
        </p>
      </div>
    );
  }
  if (book.isError) {
    return (
      <div className="grid gap-8">
        {back}
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-surface p-6">
          <span className="text-foreground-secondary">Your story couldn’t be loaded.</span>
          <Button type="button" size="sm" variant="outline" onClick={() => void book.refetch()}>
            Try again
          </Button>
        </div>
      </div>
    );
  }
  const chapters = chaptersOf(book.data);
  if (chapters.length === 0) {
    return (
      <div className="grid gap-8">
        {back}
        <section className="grid justify-items-center gap-3 rounded-xl border border-border bg-brand-ivory px-6 py-16 text-center">
          <h1 className="text-5xl">My Story</h1>
          <p className="max-w-md text-foreground-secondary">Your story begins with a memory. Save your first answer and your chapters will appear here.</p>
          <Button asChild className="mt-3">
            <Link href="/my-story">Begin your story</Link>
          </Button>
        </section>
      </div>
    );
  }
  return (
    <div className="grid gap-8">
      {back}
      <header className="grid justify-items-center gap-3 rounded-xl border border-border bg-brand-ivory px-6 py-12 text-center sm:py-16">
        <p className="flex items-center gap-2 text-[11px] font-medium tracking-[0.2em] text-foreground-muted uppercase">
          <Lock aria-hidden strokeWidth={1.5} className="size-3.5" />
          Private · only you can see this
        </p>
        <h1 className="text-5xl leading-none sm:text-6xl">My Story</h1>
        {name && <p className="font-heading text-xl text-foreground-secondary italic">{name}</p>}
        <span aria-hidden className="mt-2 block h-px w-12 bg-brand-maroon/50" />
        <p className="text-sm text-foreground-muted">
          {chapters.length} {chapters.length === 1 ? 'chapter' : 'chapters'}
        </p>
      </header>
      <BookChapters chapters={chapters} wanted={wanted} />
    </div>
  );
}

type Turn = { to: number; dir: 'next' | 'prev'; mode: TurnMode; push: boolean; fromPager: boolean };

/**
 * Contents and one chapter, kept mounted while the reader turns pages (no
 * navigation until a turn has finished). Previous/Next and the contents turn
 * first and then push ?chapter=KEY; a URL that changed by itself
 * (Back/Forward) is turned to once any turn in progress is done.
 */
function BookChapters({ chapters, wanted }: { chapters: Chapter[]; wanted?: string }) {
  const indexOf = (key?: string) => Math.max(0, chapters.findIndex((c) => c.key === key));
  const [shownKey, setShownKey] = useState(() => chapters[indexOf(wanted)].key);
  const [turn, setTurn] = useState<Turn | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const busy = useRef(false);
  // A URL this reader pushed that the router has not reported back yet.
  const pushed = useRef<string | null>(null);
  const snap = useRef<Snapshot | null>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const pagerRef = useRef<HTMLElement>(null);

  const index = indexOf(shownKey);
  const current = chapters[index];
  const prev = chapters[index - 1];
  const next = chapters[index + 1];
  const missing = Boolean(wanted) && !chapters.some((c) => c.key === wanted);

  const start = (to: number, push: boolean) => {
    if (busy.current || to < 0 || to >= chapters.length || to === index) return;
    busy.current = true;
    const page = pageRef.current!;
    const mode = turnMode(page);
    snap.current = mode === 'turn' ? snapshot(page, layerRef.current!) : null;
    setShownKey(chapters[to].key);
    setTurn({ to, dir: to > index ? 'next' : 'prev', mode, push, fromPager: !!pagerRef.current?.contains(document.activeElement) });
  };

  // Runs once the incoming chapter is in the DOM, before it is painted.
  useLayoutEffect(() => {
    if (!turn) return;
    const page = pageRef.current!;
    const wrap = wrapRef.current!;
    // The control that was used can become a disabled end marker.
    if (turn.fromPager && document.activeElement === document.body) pagerRef.current?.querySelector('a')?.focus();
    const s = snap.current;
    let run: { finished: Promise<unknown>; cancel: () => void } = { finished: Promise.resolve(), cancel: () => undefined };
    if (s) {
      // Room for the outgoing slice until it has turned; natural height afterwards.
      wrap.style.minHeight = `${s.height}px`;
      run = playTurn(page, s, turn.dir);
    } else if (turn.mode === 'fade') {
      const fade = page.animate([{ opacity: 0.4 }, { opacity: 1 }], { duration: 160, easing: 'ease-out' });
      run = { finished: fade.finished, cancel: () => fade.cancel() };
    }
    let alive = true;
    void run.finished
      .catch(() => undefined)
      .finally(() => {
        wrap.style.removeProperty('min-height');
        snap.current = null;
        busy.current = false;
        if (!alive) return;
        const { key, title } = chapters[turn.to];
        if (turn.push) {
          pushed.current = key;
          window.history.pushState(null, '', chapterHref(key));
        }
        setAnnouncement(`Chapter ${turn.to + 1}: ${title}`);
        setTurn(null);
      });
    return () => {
      alive = false;
      run.cancel();
    };
    // A new turn starts this; it reads the chapters of that turn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turn]);

  // Follow the URL (Back/Forward, links from elsewhere): never mid-turn, and not
  // back to the old chapter before the router has reported our own push.
  useEffect(() => {
    if (turn) return;
    if (pushed.current !== null) {
      if (wanted !== pushed.current) return;
      pushed.current = null;
    }
    const to = indexOf(wanted);
    if (chapters[to].key !== shownKey) start(to, false);
  });

  const go = (to: number) => (e: MouseEvent<HTMLAnchorElement>) => {
    // A new tab or window keeps working as a plain link.
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    // Phones: close the contents list the chapter was picked from.
    e.currentTarget.closest('details')?.removeAttribute('open');
    start(to, true);
  };

  const contents = (
    <ol className="grid gap-1">
      {chapters.map((c, i) => (
        <li key={c.key}>
          <Link
            href={chapterHref(c.key)}
            onClick={go(i)}
            aria-current={i === index ? 'page' : undefined}
            className="flex items-baseline gap-3 rounded-md px-3 py-2 text-[15px] outline-none hover:bg-surface focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-brand-maroon aria-[current=page]:bg-surface aria-[current=page]:text-brand-maroon"
          >
            <span className="w-5 shrink-0 text-xs text-foreground-muted tabular-nums">{i + 1}</span>
            <span className="font-heading text-lg leading-tight">{c.title}</span>
          </Link>
        </li>
      ))}
    </ol>
  );
  return (
    <div className="grid gap-8 lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-14">
      <nav aria-label="Contents" className="lg:sticky lg:top-24 lg:self-start">
        {/* Phones: a collapsible list; larger screens: always open. */}
        <details className="group rounded-lg border border-border bg-brand-ivory lg:hidden">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-lg px-4 py-3 text-sm font-medium outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-brand-maroon">
            <span>
              Contents · <span className="text-brand-maroon">Chapter {index + 1}: {current.title}</span>
            </span>
            <ChevronDown aria-hidden strokeWidth={1.5} className="size-4 transition-transform group-open:rotate-180 motion-reduce:transition-none" />
          </summary>
          <div className="border-t border-border p-2">{contents}</div>
        </details>
        <div className="hidden lg:grid lg:gap-3">
          <h2 className="eyebrow font-sans">Contents</h2>
          {contents}
        </div>
      </nav>

      <section aria-labelledby="chapter-title" className="min-w-0">
        {missing && (
          <p role="status" className="mb-6 rounded-md bg-surface-muted px-4 py-3 text-sm text-foreground-secondary">
            That chapter has no saved answers now, so here is the first one.
          </p>
        )}
        <p role="status" className="sr-only">
          {announcement}
        </p>
        {/* The reading surface, the only part that turns. Clipped while turning so the lifted page never widens the screen. */}
        <div ref={wrapRef} className={turn ? 'relative overflow-x-clip' : 'relative'}>
          <div ref={layerRef} className="pointer-events-none absolute inset-x-0 top-0" />
          <div ref={pageRef} className="relative" aria-busy={turn ? true : undefined}>
            <p className="text-xs font-medium tracking-[0.2em] text-brand-maroon uppercase">Chapter {index + 1}</p>
            <h2 id="chapter-title" className="mt-2 text-[40px] leading-[1.05] break-words sm:text-5xl">
              {current.title}
            </h2>
            {current.note && <p className="mt-3 text-sm text-foreground-muted">{current.note}</p>}
            <span aria-hidden className="mt-6 block h-px w-16 bg-brand-maroon/50" />
            <div className="mt-10 grid max-w-[40rem] gap-14">
              {current.entries.map((e) => (
                <Entry key={e.promptKey} entry={e} inCatalogue={current.key !== UNSORTED} />
              ))}
            </div>
          </div>
        </div>
        <nav ref={pagerRef} aria-label="Chapters" className="mt-16 grid gap-3 border-t border-border pt-6 sm:grid-cols-2">
          {prev ? (
            <ChapterLink href={chapterHref(prev.key)} dir="prev" label={`Chapter ${index}`} title={prev.title} busy={!!turn} onClick={go(index - 1)} />
          ) : (
            <ChapterEnd dir="prev" />
          )}
          {next ? (
            <ChapterLink href={chapterHref(next.key)} dir="next" label={`Chapter ${index + 2}`} title={next.title} busy={!!turn} onClick={go(index + 1)} />
          ) : (
            <ChapterEnd dir="next" />
          )}
        </nav>
      </section>
    </div>
  );
}

function ChapterLink({
  href,
  dir,
  label,
  title,
  busy,
  onClick,
}: {
  href: string;
  dir: 'prev' | 'next';
  label: string;
  title: string;
  busy: boolean;
  onClick: (e: MouseEvent<HTMLAnchorElement>) => void;
}) {
  const Icon = dir === 'prev' ? ArrowLeft : ArrowRight;
  return (
    <Link
      href={href}
      rel={dir}
      onClick={onClick}
      // Ignored (not removed) while a page turns, so focus stays where it is.
      aria-disabled={busy || undefined}
      className={`group grid gap-1 rounded-lg p-4 outline-none hover:bg-brand-ivory focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-brand-maroon aria-disabled:cursor-default ${dir === 'next' ? 'sm:col-start-2 sm:text-right' : ''}`}
    >
      <span className={`flex items-center gap-1.5 text-xs text-foreground-muted ${dir === 'next' ? 'sm:justify-end' : ''}`}>
        {dir === 'prev' && <Icon aria-hidden strokeWidth={1.5} className="size-3.5" />}
        {dir === 'prev' ? 'Previous' : 'Next'} · {label}
        {dir === 'next' && <Icon aria-hidden strokeWidth={1.5} className="size-3.5" />}
      </span>
      <span className="font-heading text-xl leading-tight text-foreground">{title}</span>
    </Link>
  );
}

/** First or last chapter: the control stays in place, disabled; the book never wraps around. */
function ChapterEnd({ dir }: { dir: 'prev' | 'next' }) {
  return (
    <span aria-disabled="true" className={`grid gap-1 rounded-lg p-4 text-foreground-muted ${dir === 'next' ? 'sm:col-start-2 sm:text-right' : ''}`}>
      <span className="text-xs">{dir === 'prev' ? 'Previous' : 'Next'}</span>
      <span className="font-heading text-xl leading-tight">{dir === 'prev' ? 'This is the first chapter' : 'This is the last chapter'}</span>
    </span>
  );
}

/** One answer: the question it answers, then the owner's own words and files. */
function Entry({ entry: e, inCatalogue }: { entry: BookEntry; inCatalogue: boolean }) {
  return (
    <article className="grid gap-5">
      <h3 className="font-sans text-sm font-medium tracking-wide text-foreground-muted">{e.prompt}</h3>
      {e.textContent?.trim() && (
        // Plain text with its own paragraphs and line breaks, never HTML.
        <p className="font-heading text-[20px] leading-[1.8] whitespace-pre-wrap break-words text-foreground sm:text-[21px]">{e.textContent}</p>
      )}
      {e.mediaCount > 0 &&
        (inCatalogue ? (
          <EntryMedia promptKey={e.promptKey} />
        ) : (
          <p className="text-sm text-foreground-muted">
            {e.mediaCount} {e.mediaCount === 1 ? 'file' : 'files'} saved with this answer can’t be shown here.
          </p>
        ))}
      {e.memories.length > 0 && (
        <div className="grid gap-2">
          <p className="text-xs font-medium tracking-[0.14em] text-foreground-muted uppercase">From your Memory Vault</p>
          <ul className="flex flex-wrap gap-2">
            {e.memories.map((m) => (
              <li key={m.id}>
                <Link
                  href={`/memory-vault/${m.id}`}
                  className="inline-flex rounded-full border border-border bg-surface px-3 py-1 text-sm outline-none hover:border-border-strong focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-brand-maroon"
                >
                  {m.title}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </article>
  );
}

/** The answer's READY files through the existing, owner-checked My Story media endpoints. */
function EntryMedia({ promptKey }: { promptKey: string }) {
  const scope = { kind: 'my-story', id: promptKey } as const;
  const list = useMediaList(scope);
  if (list.isPending) return <p className="flex items-center gap-2 text-sm text-foreground-muted"><Spinner /> Loading files…</p>;
  if (!list.data) return <MediaError onRetry={() => void list.refetch()} />;
  const ready = list.data.filter((a) => a.status === 'READY');
  return (
    <ul className="grid gap-6">
      {ready.map((a) => (
        <li key={a.id}>
          {a.kind === 'PHOTO' ? <BookPhoto scope={scope} asset={a} /> : a.kind === 'VIDEO' ? <VideoPreview scope={scope} asset={a} /> : <AudioPreview scope={scope} asset={a} />}
        </li>
      ))}
    </ul>
  );
}

/** The whole photo at its own proportions (never cropped). */
function BookPhoto({ scope, asset }: { scope: { kind: 'my-story'; id: string }; asset: MediaAsset }) {
  const access = useAccessUrl(scope, asset.id);
  if (!access.data) return access.error ? <MediaError onRetry={() => void access.refetch()} /> : <div className="h-48 animate-pulse rounded-md bg-surface-muted" />;
  // Signed private URL: plain <img>, never the Next optimizer.
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={access.data.url} alt="Photo saved with this answer" loading="lazy" className="h-auto max-h-[75vh] w-auto max-w-full rounded-md" onError={() => void access.refetch()} />;
}
