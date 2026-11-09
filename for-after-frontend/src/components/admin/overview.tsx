'use client';

import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  CircleSlash,
  RefreshCw,
} from 'lucide-react';
import Link from 'next/link';
import { linkClass, Panel } from '@/components/admin/admin-ui';
import { PageHeader } from '@/components/shared/page-header';
import { QueryView, Spinner } from '@/components/shared/states';
import { Button } from '@/components/ui/button';
import { useAdminDashboard } from '@/hooks/use-admin';
import { HealthBadge } from '@/components/admin/system-health';
import type { AdminDashboard } from '@/lib/api/admin';
import { isFailure, OVERALL_LABEL, overall, SERVICES } from '@/lib/system-health';
import { formatTimestamp, timeZoneLabel } from '@/lib/format';
import { cn } from '@/lib/utils';

const UNAVAILABLE = 'Unavailable';

/**
 * Read-only operational summary: only what GET /admin/dashboard returns
 * (definitions in the backend docs/admin.md → Overview). A section the API
 * could not read is null and shown as "Unavailable", never as zero. Links go
 * only to existing admin pages and the filters they support.
 */
export function AdminOverview() {
  const dashboard = useAdminDashboard();
  return (
    <>
      <PageHeader
        eyebrow="Admin Portal"
        title="Overview"
        description="Counts and service checks from the live platform. What needs a person comes first."
      />
      <QueryView query={dashboard} loadingLabel="Loading the overview">
        {(d) => (
          <div className="grid gap-10">
            <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-foreground-muted">
              <p aria-live="polite">
                Last updated {formatTimestamp(d.generatedAt)} ({timeZoneLabel(new Date(d.generatedAt))})
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={dashboard.isFetching}
                // refetch() cancels any request still in flight, so an older answer never wins.
                onClick={() => void dashboard.refetch()}
              >
                {dashboard.isFetching ? <Spinner /> : <RefreshCw aria-hidden strokeWidth={1.5} />}
                Refresh
              </Button>
            </div>
            <Attention d={d} />
            <div className="grid gap-6 lg:grid-cols-2">
              <Panel title="Customer accounts" className="content-start">
                <Stats
                  items={[
                    ['Total', d.customers?.total, '/admin/users?role=CUSTOMER'],
                    ['Active', d.customers?.active, '/admin/users?role=CUSTOMER&status=ACTIVE'],
                    ['Suspended', d.customers?.suspended, '/admin/users?role=CUSTOMER&status=SUSPENDED'],
                    ['Passed', d.customers?.passed, '/admin/users?role=CUSTOMER&status=PASSED'],
                    ['Deleted', d.customers?.deleted, '/admin/users?role=CUSTOMER&status=DELETED'],
                    ['New in the last 7 days', d.customers?.newLast7Days],
                  ]}
                />
              </Panel>
              <Panel title="Open death verification cases" className="content-start">
                <Stats
                  items={[
                    ['Pending verification', d.deathVerification?.pending, '/admin/death-verifications?status=PENDING_VERIFICATION'],
                    ['Safeguard active', d.deathVerification?.safeguardActive, '/admin/death-verifications?status=SAFEGUARD_ACTIVE'],
                    ['Ready for review', d.deathVerification?.readyForReview, '/admin/death-verifications?status=READY_FOR_REVIEW'],
                  ]}
                />
              </Panel>
              <Panel title="Releases and release emails" className="content-start">
                <Stats
                  items={[
                    ['Past due, not yet released', d.releases?.pastDue, '/admin/releases?pastDue=true'],
                    ['Emails retrying', d.releaseEmails?.retrying, '/admin/deliveries?status=retrying'],
                    ['Emails failed', d.releaseEmails?.failed, '/admin/deliveries?status=failed'],
                  ]}
                />
                <p className="text-sm text-foreground-muted">
                  Past due includes releases the worker could not complete (for example, a message with no remaining
                  recipients). An email the provider accepted is not counted as delivered.
                </p>
              </Panel>
              <Panel title="Background jobs" className="content-start">
                <Stats
                  items={[
                    ['Waiting', d.queues?.waiting, '/admin/system/queues'],
                    ['Active', d.queues?.active, '/admin/system/queues'],
                    ['Delayed', d.queues?.delayed, '/admin/system/queues'],
                    ['Failed', d.queues?.failed, '/admin/system/queues'],
                    ['Open dead letters', d.deadLetters?.open, '/admin/system/queues'],
                  ]}
                />
              </Panel>
              <Panel title="Security activity" className="content-start">
                <Stats
                  items={[
                    [
                      'Admin two-factor failures recorded, last 7 days',
                      d.security?.adminMfaFailuresLast7Days,
                      `/admin/security?category=mfa_failure&from=${localDay(-7)}`,
                    ],
                  ]}
                />
                <p className="text-sm text-foreground-muted">
                  Recorded audit rows. Customer sign-in failures and rate-limited requests are not recorded, so this is
                  not a count of all attempts.
                </p>
              </Panel>
            </div>
            <Services services={d.services} />
          </div>
        )}
      </QueryView>
    </>
  );
}

type Severity = 'action' | 'watch';
type Item = { label: string; value: number; severity: Severity; href?: string; action?: string };

/** Only real, non-zero signals; a section that failed to load is said so, never read as "all clear". */
function Attention({ d }: { d: AdminDashboard }) {
  const items: Item[] = [];
  const add = (value: number | undefined, item: Omit<Item, 'value'>) => {
    if (value) items.push({ ...item, value });
  };
  add(d.deathVerification?.readyForReview, {
    label: 'Death verification cases ready for review',
    severity: 'action',
    href: '/admin/death-verifications?status=READY_FOR_REVIEW',
    action: 'Review cases',
  });
  add(d.queues?.failed, {
    label: 'Failed background jobs',
    severity: 'action',
    href: '/admin/system/queues',
    action: 'Open queues',
  });
  add(d.deadLetters?.open, {
    label: 'Open dead letters',
    severity: 'action',
    href: '/admin/system/queues',
    action: 'Open queues',
  });
  add(d.releaseEmails?.failed, {
    label: 'Release emails that failed for good',
    severity: 'action',
    href: '/admin/deliveries?status=failed',
    action: 'Open deliveries',
  });
  add(d.releases?.pastDue, {
    label: 'Releases past due, not yet released',
    severity: 'watch',
    href: '/admin/releases?pastDue=true',
    action: 'Open releases',
  });
  add(d.releaseEmails?.retrying, {
    label: 'Release emails retrying',
    severity: 'watch',
    href: '/admin/deliveries?status=retrying',
    action: 'Open deliveries',
  });

  // Confirmed check failures only; stale or missing evidence is shown in System status.
  const down = SERVICES.filter((s) => s.key !== 'api' && isFailure(d.services[s.key as keyof typeof d.services])).map(
    (s) => s.name,
  );
  const missing = [
    !d.customers && 'customer accounts',
    !d.deathVerification && 'death verification',
    !d.releases && 'releases',
    !d.releaseEmails && 'release emails',
    !d.queues && 'background jobs',
    !d.deadLetters && 'dead letters',
    !d.security && 'security activity',
  ].filter(Boolean);

  return (
    <section aria-labelledby="attention-heading" className="grid gap-4">
      <h2 id="attention-heading" className="eyebrow font-sans">
        Attention required
      </h2>
      {down.length > 0 && (
        <p role="alert" className="flex items-start gap-2 rounded-lg bg-danger/8 px-4 py-3 text-sm text-danger">
          <CircleSlash aria-hidden strokeWidth={1.5} className="mt-0.5 size-4 shrink-0" />
          Health check failed: {down.join(', ')}.{' '}
          <Link href="/admin/system/health" className="underline underline-offset-4">
            View system health
          </Link>
        </p>
      )}
      {missing.length > 0 && (
        <p className="flex items-start gap-2 rounded-lg bg-warning/10 px-4 py-3 text-sm text-warning">
          <AlertTriangle aria-hidden strokeWidth={1.5} className="mt-0.5 size-4 shrink-0" />
          Couldn’t load {missing.join(', ')}. Those counts are shown as unavailable.
        </p>
      )}
      {items.length > 0 ? (
        <ul className="grid gap-3 md:grid-cols-2">
          {items.map((item) => (
            <li key={item.label}>
              <AttentionCard item={item} />
            </li>
          ))}
        </ul>
      ) : (
        down.length === 0 &&
        missing.length === 0 && (
          <p className="flex items-center gap-2 rounded-lg border border-border bg-surface px-4 py-3 text-sm text-foreground-secondary">
            <CheckCircle2 aria-hidden strokeWidth={1.5} className="size-4 shrink-0 text-success" />
            Nothing in these counts needs attention right now.
          </p>
        )
      )}
    </section>
  );
}

function AttentionCard({ item }: { item: Item }) {
  const body = (
    <>
      <span className="flex items-baseline gap-3">
        <span className="font-heading text-4xl leading-none tabular-nums">{item.value.toLocaleString('en-AU')}</span>
        <span
          className={cn(
            'rounded-full px-2.5 py-0.5 text-xs font-medium',
            item.severity === 'action' ? 'bg-danger/10 text-danger' : 'bg-warning/10 text-warning',
          )}
        >
          {item.severity === 'action' ? 'Needs action' : 'Keep an eye on'}
        </span>
      </span>
      <span className="text-[15px] break-words text-foreground-secondary">{item.label}</span>
      {item.href && (
        <span className="mt-auto inline-flex items-center gap-2 text-sm font-medium text-primary">
          {item.action}
          <ArrowRight aria-hidden strokeWidth={1.5} className="size-4 transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" />
        </span>
      )}
    </>
  );
  const box = 'flex h-full flex-col gap-3 rounded-xl border p-5';
  return item.href ? (
    <Link
      href={item.href}
      className={cn(
        box,
        'group border-primary/40 bg-primary-soft outline-none transition-colors hover:border-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-ring',
      )}
    >
      {body}
    </Link>
  ) : (
    <div className={cn(box, 'border-border bg-surface')}>{body}</div>
  );
}

/** A count, "Unavailable" when its source failed (never 0), linked only when a page lists it. */
function Stats({ items }: { items: [string, number | undefined, string?][] }) {
  return (
    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {items.map(([label, value, href]) => {
        const content = (
          <>
            {value === undefined ? (
              <span className="text-base font-medium text-warning">{UNAVAILABLE}</span>
            ) : (
              <span className="font-heading text-3xl leading-none tabular-nums">{value.toLocaleString('en-AU')}</span>
            )}
            <span className="text-sm break-words text-foreground-muted">{label}</span>
          </>
        );
        const box = 'flex h-full flex-col gap-2 rounded-lg border border-border p-4';
        return (
          <li key={label}>
            {href && value !== undefined ? (
              <Link
                href={href}
                className={cn(
                  box,
                  'outline-none hover:border-border-strong focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring',
                )}
              >
                {content}
              </Link>
            ) : (
              <div className={box}>{content}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Compact: one status per service from the shared definitions; details live on System health. */
function Services({ services }: { services: AdminDashboard['services'] }) {
  const all = { api: 'ok' as const, ...services };
  const verdict = overall(Object.values(services));
  return (
    <Panel title="System status">
      <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <span className="font-medium">{OVERALL_LABEL[verdict]}</span>
        <Link href="/admin/system/health" className={linkClass}>
          View system health
        </Link>
      </div>
      <ul className="flex flex-wrap gap-x-6 gap-y-2">
        {SERVICES.map((s) => (
          <li key={s.key} className="flex items-center gap-2 text-sm">
            <span className="text-foreground-secondary">{s.name}</span>
            <HealthBadge service={s.key} status={all[s.key]} />
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/** Today + offset days as YYYY-MM-DD in the viewer's timezone (the list's date filter format). */
function localDay(offset: number) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
