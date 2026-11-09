import type { HealthStatus } from '@/lib/api/admin';

/**
 * The one set of System Health definitions (docs/admin.md §19), used by the
 * System Health page and the Overview summary so they can never disagree.
 */
export type ServiceKey = 'api' | 'database' | 'redis' | 'worker' | 'malwareScanner';

export const SERVICES: { key: ServiceKey; name: string; ok: string; proves: string }[] = [
  {
    key: 'api',
    name: 'API',
    ok: 'Responding',
    proves:
      'This API instance answered this request. Other API instances are not observed, and not every feature is exercised.',
  },
  {
    key: 'database',
    name: 'PostgreSQL',
    ok: 'Reachable',
    proves:
      'A trivial query through this instance’s connection pool. Proves connectivity from here, not query performance or data health.',
  },
  {
    key: 'redis',
    name: 'Redis',
    ok: 'Reachable',
    proves:
      'A ping on this instance’s session connection. Background queues use their own connection, which the worker heartbeat below is read through.',
  },
  {
    key: 'worker',
    name: 'Background worker',
    ok: 'Heartbeat recent',
    proves:
      'Each worker process writes a heartbeat every 15 seconds; recent means within 45. It shows a worker process is running, not that every queue is being processed. No heartbeat is an absence of evidence, not proof of a crash. No expected number of workers is configured, so none is assumed.',
  },
  {
    key: 'malwareScanner',
    name: 'Malware scanner',
    ok: 'Responding',
    proves:
      'A clamd PING to the configured scanner from this API instance; no file is sent. It does not show that signatures are current or that a scan would succeed. Uploads stay fail-closed whatever this shows.',
  },
];

type Tone = 'done' | 'warning' | 'danger' | 'neutral';

/** Label and tone; "ok" uses the service's own wording (never a blanket "Healthy"). */
export const statusInfo = (key: ServiceKey, status: HealthStatus): { label: string; tone: Tone } => {
  switch (status) {
    case 'ok':
      return { label: SERVICES.find((s) => s.key === key)!.ok, tone: 'done' };
    case 'failed':
      return { label: 'Check failed', tone: 'danger' };
    case 'timed_out':
      return { label: 'Timed out', tone: 'danger' };
    case 'stale':
      return { label: 'Heartbeat stale', tone: 'warning' };
    case 'missing':
      return { label: 'No heartbeat seen', tone: 'warning' };
    case 'unknown':
      return { label: 'Unknown', tone: 'warning' };
    case 'not_configured':
      return { label: 'Not configured', tone: 'neutral' };
  }
};

/** Confirmed check failures (a check ran and failed or timed out). */
export const isFailure = (s: HealthStatus) => s === 'failed' || s === 'timed_out';
/** Not a failure, but not evidence of health either. */
export const isIncomplete = (s: HealthStatus) => s === 'stale' || s === 'missing' || s === 'unknown' || s === 'not_configured';

export type Overall = 'issues' | 'incomplete' | 'ok';
export const overall = (statuses: HealthStatus[]): Overall =>
  statuses.some(isFailure) ? 'issues' : statuses.some(isIncomplete) ? 'incomplete' : 'ok';

export const OVERALL_LABEL: Record<Overall, string> = {
  issues: 'Issues detected',
  incomplete: 'Monitoring incomplete',
  ok: 'No issues in these checks',
};
