'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { Images, Pencil, Plus, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useForm, useWatch } from 'react-hook-form';
import { toast } from 'sonner';
import { MediaManager } from '@/components/media/media-manager';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { ChoiceGroup, FilterChips, FormError, TextAreaField, TextField } from '@/components/shared/form-field';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyState, QueryView, Spinner } from '@/components/shared/states';
import { Button } from '@/components/ui/button';
import { useUnsavedChanges } from '@/hooks/use-unsaved-changes';
import { memories } from '@/hooks/use-vault';
import type { ApiError } from '@/lib/api/errors';
import { MEMORY_CATEGORIES, type Memory, type MemoryCategory, type MemoryInput } from '@/lib/api/memory-vault';
import { TEXT_CONTENT_MAX } from '@/lib/api/messages';
import { formatDate, humanize } from '@/lib/format';
import { memorySchema, type MemoryValues } from '@/schemas/vault';

const newButton = (
  <Button asChild>
    <Link href="/memory-vault/new">
      <Plus aria-hidden strokeWidth={1.5} />
      Save a memory
    </Link>
  </Button>
);

export function MemoryList({ category }: { category?: MemoryCategory }) {
  const list = memories.useList(category);
  const chips = [
    { label: 'All', href: '/memory-vault', active: !category },
    ...MEMORY_CATEGORIES.map((c) => ({ label: humanize(c), href: `/memory-vault?category=${c}`, active: category === c })),
  ];
  return (
    <>
      <PageHeader
        eyebrow="Preserve"
        title={<>Memory <em>Vault</em></>}
        description="Moments, stories and recipes worth keeping, in one private place."
        action={newButton}
      />
      <FilterChips label="Filter by category" chips={chips} />
      <QueryView query={list} loadingLabel="Loading your memories">
        {(items) =>
          items.length === 0 ? (
            <EmptyState
              icon={Images}
              title={category ? `Nothing in ${humanize(category)} yet` : 'Your Memory Vault is ready when you are'}
              description="Write down a story, a recipe or a moment, and add photos or a recording if you like."
              action={newButton}
            />
          ) : (
            <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {items.map((m) => (
                <li key={m.id}>
                  <Link
                    href={`/memory-vault/${m.id}`}
                    className="flex h-full flex-col gap-3 rounded-lg border border-border bg-surface p-6 outline-none transition-colors hover:border-border-strong focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    <span className="eyebrow">{humanize(m.category)}</span>
                    <span className="font-heading text-[26px] leading-tight break-words">{m.title}</span>
                    {m.textContent && (
                      <span className="line-clamp-4 text-[15px] leading-relaxed text-foreground-secondary">{m.textContent}</span>
                    )}
                    <span className="mt-auto pt-2 text-sm text-foreground-muted">{formatDate(m.createdAt)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )
        }
      </QueryView>
    </>
  );
}

const NOT_FOUND = { title: 'We couldn’t find this memory', backHref: '/memory-vault', backLabel: 'Back to Memory Vault' };

export function MemoryDetail({ id }: { id: string }) {
  const router = useRouter();
  const item = memories.useItem(id);
  const remove = memories.useRemove(id);
  return (
    <QueryView query={item} notFound={NOT_FOUND}>
      {(m) => (
        <>
          <PageHeader
            back={{ href: '/memory-vault', label: 'Memory Vault' }}
            eyebrow={humanize(m.category)}
            title={m.title}
            description={`Saved ${formatDate(m.createdAt)}`}
            action={
              <div className="flex flex-wrap gap-3">
                <Button asChild variant="outline">
                  <Link href={`/memory-vault/${m.id}/edit`}>
                    <Pencil aria-hidden strokeWidth={1.5} />
                    Edit
                  </Link>
                </Button>
                <ConfirmDialog
                  trigger={
                    <Button variant="ghost">
                      <Trash2 aria-hidden strokeWidth={1.5} />
                      Delete
                    </Button>
                  }
                  title="Delete this memory?"
                  description="The memory and its photos and recordings will be removed from your Memory Vault."
                  confirmLabel="Delete memory"
                  pending={remove.isPending}
                  error={remove.error}
                  onConfirm={() =>
                    remove.mutateAsync().then(() => {
                      toast.success('Memory deleted');
                      router.replace('/memory-vault');
                    })
                  }
                />
              </div>
            }
          />
          <div className="grid gap-6">
            {m.textContent && (
              <section aria-label="Memory" className="rounded-xl border border-border bg-surface p-6 sm:p-10">
                <p className="max-w-3xl font-heading text-xl leading-relaxed whitespace-pre-wrap break-words sm:text-[22px]">
                  {m.textContent}
                </p>
              </section>
            )}
            <MediaManager scope={{ kind: 'memory-vault', id: m.id }} kinds={['PHOTO', 'AUDIO']} editable />
          </div>
        </>
      )}
    </QueryView>
  );
}

export function NewMemory({ category }: { category?: MemoryCategory }) {
  const router = useRouter();
  const create = memories.useCreate();
  return (
    <>
      <PageHeader
        back={{ href: '/memory-vault', label: 'Memory Vault' }}
        title={<>Save a <em>memory</em></>}
        description="Write it down now. You can add photos or a recording on the next page."
      />
      <MemoryForm
        initialCategory={category}
        submitLabel="Save memory"
        pending={create.isPending}
        error={create.error}
        onSubmit={(input) =>
          create.mutate(input, {
            onSuccess: (m) => {
              toast.success('Memory saved');
              router.push(`/memory-vault/${m.id}`);
            },
          })
        }
      />
    </>
  );
}

export function EditMemory({ id }: { id: string }) {
  const router = useRouter();
  const item = memories.useItem(id);
  const update = memories.useUpdate(id);
  return (
    <QueryView query={item} notFound={NOT_FOUND}>
      {(m) => (
        <>
          <PageHeader back={{ href: `/memory-vault/${id}`, label: m.title }} title={<>Edit <em>memory</em></>} />
          <MemoryForm
            initial={m}
            submitLabel="Save changes"
            pending={update.isPending}
            error={update.error}
            onSubmit={(input) =>
              update.mutate(input, {
                onSuccess: () => {
                  toast.success('Changes saved');
                  router.push(`/memory-vault/${id}`);
                },
              })
            }
          />
        </>
      )}
    </QueryView>
  );
}

function MemoryForm({
  initial,
  initialCategory,
  submitLabel,
  pending,
  error,
  onSubmit,
}: {
  initial?: Memory;
  initialCategory?: MemoryCategory;
  submitLabel: string;
  pending: boolean;
  error: ApiError | null;
  onSubmit: (input: MemoryInput) => void;
}) {
  const form = useForm<MemoryValues>({
    resolver: zodResolver(memorySchema),
    defaultValues: {
      title: initial?.title ?? '',
      category: initial?.category ?? initialCategory,
      textContent: initial?.textContent ?? '',
    },
  });
  const { errors, isDirty, isSubmitSuccessful } = form.formState;
  const text = useWatch({ control: form.control, name: 'textContent' });
  useUnsavedChanges(isDirty && !isSubmitSuccessful);
  return (
    <form
      noValidate
      onSubmit={form.handleSubmit(
        (v) =>
          !pending &&
          onSubmit({ title: v.title.trim(), category: v.category, textContent: v.textContent.trim() ? v.textContent : null }),
      )}
      className="grid max-w-3xl gap-8 rounded-xl border border-border bg-surface p-6 sm:p-10"
    >
      <FormError error={error} />
      <fieldset disabled={pending} className="grid gap-8">
        <TextField id="title" label="Title" placeholder="e.g. Nana’s Sunday roast" error={errors.title?.message} {...form.register('title')} />
        <ChoiceGroup
          legend="Category"
          className="grid-cols-2 sm:grid-cols-4"
          choices={MEMORY_CATEGORIES.map((c) => ({ value: c, label: humanize(c) }))}
          registration={form.register('category')}
          error={errors.category?.message}
        />
        <TextAreaField
          id="textContent"
          label="The memory"
          optional
          hint="In your own words. Plain text."
          maxLength={TEXT_CONTENT_MAX}
          length={text.length}
          error={errors.textContent?.message}
          {...form.register('textContent')}
        />
      </fieldset>
      <div>
        <Button type="submit" size="lg" disabled={pending}>
          {pending && <Spinner />}
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
