'use client';

import { ArrowRight, CalendarClock, Cake, Check, HardDrive, ShieldCheck, type LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { SectionHeading } from '@/components/shared/section-heading';
import { useAttention } from '@/hooks/use-attention';
import type { AttentionCategory } from '@/lib/api/attention';
import { cn } from '@/lib/utils';

const ICON: Record<AttentionCategory, LucideIcon> = {
  TRUSTED_CONTACTS: ShieldCheck,
  MESSAGES: CalendarClock,
  PEOPLE: Cake,
  STORAGE: HardDrive,
};

/** At most this many rows; the rest is a count, never a wall of alerts. */
export const ATTENTION_VISIBLE = 4;

/**
 * "What should I take care of next?" Specific, already-sorted actions from
 * GET /users/me/attention (overall progress stays with the journey above).
 * Thin rows, calm wording; a HIGH item gets a filled icon and "Worth doing
 * soon" in its accessible name, never a red banner. Loading never flashes "all clear", and
 * an error says so instead of pretending nothing needs attention.
 */
export function NeedsAttention() {
  const query = useAttention();
  const items = query.data?.items ?? [];
  const more = items.length - ATTENTION_VISIBLE;
  return (
    <section aria-labelledby="needs-attention">
      <SectionHeading id="needs-attention" title={<>Needs your <em>attention</em></>} />
      {query.isPending ? (
        <ul aria-busy="true" aria-label="Loading things to review" className="divide-y divide-border border-y border-border">
          {[0, 1, 2].map((i) => (
            <li key={i} className="flex items-center gap-4 py-4">
              <span className="size-8 animate-pulse rounded-full bg-surface-muted" />
              <span className="h-4 w-56 animate-pulse rounded bg-surface-muted" />
            </li>
          ))}
        </ul>
      ) : query.isError ? (
        <p className="text-[15px] text-foreground-muted">Things to review are unavailable right now.</p>
      ) : items.length === 0 ? (
        <div className="flex items-start gap-4 border-y border-border py-4">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full border border-border">
            <Check aria-hidden strokeWidth={1.75} className="size-4 text-brand-bronze" />
          </span>
          <p className="grid gap-0.5 text-[15px]">
            <span className="font-medium text-foreground">Everything looks in order</span>
            <span className="text-foreground-muted">No actions need your attention right now.</span>
          </p>
        </div>
      ) : (
        <>
          <ul className="divide-y divide-border border-y border-border">
            {items.slice(0, ATTENTION_VISIBLE).map((item) => {
              const Icon = ICON[item.category];
              const high = item.priority === 'HIGH';
              return (
                <li key={item.key}>
                  <Link
                    href={item.actionHref}
                    // One sentence for assistive tech; the spans alone would run together.
                    aria-label={`${high ? 'Worth doing soon: ' : ''}${item.title}. ${item.description ? `${item.description} ` : ''}${item.actionLabel}`}
                    className="group flex flex-col gap-2 py-4 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:flex-row sm:items-center sm:gap-6"
                  >
                    <span className="flex min-w-0 flex-1 items-start gap-4">
                      <span
                        className={cn(
                          'flex size-8 shrink-0 items-center justify-center rounded-full',
                          high ? 'bg-primary-soft text-primary' : 'border border-border text-foreground-muted',
                        )}
                      >
                        <Icon aria-hidden strokeWidth={1.5} className="size-4" />
                      </span>
                      <span className="grid min-w-0 gap-0.5 pt-1 text-[15px]">
                        <span className="font-medium text-foreground">{item.title}</span>
                        {item.description && <span className="text-sm text-foreground-muted">{item.description}</span>}
                      </span>
                    </span>
                    <span className="ml-12 inline-flex shrink-0 items-center gap-2 text-sm font-medium text-primary sm:ml-0">
                      {item.actionLabel}
                      <ArrowRight
                        aria-hidden
                        strokeWidth={1.5}
                        className="size-4 transition-transform duration-200 group-hover:translate-x-0.5"
                      />
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
          {more > 0 && (
            <p className="mt-4 text-sm text-foreground-muted">
              +{more} more {more === 1 ? 'thing' : 'things'} to review
            </p>
          )}
        </>
      )}
    </section>
  );
}
