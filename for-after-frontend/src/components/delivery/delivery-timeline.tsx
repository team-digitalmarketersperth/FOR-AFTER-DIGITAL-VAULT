'use client';

import { ArrowRight, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { PageHeader } from '@/components/shared/page-header';
import { SectionHeading } from '@/components/shared/section-heading';
import { useDeliveryTimeline } from '@/hooks/use-delivery-timeline';
import { useReadiness } from '@/hooks/use-readiness';
import { formatDate } from '@/lib/format';
import { conditionalLabel, shortWhen, toRecipients, upcomingDetail, whenLabel } from '@/lib/delivery-timeline';
import { cn } from '@/lib/utils';

const TIMELINE_HREF = '/messages/timeline';

/** One event on the connected line: when (serif) · node · what, who, and a link. */
function Event({
  when,
  title,
  recipients,
  detail,
  messageId,
  last,
  muted,
}: {
  when: string;
  title: string;
  recipients: string[];
  detail?: string;
  messageId: string;
  last: boolean;
  muted?: boolean;
}) {
  const to = toRecipients(recipients);
  return (
    <li className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-x-4 sm:grid-cols-[10rem_1.25rem_minmax(0,1fr)] sm:gap-x-6">
      <p className="col-start-2 pt-0.5 font-heading text-lg leading-tight sm:col-start-1 sm:row-start-1 sm:text-right">{when}</p>
      <span aria-hidden className="relative col-start-1 row-span-2 row-start-1 sm:col-start-2 sm:row-span-1">
        <span
          className={cn(
            'absolute top-2 left-1/2 size-[9px] -translate-x-1/2 rounded-full border',
            muted ? 'border-border-strong bg-background' : 'border-primary bg-primary',
          )}
        />
        {!last && <span className="absolute top-5 bottom-0 left-1/2 -translate-x-px border-l border-[color-mix(in_srgb,var(--brand-bronze)_42%,var(--background))]" />}
      </span>
      <div className="col-start-2 grid gap-1 pt-1 pb-9 sm:col-start-3 sm:row-start-1 sm:pt-0.5">
        <p className="text-[15px]">
          <span className="font-medium text-foreground">{title}</span>
          {to && <span className="text-foreground-muted"> {to}</span>}
        </p>
        {detail && <p className="text-sm text-foreground-muted">{detail}</p>}
        <Link
          href={`/messages/${messageId}`}
          className="mt-1 inline-flex w-fit items-center gap-1.5 text-sm font-medium text-primary outline-none hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          View message
          <ArrowRight aria-hidden strokeWidth={1.5} className="size-3.5" />
          <span className="sr-only">: {title}</span>
        </Link>
      </div>
    </li>
  );
}

function Group({ label, note, children }: { label: string; note?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={label} className="grid gap-5">
      <div className="grid gap-1">
        <h2 className="eyebrow font-sans">{label}</h2>
        {note}
      </div>
      <ol>{children}</ol>
    </section>
  );
}

function NeedsTiming() {
  const readiness = useReadiness();
  const n = readiness.data?.steps.find((s) => s.key === 'SCHEDULING');
  const count = n && n.key === 'SCHEDULING' ? n.needsScheduling : 0;
  if (!count) return null;
  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border bg-surface px-5 py-4 text-[15px]">
      <span className="text-foreground-secondary">
        {count === 1 ? '1 message still needs timing' : `${count} messages still need timing`}
      </span>
      <Link href="/messages" className="font-medium text-primary hover:underline">
        Review messages
      </Link>
    </p>
  );
}

const TimelineSkeleton = () => (
  <div aria-busy="true" aria-label="Loading your delivery timeline" className="grid gap-8">
    {[0, 1, 2].map((i) => (
      <div key={i} className="grid grid-cols-[1.25rem_1fr] gap-x-4 sm:grid-cols-[10rem_1.25rem_1fr] sm:gap-x-6">
        <span className="h-5 w-28 animate-pulse rounded bg-surface-muted max-sm:col-start-2 sm:justify-self-end" />
        <span className="max-sm:col-start-1 max-sm:row-start-1 mx-auto mt-2 size-[9px] rounded-full bg-surface-muted" />
        <span className="h-10 animate-pulse rounded bg-surface-muted max-sm:col-start-2" />
      </div>
    ))}
  </div>
);

/** /messages/timeline: the whole plan, read-only. Editing stays on each message. */
export function DeliveryTimelinePage() {
  const query = useDeliveryTimeline();
  return (
    <div className="max-w-[920px]">
      <PageHeader
        back={{ href: '/messages', label: 'Messages' }}
        title={
          <>
            Delivery <em>Timeline</em>
          </>
        }
        description="See when the people you love will receive what you’ve prepared."
      />
      {query.isPending ? (
        <TimelineSkeleton />
      ) : query.isError ? (
        <p className="text-[15px] text-foreground-muted">Your delivery timeline is unavailable right now.</p>
      ) : (
        (() => {
          const { upcoming, conditional, recent } = query.data;
          const empty = !upcoming.length && !conditional.length;
          return (
            <div className="grid gap-12">
              <NeedsTiming />
              {empty && (
                <div className="grid gap-2">
                  <p className="font-heading text-2xl">No delivery plans yet</p>
                  <p className="text-foreground-muted">When you choose timing for a message, it will appear here.</p>
                  <Link href="/messages" className="mt-2 inline-flex w-fit items-center gap-2 text-sm font-medium text-primary hover:underline">
                    Review messages
                    <ArrowRight aria-hidden strokeWidth={1.5} className="size-4" />
                  </Link>
                </div>
              )}
              {upcoming.length > 0 && (
                <Group label="Coming up">
                  {upcoming.map((e, i) => (
                    <Event
                      key={e.key}
                      when={whenLabel(e)}
                      title={e.title}
                      recipients={e.recipients}
                      detail={upcomingDetail(e)}
                      messageId={e.messageId}
                      last={i === upcoming.length - 1}
                    />
                  ))}
                </Group>
              )}
              {conditional.length > 0 && (
                <Group
                  label="When the time comes"
                  note={
                    <p className="flex items-start gap-2 text-sm text-foreground-muted">
                      <ShieldCheck aria-hidden strokeWidth={1.5} className="mt-0.5 size-4 shrink-0" />
                      Delivered only after our team verifies a death, never because of a report alone.
                    </p>
                  }
                >
                  {conditional.map((e, i) => (
                    <Event
                      key={e.key}
                      when={conditionalLabel(e)}
                      title={e.title}
                      recipients={e.recipients}
                      messageId={e.messageId}
                      last={i === conditional.length - 1}
                    />
                  ))}
                </Group>
              )}
              {recent.length > 0 && (
                <Group label="Recently delivered">
                  {recent.map((e, i) => (
                    <Event
                      key={e.key}
                      when={formatDate(e.deliveredAt)}
                      title={e.title}
                      recipients={e.recipients}
                      messageId={e.messageId}
                      last={i === recent.length - 1}
                      muted
                    />
                  ))}
                </Group>
              )}
            </div>
          );
        })()
      )}
    </div>
  );
}

/**
 * Dashboard: at most 4. The next dated deliveries, and (when there is one)
 * the first "when the time comes" delivery keeps the last place.
 */
export function ComingUp() {
  const query = useDeliveryTimeline();
  const { upcoming = [], conditional = [] } = query.data ?? {};
  const dated = upcoming.slice(0, conditional.length ? 3 : 4);
  const rows = [
    ...dated.map((e) => ({ key: e.key, when: shortWhen(e), title: e.title, recipients: e.recipients })),
    ...conditional
      .slice(0, 4 - dated.length)
      .map((e) => ({ key: e.key, when: conditionalLabel(e), title: e.title, recipients: e.recipients })),
  ];
  return (
    <section aria-labelledby="coming-up">
      <SectionHeading id="coming-up" title={<>Coming <em>up</em></>} />
      {query.isPending ? (
        <ul aria-busy="true" aria-label="Loading what’s coming up" className="divide-y divide-border">
          {[0, 1, 2].map((i) => (
            <li key={i} className="flex gap-6 py-4">
              <span className="h-4 w-20 animate-pulse rounded bg-surface-muted" />
              <span className="h-4 w-48 animate-pulse rounded bg-surface-muted" />
            </li>
          ))}
        </ul>
      ) : query.isError ? (
        <p className="text-[15px] text-foreground-muted">Your delivery timeline is unavailable right now.</p>
      ) : rows.length === 0 ? (
        <p className="text-[15px] text-foreground-muted">No delivery plans yet. When you choose timing for a message, it will appear here.</p>
      ) : (
        <>
          <ul className="divide-y divide-border border-y border-border">
            {rows.map((r) => (
              <li key={r.key} className="flex flex-col gap-0.5 py-4 sm:flex-row sm:items-baseline sm:gap-8">
                <span className="shrink-0 font-heading text-lg leading-tight sm:w-52">{r.when}</span>
                <span className="text-[15px]">
                  <span className="text-foreground">{r.title}</span>
                  {r.recipients.length > 0 && <span className="text-foreground-muted"> {toRecipients(r.recipients)}</span>}
                </span>
              </li>
            ))}
          </ul>
          <Link
            href={TIMELINE_HREF}
            className="group mt-5 inline-flex items-center gap-2 text-sm font-medium text-primary outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            View delivery timeline
            <ArrowRight aria-hidden strokeWidth={1.5} className="size-4 transition-transform duration-200 group-hover:translate-x-0.5" />
          </Link>
        </>
      )}
    </section>
  );
}
