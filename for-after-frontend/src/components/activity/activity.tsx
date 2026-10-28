'use client';

import { ArrowRight } from 'lucide-react';
import Link from 'next/link';
import { PageHeader } from '@/components/shared/page-header';
import { Pager } from '@/components/shared/list-controls';
import { SectionHeading } from '@/components/shared/section-heading';
import { useActivity } from '@/hooks/use-activity';
import { activityHref, activityLabel, groupByDay, longDay, shortDay, timeOfDay } from '@/lib/activity';
import type { ActivityItem } from '@/lib/api/activity';
import { cn } from '@/lib/utils';

const DASHBOARD_LIMIT = 5;
const PAGE_LIMIT = 25;

/** One change: its words (a link while the item exists) and when. */
function Row({ item, when }: { item: ActivityItem; when: string }) {
  const href = activityHref(item);
  const label = activityLabel(item.type);
  return (
    <li className="flex flex-col gap-0.5 py-4 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6">
      {href ? (
        <Link
          href={href}
          className="w-fit text-[15px] text-foreground underline-offset-4 outline-none hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {label}
        </Link>
      ) : (
        <span className="text-[15px] text-foreground-secondary">{label}</span>
      )}
      <time dateTime={item.createdAt} className="shrink-0 text-sm text-foreground-muted">
        {when}
      </time>
    </li>
  );
}

const Skeleton = ({ rows }: { rows: number }) => (
  <ul aria-busy="true" aria-label="Loading recent changes" className="divide-y divide-border">
    {Array.from({ length: rows }, (_, i) => (
      <li key={i} className="flex items-center justify-between py-4">
        <span className="h-4 w-44 animate-pulse rounded bg-surface-muted" />
        <span className="h-4 w-14 animate-pulse rounded bg-surface-muted" />
      </li>
    ))}
  </ul>
);

/** Dashboard: the latest few changes, a quiet list (not cards), and a way to all of them. */
export function RecentChanges() {
  const query = useActivity(1, DASHBOARD_LIMIT);
  return (
    <section aria-labelledby="recent-changes">
      <SectionHeading id="recent-changes" title={<>Recent <em>changes</em></>} />
      {query.isPending ? (
        <Skeleton rows={4} />
      ) : query.isError ? (
        <p className="text-[15px] text-foreground-muted">Recent changes are unavailable right now.</p>
      ) : query.data.items.length === 0 ? (
        <p className="text-[15px] text-foreground-muted">
          No recent changes yet. Your activity will appear here as you build your For After space.
        </p>
      ) : (
        <>
          <ul className="divide-y divide-border border-y border-border">
            {query.data.items.map((item) => (
              <Row key={item.id} item={item} when={shortDay(item.createdAt)} />
            ))}
          </ul>
          <Link
            href="/settings/activity"
            className="group mt-5 inline-flex items-center gap-2 text-sm font-medium text-primary outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            View all activity
            <ArrowRight aria-hidden strokeWidth={1.5} className="size-4 transition-transform duration-200 group-hover:translate-x-0.5" />
          </Link>
        </>
      )}
    </section>
  );
}

/** /settings/activity: every change, newest first, grouped by day, paged by the API. */
export function ActivityHistory({ page }: { page: number }) {
  const query = useActivity(page, PAGE_LIMIT);
  return (
    <>
      <PageHeader
        eyebrow="Account"
        title="Activity"
        description="A record of meaningful changes you’ve made to your For After space."
      />
      {query.isPending ? (
        <Skeleton rows={6} />
      ) : query.isError ? (
        <p className="text-[15px] text-foreground-muted">Your activity is unavailable right now.</p>
      ) : query.data.items.length === 0 ? (
        <p className="text-[15px] text-foreground-muted">
          {page > 1 ? 'There are no more changes.' : 'No changes yet. Activity history begins when you start making changes.'}
        </p>
      ) : (
        <div className={cn('grid gap-10', query.isPlaceholderData && 'opacity-60')}>
          {groupByDay(query.data.items).map((group) => (
            <section key={group.key} aria-label={longDay(group.first)}>
              <h2 className="eyebrow mb-1 font-sans">{longDay(group.first)}</h2>
              <ul className="divide-y divide-border border-b border-border">
                {group.items.map((item) => (
                  <Row key={item.id} item={item} when={timeOfDay(item.createdAt)} />
                ))}
              </ul>
            </section>
          ))}
          <Pager pagination={query.data.pagination} hrefFor={(p) => (p > 1 ? `/settings/activity?page=${p}` : '/settings/activity')} />
        </div>
      )}
    </>
  );
}
