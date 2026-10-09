'use client';

import { HardDrive } from 'lucide-react';
import { QueryView } from '@/components/shared/states';
import { useStorageUsage } from '@/hooks/use-media';
import type { StorageLevel } from '@/lib/api/media';
import { formatBytes } from '@/lib/format';
import { cn } from '@/lib/utils';

// Calm, factual copy; no upgrade path is offered (plans come with billing).
const NOTICE: Record<StorageLevel, { text: string; tone: string } | null> = {
  NORMAL: null,
  WARNING: { text: 'You’ve used most of your storage.', tone: 'text-foreground-secondary' },
  HIGH: {
    text: 'Your storage is almost full. Deleting files you no longer need frees up space.',
    tone: 'text-warning',
  },
  FULL: {
    text: 'Your storage is full. Everything you’ve saved stays available, but new photos, recordings and videos can’t be added until you delete some files.',
    tone: 'text-danger',
  },
};

/** Phase 12C: storage used out of the Customer's limit, with 80 / 90 / 100 % notices. */
export function StorageUsageSection() {
  const usage = useStorageUsage();
  return (
    <section aria-labelledby="storage-heading" className="mt-16 border-t border-border pt-12 lg:mt-20 lg:pt-14">
      <div className="mb-8 grid gap-2">
        <h2 id="storage-heading" className="text-[32px] leading-tight">
          Storage
        </h2>
        <p className="max-w-xl text-foreground-muted">
          Photos, recordings and videos in your messages, memories and People I Love.
        </p>
      </div>
      <QueryView query={usage} loadingLabel="Loading your storage">
        {(u) => {
          const notice = NOTICE[u.level];
          return (
            <div className="grid gap-4 rounded-xl border border-border bg-surface p-6 sm:p-8">
              <div className="flex items-center gap-4">
                <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-primary-soft text-primary">
                  <HardDrive aria-hidden strokeWidth={1.5} className="size-5" />
                </span>
                <p className="text-[15px]">
                  <span className="font-semibold">{formatBytes(u.usedBytes + u.reservedBytes)}</span> of{' '}
                  {formatBytes(u.limitBytes)} used
                </p>
              </div>
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
              {notice && (
                <p role={u.level === 'NORMAL' ? undefined : 'status'} className={cn('text-sm', notice.tone)}>
                  {notice.text}
                </p>
              )}
            </div>
          );
        }}
      </QueryView>
    </section>
  );
}
