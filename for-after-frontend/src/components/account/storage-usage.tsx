'use client';

import { ArrowRight, HardDrive } from 'lucide-react';
import Link from 'next/link';
import { QueryView } from '@/components/shared/states';
import { useStorageUsage } from '@/hooks/use-media';
import type { StorageUsage } from '@/lib/api/media';
import { formatBytes } from '@/lib/format';
import { cn } from '@/lib/utils';

export const STORAGE_MANAGER_HREF = '/settings/storage';

/** Calm, factual notice and call to action per level; no upgrade path (plans come with billing). */
export function storageNotice(u: StorageUsage): { text: string; tone: string; cta: string } | null {
  switch (u.level) {
    case 'NORMAL':
      return null;
    case 'WARNING':
      return { text: `You’re using ${u.percentage}% of your storage.`, tone: 'text-foreground-secondary', cta: 'Manage storage' };
    case 'HIGH':
      return { text: 'You’re almost out of storage.', tone: 'text-warning', cta: 'Free up space' };
    case 'FULL':
      return {
        text: 'Your storage is full. You can still view and remove existing content, but new uploads are paused until you free up space.',
        tone: 'text-danger',
        cta: 'Manage storage',
      };
  }
}

/** "25.0 MB of 5.0 GB used". Uploads in progress count as used, as the quota does. */
export function StorageAmount({ usage: u }: { usage: StorageUsage }) {
  return (
    <p className="text-[15px]">
      <span className="font-semibold">{formatBytes(u.usedBytes + u.reservedBytes)}</span> of{' '}
      {formatBytes(u.limitBytes)} used
    </p>
  );
}

export function StorageBar({ usage: u }: { usage: StorageUsage }) {
  return (
    <div
      role="progressbar"
      aria-label="Storage used"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={u.percentage}
      aria-valuetext={`${u.percentage}% used`}
      className="h-2 overflow-hidden rounded-full bg-brand-lilac-grey"
    >
      <div
        className={cn(
          'h-full rounded-full transition-[width]',
          u.level === 'FULL' ? 'bg-danger' : u.level === 'HIGH' ? 'bg-warning' : 'bg-primary',
        )}
        style={{ width: `${u.percentage}%` }}
      />
    </div>
  );
}

/**
 * Phase 12C: storage used out of the Customer's limit, with 80 / 90 / 100 %
 * notices. The whole card opens the Storage Manager: one real link (stretched
 * over the card), so keyboard, Enter and screen readers behave as for any link.
 */
export function StorageUsageSection() {
  const usage = useStorageUsage();
  return (
    <section aria-labelledby="storage-heading" className="mt-16 border-t border-border pt-12 lg:mt-20 lg:pt-14">
      <div className="mb-8 grid gap-2">
        <h2 id="storage-heading" className="text-[32px] leading-tight">
          Storage
        </h2>
        <p className="max-w-xl text-foreground-muted">
          Photos, recordings and videos saved across your For After account.
        </p>
      </div>
      <QueryView query={usage} loadingLabel="Loading your storage">
        {(u) => {
          const notice = storageNotice(u);
          return (
            <div className="relative grid gap-4 rounded-xl border border-border bg-surface p-6 transition-colors hover:border-border-strong has-[a:focus-visible]:outline-2 has-[a:focus-visible]:outline-offset-2 has-[a:focus-visible]:outline-ring sm:p-8">
              <div className="flex items-center gap-4">
                <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-primary-soft text-primary">
                  <HardDrive aria-hidden strokeWidth={1.5} className="size-5" />
                </span>
                <StorageAmount usage={u} />
              </div>
              <StorageBar usage={u} />
              {notice && (
                <p role="status" className={cn('text-sm', notice.tone)}>
                  {notice.text}
                </p>
              )}
              <Link
                href={STORAGE_MANAGER_HREF}
                className="inline-flex items-center gap-1.5 justify-self-start text-sm font-medium text-primary outline-none after:absolute after:inset-0 after:rounded-xl hover:underline"
              >
                {notice?.cta ?? 'Manage storage'}
                <ArrowRight aria-hidden strokeWidth={1.5} className="size-4" />
              </Link>
            </div>
          );
        }}
      </QueryView>
    </section>
  );
}
