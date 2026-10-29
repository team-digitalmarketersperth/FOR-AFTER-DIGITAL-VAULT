'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { Images, Info, Pencil, Plus, Send, Tag, Trash2, X } from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { toast } from 'sonner';
import { MediaManager } from '@/components/media/media-manager';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { Pager, SearchBox, useFilterNav } from '@/components/shared/list-controls';
import { HelpMeWrite } from '@/components/companion/companion';
import { ChoiceGroup, FilterChips, FormError, TextAreaField, TextField } from '@/components/shared/form-field';
import { PageHeader } from '@/components/shared/page-header';
import { PrivateNoteField, PrivateNoteView } from '@/components/shared/private-note';
import { QueryView, Spinner } from '@/components/shared/states';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useUnsavedChanges } from '@/hooks/use-unsaved-changes';
import { memories } from '@/hooks/use-vault';
import type { ApiError } from '@/lib/api/errors';
import {
  MEMORY_CATEGORIES,
  SEARCH_MAX,
  TAG_NAME_MAX,
  TAGS_MAX,
  type Memory,
  type MemoryCategory,
  type MemoryFilters,
  type MemoryInput,
  type MemoryTag,
} from '@/lib/api/memory-vault';
import { TEXT_CONTENT_MAX } from '@/lib/api/messages';
import { formatDate, humanize } from '@/lib/format';
import { memorySchema, type MemoryValues } from '@/schemas/vault';

const newButton = (
  <Button asChild className="h-11 w-full rounded-md px-5 sm:w-auto">
    <Link href="/memory-vault/new">
      <Plus aria-hidden strokeWidth={1.5} />
      Save a memory
    </Link>
  </Button>
);

const BASE = '/memory-vault';

/**
 * Search, category, tag and page all live in the URL (shareable, Back works);
 * the API filters and pages. Any filter change goes back to page 1.
 */
export function MemoryList({ filters }: { filters: MemoryFilters }) {
  const router = useRouter();
  const list = memories.useList(filters);
  const tags = memories.useTags();
  const nav = useFilterNav(BASE, filters);
  const filtered = Boolean(filters.category || filters.tag || filters.search);
  const pages = list.data?.pagination.pages ?? 1;
  // A page past the end (e.g. after deleting the last memory on it): go to
  // the last page instead of showing an empty one.
  const past = Boolean(list.data && !list.isPlaceholderData && (filters.page ?? 1) > Math.max(pages, 1));
  useEffect(() => {
    if (past) router.replace(nav.href({ page: pages > 1 ? pages : undefined }), { scroll: false });
  }, [past, pages, nav, router]);
  const chips = [
    { label: 'All', href: nav.href({ category: undefined, page: undefined }), active: !filters.category },
    ...MEMORY_CATEGORIES.map((c) => ({
      label: humanize(c),
      href: nav.href({ category: c, page: undefined }),
      active: filters.category === c,
    })),
  ];
  const tagNames = tags.data?.map((t) => t.name) ?? [];
  // A tag from a shared link that is not (or no longer) one of theirs still shows as selected.
  if (filters.tag && !tagNames.some((n) => n.toLowerCase() === filters.tag!.toLowerCase())) tagNames.push(filters.tag);
  const tagValue = tagNames.find((n) => n.toLowerCase() === filters.tag?.toLowerCase()) ?? '';
  return (
    <>
      <VaultIntro />
      {/* One row from lg; on tablets search gets its own row, tag + Save share the next. */}
      <div className="mb-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] lg:grid-cols-[minmax(0,1fr)_14rem_auto]">
        <div className="sm:col-span-2 lg:col-span-1">
          <SearchBox
            value={filters.search}
            onSearch={(search) => nav.set({ search })}
            placeholder="Search memories…"
            label="Search memories"
            hideLabel
            maxLength={SEARCH_MAX}
          />
        </div>
        <div className="relative">
          <Label htmlFor="tag" className="sr-only">
            Filter memories by tag
          </Label>
          <Tag aria-hidden strokeWidth={1.5} className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-foreground-muted" />
          <select
            id="tag"
            value={tagValue}
            onChange={(e) => nav.set({ tag: e.target.value || undefined })}
            className="h-11 w-full rounded-sm border border-input bg-surface pr-3 pl-9 text-sm outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-1 focus-visible:outline-ring"
          >
            {[{ value: '', label: 'All tags' }, ...tagNames.map((n) => ({ value: n, label: n }))].map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        {newButton}
      </div>
      <FilterChips
        label="Filter by category"
        chips={chips}
        className="mb-6 flex-nowrap overflow-x-auto pt-1 pb-2 sm:flex-wrap sm:overflow-visible"
      />
      <QueryView query={list} loadingLabel="Loading your memories">
        {({ items, pagination }) =>
          items.length === 0 ? (
            filtered ? (
              <VaultEmpty
                title="No memories match your filters"
                description="Try a different search, category or tag."
                action={
                  <Button asChild variant="outline">
                    <Link href={BASE}>Clear filters</Link>
                  </Button>
                }
              />
            ) : (
              <VaultEmpty
                title="Your Memory Vault is ready when you are"
                description="Write down a story, a recipe or a moment, and add photos or a recording if you like."
                action={newButton}
              />
            )
          ) : (
            <div aria-busy={list.isPlaceholderData || undefined}>
              <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {items.map((m) => (
                  <li key={m.id}>
                    <Link
                      href={`/memory-vault/${m.id}`}
                      className="flex h-full flex-col gap-3 rounded-lg border border-border bg-surface p-6 outline-none transition-colors hover:border-border-strong focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring"
                    >
                      <span className="eyebrow">{humanize(m.category)}</span>
                      <span className="font-heading text-[26px] leading-tight break-words">{m.title}</span>
                      {m.textContent && (
                        <span className="line-clamp-4 text-[15px] leading-relaxed text-foreground-secondary">{m.textContent}</span>
                      )}
                      <TagList tags={m.tags} />
                      <span className="mt-auto pt-2 text-sm text-foreground-muted">{formatDate(m.createdAt)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
              <Pager pagination={pagination} hrefFor={(page) => nav.href({ page: page > 1 ? page : undefined })} />
            </div>
          )
        }
      </QueryView>
    </>
  );
}

/**
 * Latest approved copy (2026-10-19): heading and one description, word for
 * word; the audience guidance stays as secondary text. The photos are
 * decorative (existing brand images, empty alt) and only shown from lg up, so
 * no copy depends on them.
 */
function VaultIntro() {
  return (
    <section className="mb-6 grid overflow-hidden rounded-xl border border-border bg-brand-ivory lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <div className="grid content-center gap-4 p-6 sm:p-10">
        <h1 className="text-[40px] leading-[1.05] break-words sm:text-5xl">
          Memory <em>Vault</em>
        </h1>
        <p className="max-w-xl text-base leading-relaxed text-foreground-secondary sm:text-[17px]">
          Gather the photos, videos and stories that celebrate your life. After you pass away, your Memory Vault will
          become a memorial page to share with loved ones and funeral guests.
        </p>
        <p className="mt-2 flex max-w-xl gap-3 rounded-sm border-l-2 border-primary bg-surface/80 px-4 py-3 text-sm leading-relaxed text-foreground-secondary">
          <Info aria-hidden strokeWidth={1.5} className="mt-0.5 size-4 shrink-0 text-primary" />
          <span>
            Choose what you share with that future audience in mind. Only add content you’re comfortable having seen by
            everyone who may receive the memorial page link.
          </span>
        </p>
      </div>
      <div aria-hidden className="relative hidden min-h-72 lg:block">
        <Print src="/brand/writing.webp" className="top-8 right-[44%] w-[40%] -rotate-6" />
        <Print src="/brand/together.webp" crop className="top-14 right-[12%] w-[42%] rotate-3" />
        <Sprig className="absolute bottom-4 left-[8%] h-24 w-auto -rotate-12 text-brand-bronze" />
      </div>
    </section>
  );
}

/** A printed photo: white border, deeper at the bottom, a soft lift. */
function Print({ src, crop, className }: { src: string; crop?: boolean; className: string }) {
  return (
    <div className={`absolute bg-surface p-2 pb-8 shadow-soft ${className}`}>
      <div className="relative aspect-square overflow-hidden">
        {/* crop: the hands and the photo they hold, not faces. */}
        <Image
          src={src}
          alt=""
          fill
          sizes="220px"
          className={crop ? 'origin-[48%_70%] scale-[2.2] object-cover' : 'object-cover'}
        />
      </div>
    </div>
  );
}

/** A single quiet botanical line. */
function Sprig({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 60 120" fill="none" stroke="currentColor" strokeWidth={1.25} strokeLinecap="round" className={className}>
      <path d="M30 118C30 80 28 45 34 4" />
      <path d="M30 92c-10-4-16-12-18-22 10 2 17 9 18 22Z" />
      <path d="M31 70c9-4 15-11 17-21-10 2-16 9-17 21Z" />
      <path d="M31 48c-8-4-13-10-14-19 8 2 13 8 14 19Z" />
      <path d="M33 27c7-3 11-9 12-16-7 2-11 7-12 16Z" />
    </svg>
  );
}

/** Compact empty state: icon in a soft circle, serif heading, one action. */
function VaultEmpty({ title, description, action }: { title: string; description: string; action: ReactNode }) {
  return (
    <section className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border-strong bg-surface px-6 py-12 text-center">
      <span className="mb-1 grid size-12 place-items-center rounded-full bg-brand-ivory">
        <Images aria-hidden strokeWidth={1.5} className="size-5 text-primary" />
      </span>
      <h2 className="text-[28px] leading-tight">{title}</h2>
      <p className="max-w-sm text-sm text-foreground-muted">{description}</p>
      <div className="mt-2">{action}</div>
    </section>
  );
}

/** Read-only tag chips (cards and detail). */
function TagList({ tags }: { tags: MemoryTag[] }) {
  if (!tags.length) return null;
  return (
    <ul aria-label="Tags" className="flex flex-wrap gap-1.5">
      {tags.map((t) => (
        <li key={t.id} className="rounded-full bg-surface-muted px-2.5 py-0.5 text-xs text-foreground-secondary">
          {t.name}
        </li>
      ))}
    </ul>
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
                {/* Phase 13B: sharing = a separate message; the memory stays private. */}
                <Button asChild>
                  <Link href={`/memory-vault/${m.id}/create-message`}>
                    <Send aria-hidden strokeWidth={1.5} />
                    Create a message
                  </Link>
                </Button>
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
            <TagList tags={m.tags} />
            <MediaManager scope={{ kind: 'memory-vault', id: m.id }} kinds={['PHOTO', 'AUDIO']} editable />
            <PrivateNoteView note={m.privateNote} />
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
      privateNote: initial?.privateNote ?? '',
      tags: initial?.tags.map((t) => t.name) ?? [],
    },
  });
  const { errors, isDirty, isSubmitSuccessful } = form.formState;
  const text = useWatch({ control: form.control, name: 'textContent' });
  const tags = useWatch({ control: form.control, name: 'tags' });
  const note = useWatch({ control: form.control, name: 'privateNote' });
  useUnsavedChanges(isDirty && !isSubmitSuccessful);
  return (
    <form
      noValidate
      onSubmit={form.handleSubmit(
        (v) =>
          !pending &&
          onSubmit({
            title: v.title.trim(),
            category: v.category,
            textContent: v.textContent.trim() ? v.textContent : null,
            privateNote: v.privateNote.trim() || null,
            tags: v.tags,
          }),
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
        <div className="grid gap-2">
        {/* Only the memory text: never the title, tags, private note or files. */}
        <HelpMeWrite
          targetKey={`memory:${initial?.id ?? 'new'}:textContent`}
          question={form.getValues('title').trim() || 'Your memory'}
          field="The memory"
          save={submitLabel}
          read={() => form.getValues('textContent')}
          write={(v) => form.setValue('textContent', v, { shouldDirty: true, shouldValidate: form.formState.isSubmitted })}
          className="justify-self-end"
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
        </div>
        <TagInput value={tags} onChange={(next) => form.setValue('tags', next, { shouldDirty: true })} />
        <PrivateNoteField
          id="privateNote"
          placeholder="Add a reminder or context for yourself."
          length={note.length}
          error={errors.privateNote?.message}
          {...form.register('privateNote')}
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

const sameTag = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Add / remove tags by name. Suggestions are the Customer's existing tags
 * (native datalist); "Family" and "family" are one tag, as in the API.
 */
function TagInput({ value, onChange }: { value: string[]; onChange: (tags: string[]) => void }) {
  const existing = memories.useTags().data ?? [];
  const [text, setText] = useState('');
  const name = text.trim().replace(/\s+/g, ' ');
  const full = value.length >= TAGS_MAX;
  const add = () => {
    if (!name || full) return;
    if (!value.some((t) => sameTag(t, name))) {
      // Reuse the existing spelling, as the API will.
      onChange([...value, existing.find((t) => sameTag(t.name, name))?.name ?? name]);
    }
    setText('');
  };
  return (
    <div className="grid gap-2">
      <Label htmlFor="tag-input">
        Tags <span className="font-normal text-foreground-muted">(optional)</span>
      </Label>
      {value.length > 0 && (
        <ul aria-label="Selected tags" className="flex flex-wrap gap-2">
          {value.map((t) => (
            <li key={t} className="inline-flex items-center gap-1 rounded-full bg-surface-muted py-1 pr-1 pl-3 text-sm">
              {t}
              <button
                type="button"
                aria-label={`Remove tag ${t}`}
                onClick={() => onChange(value.filter((v) => v !== t))}
                className="inline-flex size-6 items-center justify-center rounded-full outline-none hover:bg-border focus-visible:outline-2 focus-visible:outline-ring"
              >
                <X aria-hidden className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <Input
          id="tag-input"
          list="tag-suggestions"
          value={text}
          maxLength={TAG_NAME_MAX}
          disabled={full}
          placeholder={full ? `Up to ${TAGS_MAX} tags` : 'e.g. Family'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
          className="h-11"
        />
        <Button type="button" variant="outline" onClick={add} disabled={!name || full}>
          Add tag
        </Button>
      </div>
      <datalist id="tag-suggestions">
        {existing
          .filter((t) => !value.some((v) => sameTag(v, t.name)))
          .map((t) => (
            <option key={t.id} value={t.name} />
          ))}
      </datalist>
    </div>
  );
}
