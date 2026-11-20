'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { BookOpen, Feather, Info, PenLine, Send, Trash2, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useDeferredValue, useState, type ReactNode } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { toast } from 'sonner';
import { MediaManager } from '@/components/media/media-manager';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { AutosaveStatus, KeptDraft, RecoveryNotice } from '@/components/shared/draft-recovery';
import { HelpMeWrite } from '@/components/companion/companion';
import { FilterChips, FormError, TextAreaField } from '@/components/shared/form-field';
import { PageHeader } from '@/components/shared/page-header';
import { PrivateNoteField } from '@/components/shared/private-note';
import { PlanLockedButton, usePlanLock } from '@/components/shared/plan-lock';
import {
  ProBadge,
  ProDialog,
  PaidMemoryLinkButton,
  QuestionGateNotice,
  TRIAL_QUESTIONS_COPY,
  TrialQuestions,
  usePaidMemoryLinks,
  useQuestionGate,
  useTrialQuestions,
} from '@/components/shared/trial-cap';
import { EmptyState, QueryView, Spinner } from '@/components/shared/states';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useDraftEditor } from '@/hooks/use-draft-editor';
import { useUnsavedChanges } from '@/hooks/use-unsaved-changes';
import {
  memories,
  useAnswerMutation,
  usePrompt,
  usePrompts,
  useUnlinkMemory,
  useWishesNotice,
} from '@/hooks/use-vault';
import { textRevision } from '@/lib/api/drafts';
import { ANSWER_MAX, type Prompt, type PromptArea } from '@/lib/api/prompts';
import { formatDate, humanize } from '@/lib/format';
import { cn } from '@/lib/utils';
import { WishSongs } from '@/components/prompts/wish-songs';
import { answerSchema, type AnswerValues } from '@/schemas/vault';

const AREAS: Record<
  PromptArea,
  { label: string; title: ReactNode; description: ReactNode; icon: typeof BookOpen; notice?: boolean }
> = {
  'my-story': {
    label: 'My Story',
    title: <>My <em>Story</em></>,
    // The /my-story page itself is StoryWorkspace; this config serves the full answer page.
    description: 'Follow thoughtful prompts to capture your memories, experiences and the moments that shaped you.',
    icon: BookOpen,
  },
  'my-wishes': {
    label: 'My Wishes',
    title: <>My <em>Wishes</em></>,
    // Approved copy (2026-11-10), word for word.
    description: (
      <div className="grid gap-3">
        <p className="font-heading text-2xl leading-snug tracking-tight text-foreground sm:text-[28px]">
          Your farewell, your way.
        </p>
        <div className="grid gap-3 text-base leading-relaxed text-foreground-muted sm:text-lg">
          <p>
            Share how you’d like to be farewelled and remembered - from burial or cremation to a ceremony, gathering or
            quiet goodbye, with the traditions and personal touches that matter to you.
          </p>
          <p>
            Gentle prompts guide you at your own pace, giving your loved ones clarity and comfort in knowing your wishes.
          </p>
        </div>
      </div>
    ),
    icon: Feather,
    // Phase 15A: the notice comes from the API (WishesNotice), never a copy here.
    notice: true,
  },
};

/**
 * Phase 15A: the My Wishes notice exactly as the API serves it. Informational
 * only (2026-10-14): it never gates reading or writing wishes, and loads
 * alongside them. If it cannot load, a retry is shown and no stale wording is
 * guessed.
 */
function WishesNotice() {
  const notice = useWishesNotice();
  if (notice.isPending) {
    return (
      <p className="mb-10 flex items-center gap-2 text-sm text-foreground-muted" role="status">
        <Spinner /> Loading the My Wishes notice
      </p>
    );
  }
  if (notice.isError) {
    return (
      <div role="alert" className="mb-10 flex flex-wrap items-center gap-3 rounded-xl bg-danger/8 p-6 text-[15px] text-danger">
        We couldn’t load the My Wishes notice.
        <Button type="button" size="sm" variant="outline" onClick={() => void notice.refetch()}>
          Try again
        </Button>
      </div>
    );
  }
  return (
    <aside aria-label="Important" className="mb-10 flex gap-4 rounded-xl bg-primary-soft p-6">
      <Info aria-hidden strokeWidth={1.5} className="mt-0.5 size-5 shrink-0 text-primary" />
      <p className="text-[15px] leading-relaxed font-medium text-foreground-secondary">{notice.data.text}</p>
    </aside>
  );
}

/** Same count as before, plus a thin bar; the text is what screen readers get. */
export function StoryProgress({ answered, total, className = 'mb-5' }: { answered: number; total: number; className?: string }) {
  const pct = total ? Math.round((answered / total) * 100) : 0;
  return (
    <div className={cn('flex items-center gap-4 text-sm text-foreground-muted', className)}>
      <p aria-live="polite" className="shrink-0">
        {answered} of {total} answered
      </p>
      <div aria-hidden className="h-px flex-1 bg-brand-lilac-grey">
        <div className="-mt-px h-[3px] bg-primary" style={{ width: `${pct}%` }} />
      </div>
      <span aria-hidden className="w-10 shrink-0 text-right tabular-nums">
        {pct}%
      </span>
    </div>
  );
}

/** Categories in catalogue order, taken from the API response itself. */
const categoriesOf = (prompts: Prompt[]) => [...new Set(prompts.map((p) => p.category))];

export function PromptList({ area, category }: { area: PromptArea; category?: string }) {
  const config = AREAS[area];
  const list = usePrompts(area);
  return (
    <>
      <PageHeader eyebrow="Preserve" title={config.title} description={config.description} />
      {config.notice && <WishesNotice />}
      <QueryView query={list} loadingLabel={`Loading ${config.label}`}>
        {(prompts) => {
          const categories = categoriesOf(prompts);
          const active = category && categories.includes(category) ? category : undefined;
          const shown = active ? prompts.filter((p) => p.category === active) : prompts;
          const answered = prompts.filter((p) => p.answered).length;
          if (prompts.length === 0) {
            return <EmptyState icon={config.icon} title="No prompts yet" description="Prompts will appear here." />;
          }
          return (
            <>
              <p className="mb-2 text-sm text-foreground-muted" aria-live="polite">
                {answered} of {prompts.length} answered
              </p>
              <div className="mb-6">
                <TrialQuestions />
              </div>
              <FilterChips
                label="Filter by category"
                chips={[
                  { label: 'All', href: `/${area}`, active: !active },
                  ...categories.map((c) => ({ label: humanize(c), href: `/${area}?category=${c}`, active: active === c })),
                ]}
              />
              <ul className="grid gap-4 md:grid-cols-2">
                {shown.map((p) => (
                  <li key={p.key}>
                    <PromptCard area={area} prompt={p} />
                  </li>
                ))}
              </ul>
            </>
          );
        }}
      </QueryView>
      {/* Funeral songs belong with the music wishes: shown on All and that filter. */}
      {area === 'my-wishes' && (!category || category === 'MUSIC_AND_READINGS') && <WishSongs />}
    </>
  );
}

const cardClass =
  'flex h-full flex-col gap-4 rounded-lg border border-border bg-surface p-6 outline-none transition-colors hover:border-border-strong focus-visible:outline-2 focus-visible:outline-ring sm:p-7';

function PromptCard({ area, prompt: p }: { area: PromptArea; prompt: Prompt }) {
  const { full } = useTrialQuestions();
  // Trial Step 5: every slot used and nothing saved here: the card explains the plan. A files-only answer still opens.
  if (full && !p.response) {
    return (
      <ProDialog
        trigger={
          <button type="button" className={cn(cardClass, 'w-full text-left')}>
            <span className="eyebrow">{humanize(p.category)}</span>
            <span className="font-heading text-[26px] leading-snug">{p.prompt}</span>
            <span className="mt-auto flex items-center gap-2 text-sm">
              <span className="font-semibold text-primary">Write your answer</span>
              <ProBadge />
            </span>
          </button>
        }
        {...TRIAL_QUESTIONS_COPY}
      />
    );
  }
  return (
    <Link href={`/${area}/${encodeURIComponent(p.key)}`} className={cardClass}>
      <span className="eyebrow">{humanize(p.category)}</span>
      <span className="font-heading text-[26px] leading-snug">{p.prompt}</span>
      {p.response ? (
        <>
          <span className="line-clamp-3 text-[15px] leading-relaxed text-foreground-secondary">
            {p.response.textContent || extrasSummary(p.response)}
          </span>
          <span className="mt-auto text-sm">
            <span className="font-semibold text-primary">Continue writing</span>
            <span className="text-foreground-muted"> · Updated {formatDate(p.response.updatedAt)}</span>
          </span>
        </>
      ) : (
        <span className="mt-auto text-sm">
          <span className="font-semibold text-primary">Write your answer</span>
          <span className="text-foreground-muted"> · Not answered yet</span>
        </span>
      )}
    </Link>
  );
}

export function PromptEditor({ area, promptKey }: { area: PromptArea; promptKey: string }) {
  const config = AREAS[area];
  const item = usePrompt(area, promptKey);
  return (
    <QueryView
      query={item}
      notFound={{ title: 'We couldn’t find this prompt', backHref: `/${area}`, backLabel: `Back to ${config.label}` }}
    >
      {(p) => (
        <>
          <PageHeader back={{ href: `/${area}`, label: config.label }} eyebrow={humanize(p.category)} title={p.prompt} />
          {config.notice && <WishesNotice />}
          <EarlierWording prompt={p} />
          <TrialQuestions quiet className="mb-4 text-sm text-foreground-muted" />
          <AnswerForm area={area} prompt={p} />
          <AnswerExtras area={area} prompt={p} />
        </>
      )}
    </QueryView>
  );
}

/**
 * My Story keeps the wording an answer was written for (Phase 14A). When the
 * question has been reworded since, say so, so the answer keeps its context.
 */
export function EarlierWording({ prompt: p }: { prompt: Prompt }) {
  const answered = p.response?.promptTextSnapshot;
  if (!answered || answered === p.prompt) return null;
  return (
    <p className="mb-6 max-w-3xl rounded-lg border border-border bg-surface-muted px-5 py-4 text-[15px] text-foreground-secondary">
      You answered an earlier wording of this question: <q>{answered}</q>
    </p>
  );
}

function AnswerForm({ area, prompt: p }: { area: PromptArea; prompt: Prompt }) {
  const router = useRouter();
  const mutation = useAnswerMutation(area, p.key);
  const form = useForm<AnswerValues>({
    resolver: zodResolver(answerSchema(area)),
    defaultValues: { textContent: p.response?.textContent ?? '', privateNote: p.response?.privateNote ?? '' },
  });
  const { errors, isDirty, isSubmitSuccessful } = form.formState;
  const answer = useWatch({ control: form.control, name: 'textContent' });
  const note = useWatch({ control: form.control, name: 'privateNote' });
  useUnsavedChanges(isDirty && !isSubmitSuccessful);
  // Trial Step 5: a new answer opens once the plan is known and a slot is free (never closes while typing).
  const gate = useQuestionGate(p.response?.textContent, isDirty);
  const back = () => router.push(`/${area}`);
  // Unsaved text is autosaved server-side; it becomes the answer only on Save.
  const saved = p.response?.textContent ?? '';
  const editor = useDraftEditor({
    type: area === 'my-story' ? 'MY_STORY' : 'MY_WISHES',
    draftKey: p.key,
    baseRevision: textRevision(saved),
    saved: { textContent: saved },
    current: { textContent: answer },
    active: !mutation.isPending && !isSubmitSuccessful && gate === 'open',
    submitted: isSubmitSuccessful && mutation.isSuccess,
  });

  // Step 6: no write access. A saved answer stays readable (and deletable); editing opens the plan dialog.
  const readOnly = gate === 'readonly';
  const deleteAnswer = p.answered && (
    <ConfirmDialog
      trigger={
        <Button type="button" variant="ghost">
          <Trash2 aria-hidden strokeWidth={1.5} />
          Delete answer
        </Button>
      }
      title="Delete this answer?"
      description={
        area === 'my-story'
          ? 'Your answer to this prompt will be removed, with its photos, recordings and videos and its links to memories. You can write a new one at any time.'
          : 'Your wish will be removed, with its photos, recordings and videos. Messages you already created from it are separate and stay as they are.'
      }
      confirmLabel="Delete answer"
      pending={mutation.isPending}
      error={mutation.error}
      onConfirm={() =>
        mutation.mutateAsync(null).then(() => {
          toast.success('Answer deleted');
          back();
        })
      }
    />
  );
  // Step 7 close-out: read-only, a copy kept in this tab can be viewed or discarded (never restored or saved here).
  const kept = <KeptDraft type={area === 'my-story' ? 'MY_STORY' : 'MY_WISHES'} draftKey={p.key} text={(d) => String(d.textContent ?? '')} />;
  if (readOnly && !saved.trim()) {
    return (
      <>
        {kept}
        <div className="flex max-w-3xl flex-wrap items-center gap-3">
          <PlanLockedButton label="Write your answer" icon={PenLine} />
          {deleteAnswer}
        </div>
      </>
    );
  }
  if (gate !== 'open' && !readOnly) {
    return (
      <div className="max-w-3xl">
        <QuestionGateNotice gate={gate} />
      </div>
    );
  }
  return (
    <>
    {readOnly && kept}
    {!readOnly && (
      <RecoveryNotice
        editor={editor}
        describe={(d) => ({ text: d.textContent })}
        onRestore={(v) => form.setValue('textContent', v.textContent, { shouldDirty: true })}
      />
    )}
    <form
      noValidate
      onSubmit={form.handleSubmit(
        (v) =>
          !mutation.isPending &&
          // Sent exactly as written: answers are not trimmed.
          mutation.mutate({ textContent: v.textContent.trim() ? v.textContent : null, privateNote: v.privateNote.trim() || null }, {
            onSuccess: () => {
              toast.success('Your answer is saved');
              back();
            },
          }),
      )}
      className="grid max-w-3xl gap-6 rounded-xl border border-border bg-surface p-6 sm:p-10"
    >
      <FormError error={mutation.error} />
      <fieldset disabled={mutation.isPending} className="grid gap-6">
        <div className="grid gap-2">
        {/* My Story sends this key as its question id; the answer only, never the private note. */}
        {!readOnly && (
        <HelpMeWrite
          targetKey={p.key}
          question={p.prompt}
          field="Your answer"
          save="Save answer"
          read={() => form.getValues('textContent')}
          write={(v) => form.setValue('textContent', v, { shouldDirty: true, shouldValidate: form.formState.isSubmitted })}
          className="justify-self-end"
        />
        )}
        <TextAreaField
          id="answer"
          readOnly={readOnly}
          label="Your answer"
          hint={p.response ? `Last saved ${formatDate(p.response.updatedAt)}.` : 'Write as much or as little as you like.'}
          className="min-h-72"
          maxLength={ANSWER_MAX[area]}
          length={answer.length}
          error={errors.textContent?.message}
          {...form.register('textContent')}
        />
        </div>
        {/* Not part of the answer: never shared or autosaved. */}
        <PrivateNoteField
          id="privateNote"
          placeholder={
            area === 'my-story'
              ? 'Anything you’d like to remember about this answer?'
              : 'Add a reminder for yourself. This won’t be shared.'
          }
          length={note.length}
          error={errors.privateNote?.message}
          readOnly={readOnly}
          {...form.register('privateNote')}
        />
      </fieldset>
      <div className="flex flex-wrap items-center gap-3">
        {readOnly ? (
          <PlanLockedButton label="Edit answer" icon={PenLine} size="lg" />
        ) : (
          <>
            <Button type="submit" size="lg" disabled={mutation.isPending}>
              {mutation.isPending && <Spinner />}
              Save answer
            </Button>
            <AutosaveStatus editor={editor} />
          </>
        )}
        {deleteAnswer}
      </div>
    </form>
    </>
  );
}

// An answer without words (Phase 14B / 15B): say what it holds instead.
function extrasSummary(r: NonNullable<Prompt['response']>) {
  const parts = [];
  if (r.mediaCount) parts.push(`${r.mediaCount} ${r.mediaCount === 1 ? 'photo or recording' : 'photos and recordings'}`);
  if (r.memories?.length) parts.push(`${r.memories.length} linked ${r.memories.length === 1 ? 'memory' : 'memories'}`);
  return parts.join(' · ');
}

export const EXTRAS: Record<PromptArea, { add: string; share: string; shareText: string; cta: string }> = {
  'my-story': {
    add: 'Add to your story',
    share: 'Share it as a message',
    shareText:
      'Your story stays private. This creates a separate message from the content you choose, which you can then send to the people you love at the right time.',
    cta: 'Create a message',
  },
  'my-wishes': {
    add: 'Add something personal',
    share: 'Sharing',
    shareText:
      'Your wish stays private. This creates a separate message for the people you choose, which you can set to be shared after your passing. Trusted Contacts do not receive it.',
    cta: 'Create message for loved ones',
  },
};

/**
 * Photos, recordings and videos (the shared uploader and recorders) and
 * sharing as a separate message: My Story (Phase 14B, plus private links to
 * memories) and My Wishes (Phase 15B). All private: nothing here is visible to
 * anyone else.
 */
function AnswerExtras({ area, prompt: p }: { area: PromptArea; prompt: Prompt }) {
  const text = EXTRAS[area];
  return (
    <div className="mt-10 grid max-w-3xl gap-10">
      <section aria-labelledby="answer-media" className="grid gap-4">
        <div className="grid gap-1">
          <h2 id="answer-media" className="text-2xl">
            {text.add}
          </h2>
          <p className="text-sm text-foreground-muted">Photos, a recording or a video. Only you can see them.</p>
        </div>
        <MediaManager
          scope={{ kind: area, id: p.key }}
          kinds={['PHOTO', 'AUDIO', 'VIDEO']}
          title="Photos, voice and video"
          editable
        />
      </section>
      {area === 'my-story' && <MemoryLinks prompt={p} />}
      {p.answered && (
        <section aria-labelledby="answer-share" className="grid gap-3 rounded-xl border border-border bg-surface p-6 sm:p-8">
          <h2 id="answer-share" className="text-2xl">
            {text.share}
          </h2>
          <p className="text-[15px] text-foreground-secondary">{text.shareText}</p>
          <div>
            <Button asChild variant="outline">
              <Link href={`/${area}/${encodeURIComponent(p.key)}/create-message`}>
                <Send aria-hidden strokeWidth={1.5} />
                {text.cta}
              </Link>
            </Button>
          </div>
        </section>
      )}
    </div>
  );
}

/** Link and unlink the Customer's own memories (private context, never shared). */
function MemoryLinks({ prompt: p }: { prompt: Prompt }) {
  const save = useAnswerMutation('my-story', p.key);
  // Trial Step 5: no new links in the trial; unlinking (below) stays open.
  const linksLocked = usePaidMemoryLinks();
  // Step 6: no write access: linking is locked (changing links is an edit); linked memories stay listed and open.
  const planLocked = usePlanLock().locked;
  return (
    <section aria-labelledby="story-memories" className="grid gap-4">
      <div className="grid gap-1">
        <h2 id="story-memories" className="text-2xl">
          Linked memories
        </h2>
        <p className="text-sm text-foreground-muted">
          Memories from your Memory Vault that belong with this story. Links stay private and are never shared.
        </p>
      </div>
      <FormError error={save.error} />
      <LinkedMemories prompt={p} />
      {planLocked ? (
        <div>
          <PlanLockedButton label="Link a memory" icon={BookOpen} />
        </div>
      ) : linksLocked ? (
        <div>
          <PaidMemoryLinkButton label="Link a memory" />
        </div>
      ) : (
        <MemorySearch
          exclude={(p.response?.memories ?? []).map((m) => m.id)}
          disabled={save.isPending}
          onLink={({ id }) => save.mutate({ memoryVaultItemIds: [...(p.response?.memories ?? []).map((m) => m.id), id] })}
        />
      )}
    </section>
  );
}

/**
 * The answer's linked memories. Unlinking removes the link only (its own request, Step 7), so it stays available after
 * a trial ends; the memory itself, and its files, are never touched.
 */
export function LinkedMemories({ prompt: p }: { prompt: Prompt }) {
  const linked = p.response?.memories ?? [];
  const unlink = useUnlinkMemory(p.key);
  if (linked.length === 0) return null;
  return (
    <>
      <FormError error={unlink.error} />
      <ul aria-label="Linked memories" className="flex flex-wrap gap-2">
        {linked.map((m) => (
          <li key={m.id} className="inline-flex max-w-full items-center gap-1 rounded-full bg-surface-muted py-1 pr-1 pl-3 text-sm">
            <Link href={`/memory-vault/${m.id}`} className="min-w-0 truncate hover:underline">
              {m.title}
            </Link>
            <span className="shrink-0 text-foreground-muted">· {humanize(m.category)}</span>
            <button
              type="button"
              aria-label={`Unlink ${m.title}`}
              disabled={unlink.isPending}
              onClick={() => unlink.mutate(m.id)}
              className="inline-flex size-6 shrink-0 items-center justify-center rounded-full outline-none hover:bg-border focus-visible:outline-2 focus-visible:outline-ring"
            >
              <X aria-hidden className="size-3.5" />
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * Search the Customer's own memories (the API scopes the list to them) and
 * pick one; `exclude` keeps linked or already chosen ones out (no duplicates).
 */
export function MemorySearch({
  exclude,
  disabled,
  onLink,
  label = 'Link',
}: {
  exclude: string[];
  disabled?: boolean;
  onLink: (memory: { id: string; title: string; category: string }) => void;
  label?: string;
}) {
  const [search, setSearch] = useState('');
  const term = useDeferredValue(search.trim());
  const found = memories.useList({ search: term || undefined });
  const candidates = (found.data?.items ?? []).filter((m) => !exclude.includes(m.id)).slice(0, 5);
  return (
    <>
      <div className="grid gap-2">
        <Label htmlFor="memory-search">Find a memory to link</Label>
        <Input
          id="memory-search"
          type="search"
          value={search}
          maxLength={200}
          placeholder="Search your memories…"
          onChange={(e) => setSearch(e.target.value)}
          className="h-11"
        />
      </div>
      {candidates.length > 0 && (
        <ul aria-label="Memories you can link" className="grid gap-2">
          {candidates.map((m) => (
            <li key={m.id} className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface px-4 py-3">
              <span className="min-w-0">
                <span className="block truncate font-medium">{m.title}</span>
                <span className="text-sm text-foreground-muted">{humanize(m.category)}</span>
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={disabled}
                onClick={() => onLink(m)}
              >
                {label}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
