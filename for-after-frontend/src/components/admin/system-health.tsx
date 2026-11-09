'use client';

import { AlertTriangle, CheckCircle2, CircleDashed, CircleSlash, HelpCircle, RefreshCw, type LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { linkClass, Panel } from '@/components/admin/admin-ui';
import { PageHeader } from '@/components/shared/page-header';
import { QueryView, Spinner } from '@/components/shared/states';
import { Button } from '@/components/ui/button';
import { useSystemHealth } from '@/hooks/use-admin';
import type { HealthStatus, SystemHealth } from '@/lib/api/admin';
import { formatTimestamp, timeZoneLabel } from '@/lib/format';
import { OVERALL_LABEL, overall, SERVICES, statusInfo, type Overall, type ServiceKey } from '@/lib/system-health';
import { cn } from '@/lib/utils';

const TONE = {
  done: { icon: CheckCircle2, cls: 'text-success' },
  danger: { icon: CircleSlash, cls: 'text-danger' },
  warning: { icon: AlertTriangle, cls: 'text-warning' },
  neutral: { icon: CircleDashed, cls: 'text-foreground-muted' },
} satisfies Record<string, { icon: LucideIcon; cls: string }>;

/** A service status as icon + text (never colour alone). Shared with the Overview. */
export function HealthBadge({ service, status }: { service: ServiceKey; status: HealthStatus }) {
  const info = statusInfo(service, status);
  const tone = TONE[info.tone];
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-sm font-medium', tone.cls)}>
      <tone.icon aria-hidden strokeWidth={1.75} className="size-4 shrink-0" />
      {info.label}
    </span>
  );
}

const OVERALL_TONE: Record<Overall, { icon: LucideIcon; cls: string }> = {
  issues: { icon: CircleSlash, cls: 'bg-danger/8 text-danger' },
  incomplete: { icon: HelpCircle, cls: 'bg-warning/10 text-warning' },
  ok: { icon: CheckCircle2, cls: 'bg-success/10 text-success' },
};

export const statusesOf = (h: Pick<SystemHealth, 'database' | 'redis' | 'worker' | 'malwareScanner'>): HealthStatus[] => [
  h.database.status,
  h.redis.status,
  h.worker.status,
  h.malwareScanner.status,
];

/**
 * Admin System Health: what this API instance can observe, with what each check
 * does and does not prove. Read-only; refreshed by hand (no polling).
 */
export function SystemHealthPage() {
  const query = useSystemHealth();
  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="System health"
        description="Checks run by the API instance that answers this page, plus the background workers’ heartbeats. Observations, not guarantees."
      />
      {query.data ? <Health h={query.data} refreshedAt={query.dataUpdatedAt} query={query} /> : (
        <QueryView query={query} loadingLabel="Running health checks">
          {() => null}
        </QueryView>
      )}
    </>
  );
}

function Health({
  h,
  refreshedAt,
  query,
}: {
  h: SystemHealth;
  refreshedAt: number;
  query: ReturnType<typeof useSystemHealth>;
}) {
  const verdict = overall(statusesOf(h));
  const Icon = OVERALL_TONE[verdict].icon;
  return (
    <div className="grid gap-6" aria-busy={query.isFetching || undefined}>
      {query.isError && (
        <p role="alert" className="flex items-start gap-2 rounded-lg bg-warning/10 px-4 py-3 text-sm text-warning">
          <AlertTriangle aria-hidden strokeWidth={1.5} className="mt-0.5 size-4 shrink-0" />
          Couldn’t refresh. These results are from the check at {formatTimestamp(h.checkedAt)} and may be out of date.
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-foreground-muted">
        <p aria-live="polite" className="grid gap-0.5">
          <span>
            Checked by the server {formatTimestamp(h.checkedAt)} ({timeZoneLabel(new Date(h.checkedAt))})
          </span>
          <span>Received by this browser {formatTimestamp(new Date(refreshedAt).toISOString())}</span>
        </p>
        <Button type="button" variant="outline" size="sm" disabled={query.isFetching} onClick={() => void query.refetch()}>
          {query.isFetching ? <Spinner /> : <RefreshCw aria-hidden strokeWidth={1.5} />}
          Refresh
        </Button>
      </div>
      <p className={cn('flex items-start gap-2 rounded-lg px-4 py-3 text-sm font-medium', OVERALL_TONE[verdict].cls)}>
        <Icon aria-hidden strokeWidth={1.75} className="mt-0.5 size-4 shrink-0" />
        <span>
          {OVERALL_LABEL[verdict]}
          <span className="font-normal"> · covers this API instance and the workers that report a heartbeat.</span>
        </span>
      </p>
      <ul aria-label="Services" className="grid gap-3">
        {SERVICES.map((s) => (
          <li key={s.key} className="grid gap-2 rounded-xl border border-border bg-surface p-5 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)] sm:gap-6">
            <div className="grid content-start gap-1">
              <span className="font-medium">{s.name}</span>
              <HealthBadge service={s.key} status={h[s.key].status} />
            </div>
            <div className="grid gap-2 text-sm">
              <Detail h={h} service={s.key} />
              <p className="text-foreground-muted">{s.proves}</p>
              {s.key === 'malwareScanner' && (
                <Link href="/admin/storage?uploadState=failed" className={`w-fit ${linkClass}`}>
                  Upload check outcomes on Storage & scans
                </Link>
              )}
            </div>
          </li>
        ))}
      </ul>
      <Panel title="Monitoring limits">
        <ul className="grid list-disc gap-1.5 pl-5 text-sm text-foreground-secondary">
          <li>Each check runs from the API instance that answered; other API replicas are not observed.</li>
          <li>Checks time out after 2 seconds. Results are shared for 5 seconds, so repeated refreshes reuse one check.</li>
          <li>No history is kept here: this is the current observation only.</li>
          <li>Email and SMS providers are not probed (no test sends).</li>
          <li>
            The AI provider is not probed either; observed companion traffic is on{' '}
            <Link href="/admin/system/ai" className={linkClass}>
              AI operations
            </Link>
            .
          </li>
        </ul>
      </Panel>
    </div>
  );
}

function Detail({ h, service }: { h: SystemHealth; service: ServiceKey }) {
  if (service === 'worker') {
    const w = h.worker;
    return (
      <p className="text-foreground">
        {w.reportingWorkers === null ? 'Reporting workers: unknown' : `Reporting workers: ${w.reportingWorkers}`}
        {' · '}
        Last heartbeat: {w.lastSeenAt ? formatTimestamp(w.lastSeenAt) : 'none seen'}
        {' · '}
        Stale after {w.staleAfterSeconds} s
      </p>
    );
  }
  const c = h[service];
  const duration = 'durationMs' in c && c.durationMs !== null ? ` · ${c.durationMs} ms` : '';
  return (
    <p className="text-foreground">
      {service === 'api' ? 'Answered' : 'Checked'} {formatTimestamp(c.checkedAt)}
      {duration}
    </p>
  );
}
