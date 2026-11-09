'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { ArrowDown, ArrowRight, ArrowUp, Check, ExternalLink, Info, Lock, Music, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState, type BaseSyntheticEvent, type ReactNode } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { FormError, TextAreaField, TextField } from '@/components/shared/form-field';
import { EmptyState, QueryView, Spinner } from '@/components/shared/states';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { wishSongs } from '@/hooks/use-vault';
import type { SongMoment, WishSong } from '@/lib/api/prompts';
import { normaliseSongLink } from '@/lib/song-link';
import { cn } from '@/lib/utils';
import { SONG_MAX, songSchema, toNull, type SongValues } from '@/schemas/vault';

const MOMENTS: Record<SongMoment, string> = {
  ARRIVAL: 'Arrival',
  REFLECTION: 'Reflection',
  FAREWELL: 'Farewell',
  OTHER: 'Other',
};

const momentText = (s: WishSong) =>
  s.moment === 'OTHER' && s.momentOther ? `Other: ${s.momentOther}` : s.moment && MOMENTS[s.moment];

/**
 * "Music I’d like remembered": songs for the funeral, part of My Wishes.
 * Private like every wish (only the owner can see them; nothing is sent,
 * scheduled or shared). Each song is saved on its own from its dialog.
 */
export function WishSongs() {
  const list = wishSongs.useList();
  const heading = useRef<HTMLHeadingElement>(null);
  return (
    <section aria-labelledby="wish-songs" className="mt-14 grid gap-5">
      <div className="grid gap-1">
        <h2 id="wish-songs" ref={heading} tabIndex={-1} className="flex items-center gap-2 text-2xl outline-none">
          <Music aria-hidden strokeWidth={1.5} className="size-5 shrink-0 text-primary" />
          Music I’d like remembered
        </h2>
        <p className="text-sm text-foreground-muted">
          Add the songs you’d like played, with a link or a note to help your loved ones find the right version.
        </p>
      </div>
      <QueryView query={list} loadingLabel="Loading your songs">
        {(songs) =>
          songs.length === 0 ? (
            <EmptyState heading="h3" icon={Music} title="No songs added yet." action={<AddSong />} />
          ) : (
            <SongList songs={songs} onRemoved={() => heading.current?.focus()} />
          )
        }
      </QueryView>
    </section>
  );
}

function AddSong() {
  return (
    <SongDialog
      trigger={
        <Button type="button">
          <Plus aria-hidden strokeWidth={1.5} />
          Add a song
        </Button>
      }
    />
  );
}

function SongList({ songs, onRemoved }: { songs: WishSong[]; onRemoved: () => void }) {
  const reorder = wishSongs.useReorder();
  const moved = useRef<{ id: string; dir: 'up' | 'down' } | null>(null);
  const [announcement, setAnnouncement] = useState('');

  // A moved row is re-inserted in the DOM, which drops focus: put it back on
  // that song's control (also after a failed move restores the order).
  useEffect(() => {
    const m = moved.current;
    if (!m || (document.activeElement && document.activeElement !== document.body)) return;
    const own = document.getElementById(`song-${m.dir}-${m.id}`) as HTMLButtonElement | null;
    const other = document.getElementById(`song-${m.dir === 'up' ? 'down' : 'up'}-${m.id}`);
    (own && !own.disabled ? own : other)?.focus();
  }, [songs]);

  const move = (index: number, dir: 'up' | 'down') => {
    const to = dir === 'up' ? index - 1 : index + 1;
    const next = [...songs];
    [next[index], next[to]] = [next[to], next[index]];
    const song = songs[index];
    moved.current = { id: song.id, dir };
    reorder.mutate(next, {
      onSuccess: () => setAnnouncement(`${song.title} moved to position ${to + 1} of ${songs.length}.`),
      onError: () => setAnnouncement('The order couldn’t be saved. Your songs are back in their saved order.'),
    });
  };

  return (
    <>
      <FormError error={reorder.error} title="The new order wasn’t saved" />
      <ol aria-label="Your songs" className="grid gap-3">
        {songs.map((song, i) => (
          <SongItem
            key={song.id}
            song={song}
            controls={
              <>
                <Button
                  id={`song-up-${song.id}`}
                  type="button"
                  size="icon"
                  variant="outline"
                  aria-label={`Move ${song.title} up`}
                  disabled={i === 0 || reorder.isPending}
                  onClick={() => move(i, 'up')}
                >
                  <ArrowUp aria-hidden strokeWidth={1.5} />
                </Button>
                <Button
                  id={`song-down-${song.id}`}
                  type="button"
                  size="icon"
                  variant="outline"
                  aria-label={`Move ${song.title} down`}
                  disabled={i === songs.length - 1 || reorder.isPending}
                  onClick={() => move(i, 'down')}
                >
                  <ArrowDown aria-hidden strokeWidth={1.5} />
                </Button>
              </>
            }
            onRemoved={onRemoved}
          />
        ))}
      </ol>
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
      <div>
        <AddSong />
      </div>
    </>
  );
}

function SongItem({ song, controls, onRemoved }: { song: WishSong; controls: ReactNode; onRemoved: () => void }) {
  const remove = wishSongs.useRemove();
  // Only a link that still passes the check is ever offered as a link.
  const link = song.link && normaliseSongLink(song.link);
  const service = link?.includes('spotify.com') ? 'Spotify' : 'YouTube';
  const timing = momentText(song);
  return (
    <li className="grid gap-4 rounded-lg border border-border bg-surface p-5 sm:grid-cols-[1fr_auto] sm:items-start sm:p-6">
      <div className="grid min-w-0 gap-1.5">
        <p className="font-medium break-words">{song.title}</p>
        {timing && <p className="text-sm break-words text-foreground-muted">When to play it: {timing}</p>}
        {song.note && (
          <p className="text-[15px] leading-relaxed break-words whitespace-pre-line text-foreground-secondary">
            {song.note}
          </p>
        )}
        {link && (
          <a
            href={link}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex w-fit items-center gap-1.5 rounded-sm text-sm font-semibold text-primary outline-none hover:underline focus-visible:outline-2 focus-visible:outline-ring"
          >
            Open song
            <ExternalLink aria-hidden className="size-3.5" />
            <span className="sr-only"> (opens {service} in a new tab)</span>
          </a>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {controls}
        <SongDialog
          song={song}
          trigger={
            <Button type="button" variant="outline" size="sm" aria-label={`Edit ${song.title}`}>
              <Pencil aria-hidden strokeWidth={1.5} />
              Edit
            </Button>
          }
        />
        <ConfirmDialog
          trigger={
            <Button type="button" variant="ghost" size="sm" aria-label={`Remove ${song.title}`}>
              <Trash2 aria-hidden strokeWidth={1.5} />
              Remove
            </Button>
          }
          title="Remove this song?"
          description={`“${song.title}” will be removed from your list. Your other songs and wishes stay as they are.`}
          confirmLabel="Remove song"
          pending={remove.isPending}
          error={remove.error}
          onConfirm={() =>
            remove.mutateAsync(song.id).then(() => {
              toast.success('Song removed');
              onRemoved();
            })
          }
        />
      </div>
    </li>
  );
}

const toValues = (song?: WishSong): SongValues => ({
  title: song?.title ?? '',
  link: song?.link ?? '',
  moment: song?.moment ?? '',
  momentOther: song?.momentOther ?? '',
  note: song?.note ?? '',
});

const STEPS = ['Your song', 'Personal details'] as const;

/** Numbered progress; the current step is aria-current, a finished one says so. */
function SongSteps({ step }: { step: 1 | 2 }) {
  return (
    <div className="grid gap-2">
      <ol aria-label="Progress" className="flex items-center gap-3">
        {STEPS.map((label, i) => {
          const n = i + 1;
          const done = n < step;
          const current = n === step;
          return (
            <li key={label} aria-current={current ? 'step' : undefined} className="flex min-w-0 items-center gap-2 text-sm">
              {i > 0 && <span aria-hidden className="h-px w-6 shrink-0 bg-border-strong sm:w-12" />}
              <span
                aria-hidden
                className={cn(
                  'flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
                  done || current ? 'bg-primary text-primary-foreground' : 'border border-border-strong text-foreground-muted',
                )}
              >
                {done ? <Check className="size-3.5" strokeWidth={2.5} /> : n}
              </span>
              <span className={cn('truncate', current ? 'font-medium text-primary' : 'text-foreground-muted')}>
                {label}
                {done && <span className="sr-only"> (completed)</span>}
              </span>
            </li>
          );
        })}
      </ol>
      <p className="text-sm text-foreground-muted">Step {step} of 2</p>
    </div>
  );
}

/**
 * Add or edit one song in two steps: the song (title, link), then optional
 * details (timing, note). Moving between steps never saves; nothing is saved
 * until "Save song" (or "Skip and save"). Cancel, Escape or the close button
 * keep what is saved.
 */
function SongDialog({ song, trigger }: { song?: WishSong; trigger: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<1 | 2>(1);
  const save = wishSongs.useSave();
  const form = useForm<SongValues>({ resolver: zodResolver(songSchema), defaultValues: toValues(song) });
  const { errors } = form.formState;
  const [title, moment, momentOther, note] = useWatch({
    control: form.control,
    name: ['title', 'moment', 'momentOther', 'note'],
  });
  const detailsHeading = useRef<HTMLHeadingElement>(null);
  // Only when adding with nothing optional entered: it then saves exactly what
  // "Save song" would, so it can never drop a detail (or a stored one on edit).
  const canSkip = !song && !moment && !momentOther.trim() && !note.trim();

  const setOpenState = (next: boolean) => {
    if (save.isPending) return;
    if (next) {
      form.reset(toValues(song));
      save.reset();
      setStep(1);
    }
    setOpen(next);
  };
  const goTo = (next: 1 | 2) => {
    setStep(next);
    // After the new step renders: its heading, or back to the title.
    requestAnimationFrame(() => (next === 2 ? detailsHeading.current?.focus() : form.setFocus('title')));
  };
  const submitSong = form.handleSubmit((v) =>
    save
      .mutateAsync({
        id: song?.id,
        input: {
          title: v.title,
          link: toNull(v.link),
          moment: v.moment || null,
          momentOther: v.moment === 'OTHER' ? toNull(v.momentOther) : null,
          note: toNull(v.note),
        },
      })
      .then(() => {
        toast.success('Song saved');
        setOpen(false);
      }),
  );
  // Synchronous guard: two quick clicks both pass async validation before
  // isPending re-renders, and must still send one request.
  const saving = useRef(false);
  const saveSong = async (e?: BaseSyntheticEvent) => {
    if (saving.current) return;
    saving.current = true;
    try {
      await submitSong(e);
    } catch {
      // Shown from save.error; the dialog keeps every value.
    } finally {
      saving.current = false;
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpenState}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent
        // Header and fields scroll in one region; the footer stays put. dvh and
        // safe areas keep it inside phone viewports and above the keyboard.
        className="flex max-h-[calc(100dvh-2rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))] flex-col gap-0 rounded-xl bg-surface p-0 shadow-lg sm:max-w-lg"
        showCloseButton={false}
        // Start on the title, not the close button (the first focusable element).
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          form.setFocus('title');
        }}
      >
        <DialogClose asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Close"
            disabled={save.isPending}
            className="absolute top-3 right-3 z-10 bg-surface"
          >
            <X aria-hidden strokeWidth={1.5} />
          </Button>
        </DialogClose>
        <form
          noValidate
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(e) => {
            e.preventDefault();
            // Enter on step 1 only moves on, after checking the song; it never saves.
            if (step === 1) {
              void form.trigger(['title', 'link'], { shouldFocus: true }).then((ok) => ok && goTo(2));
              return;
            }
            void saveSong(e);
          }}
        >
          <div className="companion-scroll grid min-h-0 flex-1 content-start gap-5 overflow-y-auto px-5 pt-5 pb-5 sm:gap-6 sm:px-8 sm:pt-8 sm:pb-6">
            <DialogHeader className="gap-2 pr-10">
              <span aria-hidden className="mb-1 flex size-10 items-center justify-center rounded-full bg-primary-soft text-primary sm:mb-2 sm:size-12">
                <Music className="size-5" strokeWidth={1.5} />
              </span>
              <DialogTitle className="text-[28px] leading-tight font-normal sm:text-[32px]">{song ? 'Edit song' : 'Add a song'}</DialogTitle>
              <DialogDescription className="text-[15px] leading-relaxed text-foreground-secondary">
                Keep the music that matters to you.
              </DialogDescription>
            </DialogHeader>
            <SongSteps step={step} />
            <FormError error={save.error} title="Your song wasn’t saved" />
            <fieldset disabled={save.isPending} className="grid min-w-0 gap-5 sm:gap-6">
              {step === 1 ? (
                <>
                  <TextField
                    id="song-title"
                    label="Song title"
                    required
                    maxLength={SONG_MAX.title}
                    error={errors.title?.message}
                    {...form.register('title')}
                  />
                  <TextField
                    id="song-link"
                    label="Song link"
                    optional
                    type="url"
                    inputMode="url"
                    autoComplete="off"
                    placeholder="https://"
                    maxLength={SONG_MAX.link}
                    hint="Add a YouTube or Spotify link. No account connection needed."
                    error={errors.link?.message}
                    {...form.register('link')}
                  />
                  <p className="flex items-center gap-3 rounded-lg bg-surface-muted px-4 py-3 text-sm text-foreground-secondary">
                    <Lock aria-hidden strokeWidth={1.5} className="size-4 shrink-0" />
                    Only you can see your songs. Saving won’t share them.
                  </p>
                </>
              ) : (
                <>
                  <h3 ref={detailsHeading} tabIndex={-1} className="sr-only">
                    Personal details
                  </h3>
                  <div className="flex min-w-0 items-center gap-3 rounded-lg border border-border bg-surface-muted px-4 py-3">
                    <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-full bg-surface text-primary">
                      <Music className="size-4" strokeWidth={1.5} />
                    </span>
                    <p className="grid min-w-0">
                      <span className="font-medium break-words">{title}</span>
                      <span className="text-sm text-foreground-muted">Your selected song</span>
                    </p>
                  </div>
                  <fieldset className="grid gap-3">
                    <legend className="mb-3 text-sm font-medium">
                      When to play <span className="font-normal text-foreground-muted">(optional)</span>
                    </legend>
                    <div className="flex flex-wrap gap-2">
                      {[['', 'Not set'] as const, ...Object.entries(MOMENTS)].map(([value, label]) => (
                        <label
                          key={value}
                          className="inline-flex min-h-11 cursor-pointer items-center gap-1.5 rounded-full border border-border-strong bg-surface px-4 text-sm transition-colors hover:border-primary has-[:checked]:border-primary has-[:checked]:bg-primary has-[:checked]:text-primary-foreground has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring motion-reduce:transition-none"
                        >
                          <input type="radio" value={value} className="sr-only" {...form.register('moment')} />
                          {moment === value && <Check aria-hidden className="size-3.5" strokeWidth={2.5} />}
                          {label}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                  {moment === 'OTHER' && (
                    <TextField
                      id="song-moment-other"
                      label="When would you like it played?"
                      optional
                      maxLength={SONG_MAX.momentOther}
                      error={errors.momentOther?.message}
                      {...form.register('momentOther')}
                    />
                  )}
                  <TextAreaField
                    id="song-note"
                    label="Personal note"
                    optional
                    hint="Why it matters, or the version you love."
                    className="min-h-24"
                    maxLength={SONG_MAX.note}
                    length={note.length}
                    error={errors.note?.message}
                    {...form.register('note')}
                  />
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="flex items-center gap-2 text-sm text-foreground-muted">
                      <Info aria-hidden strokeWidth={1.5} className="size-4 shrink-0" />
                      You can leave these details blank.
                    </p>
                    {canSkip && (
                      <Button type="button" variant="link" className="min-h-11 px-0" onClick={() => void saveSong()}>
                        Skip and save
                      </Button>
                    )}
                  </div>
                </>
              )}
            </fieldset>
          </div>
          <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border px-5 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-8">
            {step === 1 ? (
              <>
                <Button type="button" variant="outline" size="lg" onClick={() => setOpenState(false)}>
                  Cancel
                </Button>
                <Button type="submit" size="lg">
                  Continue
                  <ArrowRight aria-hidden strokeWidth={1.5} />
                </Button>
              </>
            ) : (
              <>
                <Button type="button" variant="outline" size="lg" disabled={save.isPending} onClick={() => goTo(1)}>
                  Back
                </Button>
                <Button type="submit" size="lg" disabled={save.isPending}>
                  {save.isPending && <Spinner />}
                  Save song
                </Button>
              </>
            )}
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
