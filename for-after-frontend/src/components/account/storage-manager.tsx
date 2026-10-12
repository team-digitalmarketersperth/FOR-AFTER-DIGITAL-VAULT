'use client';

import { ArrowLeft, AudioLines, HardDrive, Image as ImageIcon, Trash2, Video, type LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { toast } from 'sonner';
import { StorageAmount, StorageBar, storageNotice } from '@/components/account/storage-usage';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { FilterChips } from '@/components/shared/form-field';
import { Pager, SelectField, useFilterNav } from '@/components/shared/list-controls';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyState, QueryView } from '@/components/shared/states';
import { Button } from '@/components/ui/button';
import { useRemoveStorageItem, useStorageItems, useStorageUsage } from '@/hooks/use-media';
import {
  STORAGE_SOURCES,
  storageItemHref,
  type MediaKind,
  type StorageFilters,
  type StorageItem,
  type StorageSort,
  type StorageSource,
} from '@/lib/api/media';
import { formatBytes, formatDate } from '@/lib/format';
import { cn } from '@/lib/utils';

const BASE = '/settings/storage';

export const SOURCE_LABEL: Record<StorageSource, string> = {
  MESSAGE: 'Messages',
  MEMORY_VAULT: 'Memory Vault',
  MY_STORY: 'My Story',
  MY_WISHES: 'My Wishes',
  RECIPIENT_PHOTO: 'People I Love',
};
const ITEM_SOURCE: Record<StorageSource, string> = { ...SOURCE_LABEL, MESSAGE: 'Message' };
const TYPE: Record<MediaKind, { label: string; noun: string; icon: LucideIcon }> = {
  PHOTO: { label: 'Photos', noun: 'photo', icon: ImageIcon },
  AUDIO: { label: 'Audio', noun: 'recording', icon: AudioLines },
  VIDEO: { label: 'Videos', noun: 'video', icon: Video },
};
const NEUTRAL: Record<MediaKind, string> = { PHOTO: 'Photo', AUDIO: 'Audio recording', VIDEO: 'Video' };
const SORTS: { value: StorageSort; label: string }[] = [
  { value: 'size_desc', label: 'Largest first' },
  { value: 'created_desc', label: 'Newest first' },
  { value: 'created_asc', label: 'Oldest first' },
];
// Where a deletion removes it from (confirmation wording).
const FROM: Record<StorageSource, string> = {
  MESSAGE: 'this draft message',
  MEMORY_VAULT: 'your Memory Vault',
  MY_STORY: 'your My Story answer',
  MY_WISHES: 'your My Wishes answer',
  RECIPIENT_PHOTO: 'People I Love',
};
const RESTRICTION: Record<NonNullable<StorageItem['deleteRestriction']>, { text: string; action: string }> = {
  MESSAGE_SCHEDULED: {
    text: 'This file belongs to a scheduled message. Unschedule the message before changing its content.',
    action: 'Open message',
  },
  MESSAGE_RELEASED: {
    text: 'This file is part of a released message and cannot be removed from Storage Manager.',
    action: 'View message',
  },
  MESSAGE_LOCKED: { text: 'This message can no longer be changed.', action: 'View message' },
};

const label = (item: StorageItem) =>
  item.source === 'RECIPIENT_PHOTO'
    ? `${item.displayName || 'Someone you love'} · profile photo`
    : item.displayName || NEUTRAL[item.type];

/**
 * Storage Manager: what uses storage and the files themselves, largest first.
 * Totals come from the same API as the Settings card; type, source, sort and
 * page live in the URL and the API does the work. Deleting always goes
 * through the file's own feature, so its rules (e.g. draft messages only) apply.
 */
export function StorageManager({ filters }: { filters: StorageFilters }) {
  const router = useRouter();
  const usage = useStorageUsage();
  const list = useStorageItems(filters);
  const nav = useFilterNav(BASE, filters);
  const filtered = Boolean(filters.type || filters.source);
  const pages = list.data?.pagination.pages ?? 1;
  // After deleting the last file on a page, go to the last page that exists.
  const past = Boolean(list.data && !list.isPlaceholderData && (filters.page ?? 1) > Math.max(pages, 1));
  useEffect(() => {
    if (past) router.replace(nav.href({ page: pages > 1 ? pages : undefined }), { scroll: false });
  }, [past, pages, nav, router]);

  const chips = [
    { label: 'All', href: nav.href({ type: undefined, page: undefined }), active: !filters.type },
    ...(Object.keys(TYPE) as MediaKind[]).map((t) => ({
      label: TYPE[t].label,
      href: nav.href({ type: t, page: undefined }),
      active: filters.type === t,
    })),
  ];

  return (
    <div className="max-w-[1120px]">
      <PageHeader
        eyebrow="Account"
        title={<>Storage</>}
        description="See what uses your storage, and remove files you no longer need."
        action={
          <Button asChild variant="outline">
            <Link href="/settings">
              <ArrowLeft aria-hidden strokeWidth={1.5} />
              Account settings
            </Link>
          </Button>
        }
      />

      <QueryView query={usage} loadingLabel="Loading your storage">
        {(u) => {
          const notice = storageNotice(u);
          const used = u.breakdown.filter((b) => b.bytes > 0);
          return (
            <div className="grid gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
              <section
                aria-labelledby="usage-heading"
                className="grid content-start gap-4 rounded-xl border border-border bg-surface p-6 sm:p-8"
              >
                <h2 id="usage-heading" className="sr-only">
                  Storage used
                </h2>
                <div className="flex items-center gap-4">
                  <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-primary-soft text-primary">
                    <HardDrive aria-hidden strokeWidth={1.5} className="size-5" />
                  </span>
                  <StorageAmount usage={u} />
                </div>
                <StorageBar usage={u} />
                <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
                  <Fact term="Used" value={`${u.percentage}%`} />
                  <Fact term="Remaining" value={formatBytes(u.remainingBytes)} />
                  {u.reservedBytes > 0 && <Fact term="Uploads in progress" value={formatBytes(u.reservedBytes)} />}
                </dl>
                {notice && (
                  <p role="status" className={cn('text-sm', notice.tone)}>
                    {notice.text}
                  </p>
                )}
              </section>
              <section
                aria-labelledby="breakdown-heading"
                className="grid content-start gap-4 rounded-xl border border-border bg-surface p-6 sm:p-8"
              >
                <h2 id="breakdown-heading" className="text-2xl">
                  Storage breakdown
                </h2>
                {used.length ? (
                  <ul className="grid gap-2.5 text-[15px]">
                    {used.map((b) => (
                      <li key={b.source} className="flex items-baseline justify-between gap-4">
                        <span>{SOURCE_LABEL[b.source]}</span>
                        <span className="font-medium tabular-nums">{formatBytes(b.bytes)}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-foreground-muted">Nothing is stored yet.</p>
                )}
              </section>
            </div>
          );
        }}
      </QueryView>

      <section aria-labelledby="files-heading" className="mt-12">
        <h2 id="files-heading" className="mb-6 text-[32px] leading-tight">
          Your files
        </h2>
        <FilterChips label="Filter by type" chips={chips} />
        <div className="-mt-4 mb-8 grid gap-4 sm:grid-cols-2 lg:max-w-xl">
          <SelectField
            id="source"
            label="Where"
            value={filters.source ?? ''}
            onChange={(e) => nav.set({ source: (e.target.value || undefined) as StorageSource | undefined })}
            options={[{ value: '', label: 'Everywhere' }, ...STORAGE_SOURCES.map((s) => ({ value: s, label: SOURCE_LABEL[s] }))]}
          />
          <SelectField
            id="sort"
            label="Sort"
            value={filters.sort ?? 'size_desc'}
            onChange={(e) =>
              nav.set({ sort: e.target.value === 'size_desc' ? undefined : (e.target.value as StorageSort) })
            }
            options={SORTS}
          />
        </div>
        <QueryView query={list} loadingLabel="Loading your files">
          {({ items, pagination }) =>
            items.length === 0 ? (
              filtered ? (
                <EmptyState
                  icon={HardDrive}
                  title="No files match these filters."
                  action={
                    <Button asChild variant="outline">
                      <Link href={BASE}>Clear filters</Link>
                    </Button>
                  }
                />
              ) : (
                <EmptyState
                  icon={HardDrive}
                  title="Your storage is empty."
                  description="Photos, recordings and videos you add to messages, memories, My Story, My Wishes or People I Love will appear here."
                />
              )
            ) : (
              <div aria-busy={list.isPlaceholderData || undefined}>
                <ul className="grid gap-3">
                  {items.map((item) => (
                    <FileRow key={item.id} item={item} />
                  ))}
                </ul>
                <Pager pagination={pagination} hrefFor={(page) => nav.href({ page: page > 1 ? page : undefined })} />
              </div>
            )
          }
        </QueryView>
      </section>
    </div>
  );
}

function Fact({ term, value }: { term: string; value: string }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-foreground-muted">{term}</dt>
      <dd className="font-medium tabular-nums">{value}</dd>
    </div>
  );
}

/** One file: icon (no preview is fetched for the list), label, where, size, date, action. */
function FileRow({ item }: { item: StorageItem }) {
  const { icon: Icon, noun } = TYPE[item.type];
  const restriction = item.deleteRestriction ? RESTRICTION[item.deleteRestriction] : null;
  const name = label(item);
  const href = storageItemHref(item);
  return (
    <li className="grid gap-4 rounded-lg border border-border bg-surface p-5 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center">
      <span className="hidden size-11 items-center justify-center rounded-full bg-surface-muted text-foreground-secondary sm:flex">
        <Icon aria-hidden strokeWidth={1.5} className="size-5" />
      </span>
      <div className="grid min-w-0 gap-1">
        <p className="font-medium break-words">
          <span className="sr-only">{TYPE[item.type].label}: </span>
          {name}
        </p>
        <p className="flex flex-wrap gap-x-3 gap-y-0.5 text-sm text-foreground-muted">
          <span>{ITEM_SOURCE[item.source]}</span>
          <span className="tabular-nums">{formatBytes(item.sizeBytes)}</span>
          <span>{formatDate(item.createdAt)}</span>
        </p>
        {restriction && <p className="text-sm text-foreground-secondary">{restriction.text}</p>}
      </div>
      <div className="flex flex-wrap gap-2 sm:justify-end">
        <Button asChild variant="outline" size="sm">
          <Link href={href} aria-label={`${restriction?.action ?? 'View'}: ${name}`}>
            {restriction?.action ?? 'View'}
          </Link>
        </Button>
        {item.canDelete && <DeleteFile item={item} name={name} noun={noun} />}
      </div>
    </li>
  );
}

function DeleteFile({ item, name, noun }: { item: StorageItem; name: string; noun: string }) {
  const remove = useRemoveStorageItem();
  const photo = item.source === 'RECIPIENT_PHOTO';
  return (
    <ConfirmDialog
      trigger={
        <Button variant="ghost" size="sm" className="text-danger" aria-label={`${photo ? 'Remove photo' : 'Delete'}: ${name}`}>
          <Trash2 aria-hidden strokeWidth={1.5} />
          {photo ? 'Remove photo' : 'Delete'}
        </Button>
      }
      title={photo ? 'Remove this profile photo?' : `Delete this ${noun}?`}
      description={
        <>
          <span className="block font-medium text-foreground">
            {name} · {formatBytes(item.sizeBytes)}
          </span>
          {photo
            ? 'The photo is removed; the person stays in People I Love. '
            : `This permanently removes the ${noun} from ${FROM[item.source]}. `}
          The space becomes available again for new uploads.
        </>
      }
      confirmLabel={photo ? 'Remove photo' : `Delete ${noun}`}
      pending={remove.isPending}
      error={remove.error}
      onConfirm={() =>
        remove.mutateAsync(item).then(() => toast.success(photo ? 'Photo removed' : `${noun[0].toUpperCase()}${noun.slice(1)} deleted`))
      }
    />
  );
}
