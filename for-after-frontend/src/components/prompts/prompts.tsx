'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { BookOpen, Feather, Info, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { FilterChips, FormError, TextAreaField } from '@/components/shared/form-field';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyState, QueryView, Spinner } from '@/components/shared/states';
import { Button } from '@/components/ui/button';
import { useUnsavedChanges } from '@/hooks/use-unsaved-changes';
import { useAnswerMutation, usePrompt, usePrompts } from '@/hooks/use-vault';
import { ANSWER_MAX, type Prompt, type PromptArea } from '@/lib/api/prompts';
import { formatDate, humanize } from '@/lib/format';
import { answerSchema, type AnswerValues } from '@/schemas/vault';

// Exact project wording (for-after-backend/docs/my-wishes.md). Do not reword
// without product/legal review.
export const MY_WISHES_DISCLAIMER =
  'My Wishes records personal preferences and guidance only. It is not a will, legal document, medical directive, financial instruction or substitute for professional advice.';

const AREAS: Record<
  PromptArea,
  { label: string; title: ReactNode; description: string; icon: typeof BookOpen; disclaimer?: string }
> = {
  'my-story': {
    label: 'My Story',
    title: <>My <em>Story</em></>,
    description: 'Your life in your own words. Answer the prompts in any order, and come back whenever you like.',
    icon: BookOpen,
  },
  'my-wishes': {
    label: 'My Wishes',
    title: <>My <em>Wishes</em></>,
    description: 'How you would like to be remembered, as guidance for the people you love.',
    icon: Feather,
    disclaimer: MY_WISHES_DISCLAIMER,
  },
};

export function Disclaimer({ text }: { text: string }) {
  return (
    <aside aria-label="Important" className="mb-10 flex gap-4 rounded-xl bg-primary-soft p-6">
      <Info aria-hidden strokeWidth={1.5} className="mt-0.5 size-5 shrink-0 text-primary" />
      <p className="text-[15px] leading-relaxed font-medium text-foreground-secondary">{text}</p>
    </aside>
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
      {config.disclaimer && <Disclaimer text={config.disclaimer} />}
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
              <p className="mb-6 text-sm text-foreground-muted" aria-live="polite">
                {answered} of {prompts.length} answered
              </p>
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
    </>
  );
}

function PromptCard({ area, prompt: p }: { area: PromptArea; prompt: Prompt }) {
  return (
    <Link
      href={`/${area}/${encodeURIComponent(p.key)}`}
      className="flex h-full flex-col gap-4 rounded-lg border border-border bg-surface p-6 outline-none transition-colors hover:border-border-strong focus-visible:outline-2 focus-visible:outline-ring sm:p-7"
    >
      <span className="eyebrow">{humanize(p.category)}</span>
      <span className="font-heading text-[26px] leading-snug">{p.prompt}</span>
      {p.response ? (
        <>
          <span className="line-clamp-3 text-[15px] leading-relaxed text-foreground-secondary">
            {p.response.textContent}
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
          {config.disclaimer && <Disclaimer text={config.disclaimer} />}
          <AnswerForm area={area} prompt={p} />
        </>
      )}
    </QueryView>
  );
}

function AnswerForm({ area, prompt: p }: { area: PromptArea; prompt: Prompt }) {
  const router = useRouter();
  const mutation = useAnswerMutation(area, p.key);
  const form = useForm<AnswerValues>({
    resolver: zodResolver(answerSchema),
    defaultValues: { textContent: p.response?.textContent ?? '' },
  });
  const { errors, isDirty, isSubmitSuccessful } = form.formState;
  const answer = useWatch({ control: form.control, name: 'textContent' });
  useUnsavedChanges(isDirty && !isSubmitSuccessful);
  const back = () => router.push(`/${area}`);

  return (
    <form
      noValidate
      onSubmit={form.handleSubmit(
        (v) =>
          !mutation.isPending &&
          // Sent exactly as written: answers are not trimmed.
          mutation.mutate(v, {
            onSuccess: () => {
              toast.success('Your answer is saved');
              back();
            },
          }),
      )}
      className="grid max-w-3xl gap-6 rounded-xl border border-border bg-surface p-6 sm:p-10"
    >
      <FormError error={mutation.error} />
      <fieldset disabled={mutation.isPending}>
        <TextAreaField
          id="answer"
          label="Your answer"
          hint={p.response ? `Last saved ${formatDate(p.response.updatedAt)}.` : 'Write as much or as little as you like.'}
          className="min-h-72"
          maxLength={ANSWER_MAX}
          length={answer.length}
          error={errors.textContent?.message}
          {...form.register('textContent')}
        />
      </fieldset>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="lg" disabled={mutation.isPending}>
          {mutation.isPending && <Spinner />}
          Save answer
        </Button>
        {p.answered && (
          <ConfirmDialog
            trigger={
              <Button type="button" variant="ghost">
                <Trash2 aria-hidden strokeWidth={1.5} />
                Delete answer
              </Button>
            }
            title="Delete this answer?"
            description="Your answer to this prompt will be removed. You can write a new one at any time."
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
        )}
      </div>
    </form>
  );
}
