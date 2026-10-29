'use client';

import { BookOpen, Check, ChevronDown, ChevronLeft, ChevronRight, ImagePlus, Send, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Tabs } from 'radix-ui';
import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { toast } from 'sonner';
import { HelpMeWrite } from '@/components/companion/companion';
import { KIND_LABEL, MediaTile, UploadFailed, UploadProgress } from '@/components/media/media-manager';
import { EarlierWording, EXTRAS, LinkedMemories, MemorySearch } from '@/components/prompts/prompts';
import { chaptersOf } from '@/components/prompts/story-book';
import { AutosaveStatus, RecoveryNotice } from '@/components/shared/draft-recovery';
import { FormError, TextAreaField } from '@/components/shared/form-field';
import { PrivateNoteField } from '@/components/shared/private-note';
import { EmptyState, QueryView, Spinner } from '@/components/shared/states';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useDraftEditor } from '@/hooks/use-draft-editor';
import { useMediaList, useUpload } from '@/hooks/use-media';
import { useUnsavedChanges } from '@/hooks/use-unsaved-changes';
import { useAnswerMutation, usePrompts, useStoryBook } from '@/hooks/use-vault';
import { textRevision } from '@/lib/api/drafts';
import { MIME_TYPES, type MediaKind } from '@/lib/api/media';
import { ANSWER_MAX, type Prompt } from '@/lib/api/prompts';
import { humanize } from '@/lib/format';
import { cn } from '@/lib/utils';
import { answerSchema } from '@/schemas/vault';

const maroon = 'bg-brand-maroon text-white hover:bg-brand-maroon/90';
const card = 'rounded-xl border border-brand-stone bg-surface shadow-[0_1px_2px_rgb(43_34_48/0.04)]';

/** Groups are the catalogue's categories, in the API's order (the same chapters the book uses). */
/**
 * Radix returns focus only to its own Trigger; these dialogs open from several
 * buttons, so focus goes back to whichever one opened them.
 */
function useReturnFocus() {
  const opener = useRef<HTMLElement | null>(null);
  return {
    onOpenAutoFocus: () => {
      opener.current = document.activeElement as HTMLElement | null;
    },
    onCloseAutoFocus: (e: Event) => {
      e.preventDefault();
      opener.current?.focus();
    },
  };
}

const groupsOf = (prompts: Prompt[]) => [...new Set(prompts.map((p) => p.category))];
const startOf = (prompts: Prompt[]) => prompts.find((p) => !p.answered) ?? prompts[0];

/**
 * My Story (approved design, 2026-10-27): one question at a time, the
 * catalogue's categories as chapters on the right; "Help me write" opens the
 * shared For After companion (`components/companion`) for this question.
 * Photos, memories, the private note, delete and sharing stay on the full
 * answer page (`/my-story/[promptKey]`).
 */
export function StoryWorkspace({ category }: { category?: string }) {
  const router = useRouter();
  const list = usePrompts('my-story');
  const [selected, setSelected] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [uploading, setUploading] = useState(false);
  const save = useRef<() => Promise<boolean>>(async () => true);
  // A move waiting on the unsaved-changes dialog.
  const [pending, setPending] = useState<(() => void) | null>(null);
  const blocked = dirty || uploading;
  useUnsavedChanges(blocked);

  const prompts = list.data ?? [];
  const groups = groupsOf(prompts);
  const initial =
    category && groups.includes(category) ? startOf(prompts.filter((p) => p.category === category)) : startOf(prompts);
  const index = Math.max(0, prompts.findIndex((p) => p.key === (selected ?? initial?.key)));
  const current = prompts[index] as Prompt | undefined;

  const guard = (move: () => void) => (blocked ? setPending(() => move) : move());
  // In-page links to other pages wait for the same choice while there are edits.
  const guardLink = (href: string) => (e: MouseEvent) => {
    if (!blocked) return;
    e.preventDefault();
    setPending(() => () => router.push(href));
  };

  return (
    <div className="pb-24">
      <header className="mb-8 grid gap-4">
        <nav aria-label="Breadcrumb">
          <ol className="flex gap-2 text-sm text-foreground-muted">
            <li>Your legacy</li>
            <li aria-hidden>/</li>
            <li aria-current="page" className="text-brand-maroon">
              My Story
            </li>
          </ol>
        </nav>
        <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div className="grid gap-3">
            <h1 className="text-[40px] leading-[1.05] sm:text-5xl">Every life holds a story.</h1>
            <p className="text-lg text-foreground-muted">Capture the memories and moments that made you.</p>
          </div>
          <Button asChild variant="outline" className="w-fit border-brand-maroon text-brand-maroon">
            <Link href="/my-story/book" onClick={guardLink('/my-story/book')}>
              <BookOpen aria-hidden strokeWidth={1.5} />
              View my book
            </Link>
          </Button>
        </div>
      </header>

      <Tabs.Root defaultValue="answers" activationMode="manual">
        <Tabs.List aria-label="My Story" className="mb-8 flex gap-6 border-b border-brand-stone">
          {[
            ['answers', 'Your answers'],
            ['chapters', 'Chapters'],
          ].map(([value, label]) => (
            <Tabs.Trigger
              key={value}
              value={value}
              className="-mb-px rounded-t-sm border-b-2 border-transparent px-1 pb-3 text-[15px] font-semibold text-foreground-muted outline-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring data-[state=active]:border-brand-maroon data-[state=active]:text-brand-maroon"
            >
              {label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>

        {/* Kept mounted so switching tabs never loses typed text. */}
        <Tabs.Content value="answers" forceMount className="outline-none data-[state=inactive]:hidden">
          <QueryView query={list} loadingLabel="Loading My Story">
            {() => {
              if (!current) {
                return <EmptyState icon={BookOpen} title="No questions yet" description="Questions will appear here." />;
              }
              const p = current;
              const go = (key: string) => guard(() => setSelected(key));
              return (
                <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] lg:items-start lg:gap-8">
                  <ChapterNav
                    prompts={prompts}
                    groups={groups}
                    current={p.category}
                    onSelect={(g) => go(startOf(prompts.filter((x) => x.category === g)).key)}
                  />
                  <FocusedEditor
                    key={p.key}
                    prompt={p}
                    group={prompts.filter((x) => x.category === p.category)}
                    onDirty={setDirty}
                    onUploading={setUploading}
                    registerSave={(fn) => {
                      save.current = fn;
                    }}
                    onPrev={index > 0 ? () => go(prompts[index - 1].key) : undefined}
                    onNext={index < prompts.length - 1 ? () => go(prompts[index + 1].key) : undefined}
                    // Keeps this question once saved, though "first unanswered" moves on.
                    onSaved={() => setSelected(p.key)}
                    guardLink={guardLink}
                  />
                  <BringTogether />
                </div>
              );
            }}
          </QueryView>
        </Tabs.Content>

        <Tabs.Content value="chapters" className="outline-none">
          <ChaptersTab guardLink={guardLink} />
        </Tabs.Content>
      </Tabs.Root>

      <UnsavedDialog
        pending={pending}
        unsaved={dirty}
        uploading={uploading}
        onClose={() => setPending(null)}
        save={() => save.current()}
      />
    </div>
  );
}

/**
 * "Your chapters": each category with its real saved count. Below lg (one
 * column) a compact menu; from lg the vertical list. Only one is displayed,
 * so the hidden one is never focusable. Both call the same onSelect.
 */
function ChapterNav({
  prompts,
  groups,
  current,
  onSelect,
}: {
  prompts: Prompt[];
  groups: string[];
  current: string;
  onSelect: (group: string) => void;
}) {
  const chapters = groups.map((g) => {
    const inGroup = prompts.filter((p) => p.category === g);
    const done = inGroup.filter((p) => p.answered).length;
    return { g, title: humanize(g), done, total: inGroup.length, label: `${humanize(g)}, ${done} of ${inGroup.length} answers saved` };
  });
  const active = chapters.find((c) => c.g === current) ?? chapters[0];
  // Selected in the menu, applied once it has closed and focus is back on its
  // trigger, so the unsaved-changes dialog returns focus there too.
  const chosen = useRef<string | null>(null);
  return (
    <nav aria-labelledby="your-chapters" className={cn(card, 'min-w-0 p-4 lg:col-start-2 lg:row-start-1 lg:p-6')}>
      <h2 id="your-chapters" className="mb-3 font-sans text-xs font-medium tracking-[0.14em] text-brand-bronze uppercase lg:mb-4 lg:font-heading lg:text-2xl lg:tracking-tight lg:text-foreground lg:normal-case">
        Your chapters
      </h2>
      <div className="lg:hidden">
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={`Chapter: ${active.label}. Choose a chapter`}
            className="flex min-h-11 w-full min-w-0 items-center gap-3 rounded-lg border border-brand-maroon bg-brand-ivory px-3 py-2 text-left text-[0.9375rem] font-semibold text-brand-maroon outline-none hover:bg-brand-ivory/70 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring"
          >
            <span className="min-w-0 flex-1 break-words">{active.title}</span>
            <span className="text-sm font-normal text-foreground-muted tabular-nums">
              {active.done}/{active.total}
            </span>
            <ChevronDown aria-hidden className="size-4 shrink-0" />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            collisionPadding={16}
            onCloseAutoFocus={() => {
              const g = chosen.current;
              chosen.current = null;
              if (g) onSelect(g);
            }}
            className="rounded-xl p-1.5 shadow-menu ring-border">
            <DropdownMenuRadioGroup value={current}>
              {chapters.map((c) => (
                <DropdownMenuRadioItem
                  key={c.g}
                  value={c.g}
                  aria-label={c.label}
                  onSelect={() => {
                    chosen.current = c.g;
                  }}
                  className="min-h-11 gap-3 rounded-lg px-3 py-2 pr-9 text-[0.9375rem] data-[state=checked]:bg-brand-ivory data-[state=checked]:font-semibold data-[state=checked]:text-brand-maroon"
                >
                  <span className="min-w-0 flex-1 break-words">{c.title}</span>
                  <span className="text-sm font-normal text-foreground-muted tabular-nums">
                    {c.done}/{c.total}
                  </span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <ol className="hidden gap-2 lg:grid">
        {chapters.map((c) => {
          const isActive = c.g === current;
          return (
            <li key={c.g} className="min-w-0">
              <button
                type="button"
                aria-current={isActive ? 'true' : undefined}
                aria-label={c.label}
                onClick={() => onSelect(c.g)}
                className={cn(
                  'flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left text-[0.9375rem] outline-none hover:bg-brand-ivory focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring',
                  isActive ? 'border-brand-maroon bg-brand-ivory font-semibold text-brand-maroon' : 'border-transparent',
                )}
              >
                <span className="min-w-0 flex-1 break-words">{c.title}</span>
                <span className="text-sm text-foreground-muted tabular-nums">
                  {c.done}/{c.total}
                </span>
                {c.done === c.total && <Check aria-hidden className="size-4 shrink-0 text-brand-bronze" />}
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function FocusedEditor({
  prompt: p,
  group,
  onDirty,
  onUploading,
  registerSave,
  onPrev,
  onNext,
  onSaved,
  guardLink,
}: {
  prompt: Prompt;
  group: Prompt[];
  onDirty: (dirty: boolean) => void;
  onUploading: (uploading: boolean) => void;
  registerSave: (save: () => Promise<boolean>) => void;
  onPrev?: () => void;
  onNext?: () => void;
  onSaved: () => void;
  guardLink: (href: string) => (e: MouseEvent) => void;
}) {
  const mutation = useAnswerMutation('my-story', p.key);
  const [saved, setSaved] = useState({ text: p.response?.textContent ?? '', note: p.response?.privateNote ?? '' });
  const [text, setText] = useState(saved.text);
  const [note, setNote] = useState(saved.note);
  const [errors, setErrors] = useState<{ textContent?: string; privateNote?: string }>({});
  const [status, setStatus] = useState('');
  // Remounts the autosave after each explicit Save (the server drops the draft then).
  const [saves, setSaves] = useState(0);
  // The companion reads the answer when the Customer includes it or uses a draft, never on its own.
  const latest = useRef(text);
  useEffect(() => {
    latest.current = text;
  }, [text]);
  const dirty = text !== saved.text || note !== saved.note;
  const done = group.filter((x) => x.answered).length;
  const label = humanize(p.category);

  const save = async () => {
    if (mutation.isPending) return false;
    const check = answerSchema('my-story').safeParse({ textContent: text, privateNote: note });
    if (!check.success) {
      setErrors(Object.fromEntries(check.error.issues.map((i) => [i.path[0], i.message])));
      return false;
    }
    setErrors({});
    setStatus('Saving your answer…');
    const sent = { text, note };
    try {
      // Words and private note, as the full answer page sends them; files and links are saved on their own.
      await mutation.mutateAsync({ textContent: sent.text.trim() ? sent.text : null, privateNote: sent.note.trim() || null });
      setSaved(sent);
      setSaves((n) => n + 1);
      onSaved();
      setStatus('Your answer and private note are saved.');
      return true;
    } catch {
      setStatus('');
      return false;
    }
  };
  useEffect(() => registerSave(save));
  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  // Unmounting (question switch after "Discard") leaves the page clean.
  useEffect(() => () => onDirty(false), [onDirty]);

  return (
    <section aria-labelledby="story-question" className={cn(card, 'grid min-w-0 gap-6 p-6 sm:p-10 lg:col-start-1 lg:row-span-2 lg:row-start-1')}>
      <div className="grid gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
          <p className="eyebrow text-brand-bronze">{label}</p>
          <p className="text-foreground-muted">
            {done} of {group.length} answers saved
          </p>
        </div>
        <div
          role="progressbar"
          aria-label={`${label} progress`}
          aria-valuemin={0}
          aria-valuemax={group.length}
          aria-valuenow={done}
          aria-valuetext={`${done} of ${group.length} answers saved`}
          className="h-1 overflow-hidden rounded-full bg-brand-stone"
        >
          <div className="h-full bg-brand-maroon" style={{ width: `${(done / group.length) * 100}%` }} />
        </div>
      </div>

      <h2 id="story-question" className="text-[32px] leading-tight sm:text-[40px]">
        {p.prompt}
      </h2>
      <EarlierWording prompt={p} />
      <AutosaveDraft key={saves} promptKey={p.key} saved={saved.text} text={text} setText={setText} active={!mutation.isPending}>
        {(autosave) => (
          <form
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
            className="grid min-w-0 grid-cols-1 gap-5"
          >
            <FormError error={mutation.error} />
            <div className="relative">
              <HelpMeWrite
                targetKey={p.key}
                question={p.prompt}
                field="Your answer"
                save="Save answer"
                read={() => latest.current}
                write={setText}
                className="absolute top-0 right-0"
              />
              <TextAreaField
                id="story-answer"
                label="Your answer"
                placeholder="Your memories, in your own words."
                className="min-h-72 bg-brand-ivory/40 text-[17px] leading-relaxed"
                maxLength={ANSWER_MAX['my-story']}
                length={text.length}
                error={errors.textContent}
                // Read-only while saving, so nothing typed meanwhile is overwritten by the reply.
                readOnly={mutation.isPending}
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
            </div>
            <StoryAttachments prompt={p} onUploading={onUploading} />
            <details open={!!saved.note} className="group rounded-xl border border-brand-stone">
              <summary className={summary}>Private note</summary>
              <div className="px-4 pb-4">
                {/* Saved with Save answer; never autosaved, shared or put in the book. */}
                <PrivateNoteField
                  id="story-note"
                  placeholder="Anything you’d like to remember about this answer?"
                  length={note.length}
                  error={errors.privateNote}
                  readOnly={mutation.isPending}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              </div>
            </details>
            <details className="group rounded-xl border border-brand-stone">
              <summary className={summary}>Sharing settings</summary>
              <div className="grid gap-3 px-4 pb-4 text-[15px] text-foreground-secondary">
                <p>{EXTRAS['my-story'].shareText}</p>
                {p.answered ? (
                  <Button asChild variant="outline" className="w-fit">
                    <Link
                      href={`/my-story/${encodeURIComponent(p.key)}/create-message`}
                      onClick={guardLink(`/my-story/${encodeURIComponent(p.key)}/create-message`)}
                    >
                      <Send aria-hidden strokeWidth={1.5} />
                      {EXTRAS['my-story'].cta}
                    </Link>
                  </Button>
                ) : (
                  <p className="text-sm text-foreground-muted">You can create a message once this answer is saved.</p>
                )}
              </div>
            </details>
            <p role="status" className="text-sm text-foreground-muted empty:hidden">
              {status && !dirty ? status : ''}
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" size="lg" disabled={!dirty || mutation.isPending} className={maroon}>
                {mutation.isPending && <Spinner />}
                Save answer
              </Button>
              <Button type="button" size="lg" variant="outline" disabled={!onNext || mutation.isPending} onClick={onNext}>
                Next question
                <ChevronRight aria-hidden />
              </Button>
              {autosave}
            </div>
            <div className="border-t border-brand-stone pt-4 text-sm">
              <Button type="button" variant="ghost" size="sm" disabled={!onPrev || mutation.isPending} onClick={onPrev}>
                <ChevronLeft aria-hidden />
                Previous question
              </Button>
            </div>
          </form>
        )}
      </AutosaveDraft>
    </section>
  );
}

const summary =
  'flex cursor-pointer list-none items-center justify-between gap-3 rounded-xl px-4 py-3 font-semibold outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring after:text-brand-bronze after:content-["+"] group-open:after:content-["−"] [&::-webkit-details-marker]:hidden';

const ACCEPT = Object.values(MIME_TYPES).flat().join(',');
// The kind follows the file's type; audio/webm and video/webm stay distinct.
const kindOf = (file: File) =>
  (Object.keys(MIME_TYPES) as MediaKind[]).find((k) => MIME_TYPES[k].includes(file.type.split(';')[0].trim().toLowerCase()));

/**
 * "Add to this memory": the answer's photos, recordings and videos (the same
 * useUpload pipeline and tiles as the full answer page: server-side checks,
 * scan, quota, signed previews) and its linked memories. Both are kept as
 * soon as they are added, separately from Save answer. The upload belongs to
 * this question's scope: leaving the question aborts it (the hook's cleanup).
 */
function StoryAttachments({ prompt: p, onUploading }: { prompt: Prompt; onUploading: (busy: boolean) => void }) {
  const scope = useMemo(() => ({ kind: 'my-story' as const, id: p.key }), [p.key]);
  const list = useMediaList(scope);
  const { state, upload, cancel, reset } = useUpload(scope);
  const input = useRef<HTMLInputElement>(null);
  const [last, setLast] = useState<File | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const busy = state.phase === 'uploading' || state.phase === 'confirming';
  useEffect(() => onUploading(busy), [busy, onUploading]);
  useEffect(() => () => onUploading(false), [onUploading]);

  const start = async (file: File) => {
    setLast(file);
    setRefused(null);
    const kind = kindOf(file);
    if (!kind) {
      setRefused('Please choose a JPEG, PNG or WebP photo, an MP3, M4A, WebM or WAV recording, or an MP4 or WebM video.');
      return;
    }
    if (await upload(kind, file)) toast.success(`${KIND_LABEL[kind]} added`);
  };
  const items = list.data ?? [];
  const failed = refused ?? (state.phase === 'failed' ? state.message : null);

  return (
    <section aria-labelledby="add-to-memory" className="@container grid min-w-0 grid-cols-1 gap-4 rounded-xl border border-brand-stone bg-brand-ivory/50 p-4 sm:p-5">
      <div className="grid gap-1">
        <h3 id="add-to-memory" className="text-xl">
          Add to this memory
        </h3>
        <p className="text-sm text-foreground-muted">Add a photo, video or audio recording.</p>
      </div>
      <input
        ref={input}
        type="file"
        accept={ACCEPT}
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void start(file);
        }}
      />
      {busy ? (
        <UploadProgress state={state} onCancel={cancel} />
      ) : (
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
          <Button type="button" variant="outline" className="border-brand-maroon text-brand-maroon" onClick={() => input.current?.click()}>
            <ImagePlus aria-hidden strokeWidth={1.5} />
            Add media
          </Button>
          <MemoryPicker prompt={p} />
        </div>
      )}
      {failed && (
        <UploadFailed
          message={failed}
          onRetry={last && !refused ? () => void start(last) : undefined}
          onDismiss={() => {
            setRefused(null);
            reset();
          }}
        />
      )}
      {list.error ? (
        <p role="alert" className="text-sm text-danger">
          {list.error.message}{' '}
          <button type="button" className="underline" onClick={() => void list.refetch()}>
            Try again
          </button>
        </p>
      ) : (
        items.length > 0 && (
          <ul aria-label="Photos, recordings and videos" className="grid grid-cols-1 gap-3 @md:grid-cols-2 @2xl:grid-cols-3">
            {items.map((asset) => (
              <li key={asset.id} className="min-w-0">
                <MediaTile scope={scope} asset={asset} editable />
              </li>
            ))}
          </ul>
        )
      )}
      <LinkedMemoriesInline prompt={p} />
      <p className="text-xs text-foreground-muted">
        Files and linked memories are kept as soon as they’re added; Save answer keeps your words and private note. Only
        you can see them.
      </p>
    </section>
  );
}

function LinkedMemoriesInline({ prompt: p }: { prompt: Prompt }) {
  const save = useAnswerMutation('my-story', p.key);
  return (
    <>
      <FormError error={save.error} />
      <LinkedMemories prompt={p} save={save} />
    </>
  );
}

/**
 * The existing memory search in a dialog. Choices are staged: Cancel changes
 * nothing; the confirm button sends one replace-the-set request (originals untouched).
 */
function MemoryPicker({ prompt: p }: { prompt: Prompt }) {
  const save = useAnswerMutation('my-story', p.key);
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<{ id: string; title: string }[]>([]);
  const linked = (p.response?.memories ?? []).map((m) => m.id);
  const setOpenState = (next: boolean) => {
    if (save.isPending) return;
    setOpen(next);
    if (!next) {
      setChosen([]);
      save.reset();
    }
  };
  return (
    <Dialog open={open} onOpenChange={setOpenState}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline">
          <BookOpen aria-hidden strokeWidth={1.5} />
          Choose from Memory Vault
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-2rem)] gap-5 overflow-y-auto rounded-xl bg-surface p-6 sm:max-w-lg">
        <DialogHeader className="gap-2">
          <DialogTitle className="text-[28px] leading-tight font-normal">Choose from Memory Vault</DialogTitle>
          <DialogDescription className="text-[15px] text-foreground-muted">
            Link your own memories to this answer. Nothing is copied or shared, and unlinking never deletes the memory.
          </DialogDescription>
        </DialogHeader>
        <MemorySearch exclude={[...linked, ...chosen.map((c) => c.id)]} label="Choose" onLink={(m) => setChosen((c) => [...c, m])} />
        {chosen.length > 0 && (
          <ul aria-label="Chosen memories" className="flex flex-wrap gap-2">
            {chosen.map((m) => (
              <li key={m.id} className="inline-flex max-w-full items-center gap-1 rounded-full bg-brand-ivory py-1 pr-1 pl-3 text-sm">
                <span className="min-w-0 truncate">{m.title}</span>
                <button
                  type="button"
                  aria-label={`Don’t link ${m.title}`}
                  onClick={() => setChosen((c) => c.filter((x) => x.id !== m.id))}
                  className="inline-flex size-6 shrink-0 items-center justify-center rounded-full outline-none hover:bg-border focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring"
                >
                  <X aria-hidden className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <FormError error={save.error} />
        <DialogFooter className="mx-0 mb-0 flex-col-reverse gap-3 border-0 bg-transparent p-0 sm:flex-row">
          <Button type="button" variant="outline" disabled={save.isPending} onClick={() => setOpenState(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            className={maroon}
            disabled={chosen.length === 0 || save.isPending}
            onClick={() =>
              save.mutate(
                { memoryVaultItemIds: [...linked, ...chosen.map((c) => c.id)] },
                {
                  onSuccess: () => {
                    toast.success(chosen.length === 1 ? 'Memory linked' : 'Memories linked');
                    setOpen(false);
                    setChosen([]);
                  },
                },
              )
            }
          >
            {save.isPending && <Spinner />}
            {chosen.length === 1 ? 'Link 1 memory' : chosen.length ? `Link ${chosen.length} memories` : 'Link memories'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The existing server-side autosave + recovery (same as the full answer page). */
function AutosaveDraft({
  promptKey,
  saved,
  text,
  setText,
  active,
  children,
}: {
  promptKey: string;
  saved: string;
  text: string;
  setText: (v: string) => void;
  active: boolean;
  children: (autosave: ReactNode) => ReactNode;
}) {
  const editor = useDraftEditor({
    type: 'MY_STORY',
    draftKey: promptKey,
    baseRevision: textRevision(saved),
    saved: { textContent: saved },
    current: { textContent: text },
    active,
  });
  return (
    <>
      <RecoveryNotice editor={editor} describe={(d) => ({ text: d.textContent })} onRestore={(v) => setText(v.textContent)} />
      {children(<AutosaveStatus editor={editor} />)}
    </>
  );
}

/**
 * Chapter drafts need AI generation, which is not built (no backend endpoint
 * or provider; AI is deferred post-MVP). Honest about it; nothing is sent.
 */
function BringTogether() {
  const [asked, setAsked] = useState(false);
  return (
    <section aria-labelledby="bring-together" className={cn(card, 'grid gap-3 bg-brand-ivory p-5 lg:col-start-2 lg:row-start-2 lg:p-6')}>
      <h2 id="bring-together" className="text-2xl">
        Bring your memories together
      </h2>
      <p className="text-[15px] text-foreground-secondary">Turn your answers into a chapter draft, with the help of AI.</p>
      <div>
        <Button type="button" variant="outline" className="border-brand-maroon text-brand-maroon" onClick={() => setAsked(true)}>
          Create chapter draft
        </Button>
      </div>
      <p role="status" className="text-sm text-foreground-muted empty:hidden">
        {asked
          ? 'Chapter drafts aren’t available yet. Nothing was sent anywhere. Your saved answers already come together, chapter by chapter, in your book.'
          : ''}
      </p>
    </section>
  );
}

/** The book's chapters (GET /my-story/book): read-only, with a way into each. */
function ChaptersTab({ guardLink }: { guardLink: (href: string) => (e: MouseEvent) => void }) {
  const book = useStoryBook();
  return (
    <QueryView query={book} loadingLabel="Loading your chapters">
      {(data) => {
        const chapters = chaptersOf(data);
        if (chapters.length === 0) {
          return (
            <EmptyState
              icon={BookOpen}
              title="No chapters yet"
              description="Your chapters appear here once you save your first answer."
            />
          );
        }
        return (
          <ol className="grid gap-4 md:grid-cols-2">
            {chapters.map((c, i) => {
              const href = `/my-story/book?chapter=${encodeURIComponent(c.key)}`;
              return (
                <li key={c.key} className={cn(card, 'grid gap-2 p-6')}>
                  <p className="eyebrow text-brand-bronze">Chapter {i + 1}</p>
                  <h2 className="text-2xl">{c.title}</h2>
                  <p className="text-sm text-foreground-muted">
                    {c.entries.length} saved {c.entries.length === 1 ? 'answer' : 'answers'}
                  </p>
                  <Link
                    href={href}
                    onClick={guardLink(href)}
                    className="w-fit rounded-sm font-semibold text-brand-maroon underline-offset-4 outline-none hover:underline focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring"
                  >
                    Read {c.title}
                  </Link>
                </li>
              );
            })}
          </ol>
        );
      }}
    </QueryView>
  );
}

/** Before leaving unsaved text: save, discard, or stay. A failed save stays put. */
function UnsavedDialog({
  pending,
  unsaved,
  uploading,
  onClose,
  save,
}: {
  pending: (() => void) | null;
  unsaved: boolean;
  uploading: boolean;
  onClose: () => void;
  save: () => Promise<boolean>;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const focus = useReturnFocus();
  const finish = (move: () => void) => {
    setFailed(false);
    onClose();
    move();
  };
  return (
    <Dialog
      open={!!pending}
      onOpenChange={(open) => {
        if (open || busy) return;
        setFailed(false);
        onClose();
      }}
    >
      <DialogContent className="gap-6 rounded-xl bg-surface p-7 sm:max-w-md" showCloseButton={false} {...focus}>
        <DialogHeader className="gap-3">
          <DialogTitle className="text-[28px] leading-tight font-normal">
            {unsaved ? 'You have unsaved changes' : 'An upload is still in progress'}
          </DialogTitle>
          <DialogDescription className="text-[15px] text-foreground-muted">
            {unsaved && 'Save your answer and private note before you go, or discard the changes. '}
            {uploading && 'Leaving now cancels the upload in progress; files already added are kept.'}
          </DialogDescription>
        </DialogHeader>
        {failed && (
          <p role="alert" className="rounded-md bg-danger/8 px-4 py-3 text-sm text-danger">
            We couldn’t save your answer. Your text is still in the editor.
          </p>
        )}
        <DialogFooter className="mx-0 mb-0 flex-col-reverse gap-3 border-0 bg-transparent p-0 sm:flex-row">
          <Button variant="ghost" disabled={busy} onClick={() => finish(() => {})}>
            Stay here
          </Button>
          <Button variant="outline" disabled={busy} onClick={() => finish(pending!)}>
            {unsaved ? 'Discard changes' : 'Cancel upload and continue'}
          </Button>
          {unsaved && (
          <Button
            disabled={busy}
            className={maroon}
            onClick={async () => {
              setBusy(true);
              const ok = await save();
              setBusy(false);
              if (ok) finish(pending!);
              else setFailed(true);
            }}
          >
            {busy && <Spinner />}
            Save and continue
          </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
