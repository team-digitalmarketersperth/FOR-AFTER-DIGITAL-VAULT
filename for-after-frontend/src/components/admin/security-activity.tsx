'use client';

import { AlertTriangle, CheckCircle2, ChevronDown, Fingerprint, Info, KeyRound, Layers, RefreshCw, ShieldCheck, ShieldX, type LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { Badge, DataTable, Facts, linkClass, Pager, Panel, SelectField, useFilterNav } from '@/components/admin/admin-ui';
import { IpControlsPanel } from '@/components/admin/ip-controls';
import { SecurityChart } from '@/components/admin/security-chart';
import { TextField } from '@/components/shared/form-field';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyState, QueryView, Spinner } from '@/components/shared/states';
import { Button } from '@/components/ui/button';
import { useIpBlocks, useSecurityEvent, useSecurityEvents } from '@/hooks/use-admin';
import {
  SECURITY_ACTOR_TYPES,
  SECURITY_CATEGORIES,
  SECURITY_OUTCOMES,
  type SecurityCategory,
  type SecurityEvent,
  type SecurityFilters,
  type SecurityOutcome,
} from '@/lib/api/admin';
import {
  AUDIT_ACTOR_LABEL,
  SECURITY_CATEGORY_LABEL,
  SECURITY_EVENT_LABEL,
  SECURITY_OUTCOME,
  securityReason,
  shortId,
  UUID,
} from '@/lib/admin';
import { formatDateTime, formatTimestamp, localToOffsetIso, timeZoneLabel, timeZoneName } from '@/lib/format';

const BASE = '/admin/security';

/** What the URL holds: dates as calendar days in the viewer's timezone. */
export type SecurityUrlFilters = Omit<SecurityFilters, 'tz'>;

const toApi = ({ from, to, ...rest }: SecurityUrlFilters): SecurityFilters => ({
  ...rest,
  from: from ? localToOffsetIso(from, '00:00') : undefined,
  to: to ? localToOffsetIso(to, '23:59').replace('T23:59:00', 'T23:59:59.999') : undefined,
  tz: timeZoneName(),
});

const Outcome = ({ outcome }: { outcome: SecurityOutcome }) => {
  const Icon = outcome === 'failed' ? AlertTriangle : CheckCircle2;
  return (
    <Badge tone={SECURITY_OUTCOME[outcome].tone} className="gap-1">
      <Icon aria-hidden strokeWidth={1.75} className="size-3.5" />
      {SECURITY_OUTCOME[outcome].label}
    </Badge>
  );
};

// Trusted = the extraction path was verified when the row was written. It never
// identifies a person or shows intent, and the stored value is always masked.
const Source = ({ network, trusted }: { network: string | null; trusted: boolean }) =>
  network ? (
    <span>
      <span className="font-mono text-sm">{network}</span>
      <span className="block text-xs text-foreground-muted">
        {trusted ? 'Trusted attribution' : 'Proxy attribution unverified'} · masked
      </span>
    </span>
  ) : (
    <span className="text-foreground-muted">Source unavailable</span>
  );

/** What this page can and cannot show, said once, plainly. */
function Coverage() {
  return (
    <details aria-label="Monitoring coverage" className="group rounded-xl bg-primary-soft px-4 py-3 text-sm text-foreground-secondary">
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-1 rounded-sm outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
        <Info aria-hidden strokeWidth={1.5} className="size-4 shrink-0 text-primary" />
        <span>Audit events are recorded rows, not every request.</span>
        <span className="inline-flex items-center gap-1 font-medium text-primary underline underline-offset-4">
          View coverage
          <ChevronDown aria-hidden strokeWidth={1.75} className="size-3.5 transition-transform group-open:rotate-180" />
        </span>
      </summary>
      <div className="mt-3 grid gap-2 border-t border-primary/15 pt-3">
        <p>
          <strong className="font-medium">Covered:</strong> admin sign-in steps and sign-out, admin two-factor failures and
          recovery-code use, two-factor setup, account suspensions and reactivations, password or email changes, and
          temporary IP blocks created or revoked. Rows are kept permanently and can’t be edited or deleted.
        </p>
        <p>
          <strong className="font-medium">Not recorded here:</strong> customer, recipient and trusted contact sign-in
          failures, one-time code failures and limits, rate-limited requests, rejected cross-site requests and requests
          refused by an IP block. Those only reach server logs or short-lived counters, so zero events here does not mean
          there were no attempts.
        </p>
      </div>
    </details>
  );
}

const CARDS: { label: string; category?: SecurityCategory; Icon: LucideIcon }[] = [
  { label: 'Total recorded events', Icon: Layers },
  { label: 'Admin sign-in and sign-out events', category: 'admin_sign_in', Icon: Fingerprint },
  { label: 'Admin two-factor failures', category: 'mfa_failure', Icon: ShieldX },
  { label: 'Recovery codes used', category: 'recovery_code', Icon: KeyRound },
];
const OTHER_CATEGORIES = SECURITY_CATEGORIES.filter((c) => !CARDS.some((k) => k.category === c));
const cardClass =
  'outline-none hover:border-border-strong focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring aria-[current]:border-primary';

const dayOffset = (days: number) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString('en-CA');
};
const PRESETS = [
  { value: 'today', label: 'Today', days: 0 },
  { value: '7', label: 'Last 7 days', days: 7 },
  { value: '30', label: 'Last 30 days', days: 30 },
  { value: '90', label: 'Last 90 days', days: 90 },
];

/** Refresh is read-only; other pages' Snapshot says "Assessed", this page's data is simply rows as of then. */
function HeaderControls({
  filters,
  ready,
  fetching,
  onRefresh,
  onRange,
}: {
  filters: SecurityUrlFilters;
  /** Today's date differs by zone: only compare it in the browser, once data has loaded. */
  ready: boolean;
  fetching: boolean;
  onRefresh: () => void;
  onRange: (r: { from?: string; to?: string }) => void;
}) {
  const custom = { value: 'custom', label: 'Custom range', days: -1 };
  const preset = !filters.from && !filters.to
    ? '30'
    : (ready && filters.to === dayOffset(0) && PRESETS.find((p) => p.days !== 30 && filters.from === dayOffset(-p.days))?.value) || custom.value;
  return (
    <div className="flex flex-wrap items-end gap-3">
      <SelectField
        id="range"
        label="Date range"
        value={preset}
        options={[...PRESETS, ...(preset === custom.value ? [custom] : [])]}
        onChange={(e) => {
          const p = PRESETS.find((x) => x.value === e.target.value);
          if (p) onRange(p.days === 30 ? { from: undefined, to: undefined } : { from: dayOffset(-p.days), to: dayOffset(0) });
        }}
      />
      <Button type="button" disabled={fetching} onClick={onRefresh} className="h-11">
        {fetching ? <Spinner /> : <RefreshCw aria-hidden strokeWidth={1.5} />}
        Refresh
      </Button>
    </div>
  );
}

/** Read-only. Block and revoke live in the IP controls panel and only act from their confirmation dialogs. */
export function SecurityList({ filters }: { filters: SecurityUrlFilters }) {
  const list = useSecurityEvents(toApi(filters));
  const blocks = useIpBlocks({ page: 1, status: 'active' });
  const nav = useFilterNav(BASE, filters);
  const filtered = Object.entries(filters).some(([k, v]) => k !== 'page' && !['from', 'to'].includes(k) && v);
  const dates = { from: filters.from, to: filters.to };
  const unfilteredBy = { page: undefined, category: undefined, outcome: undefined, actorType: undefined, reference: undefined, accountId: undefined };
  const data = list.data;
  const total = data ? SECURITY_CATEGORIES.reduce((n, c) => n + data.counts[c], 0) : 0;
  return (
    <>
      <PageHeader
        title="Security activity"
        description="Review recorded events and investigate unusual activity."
        action={
          <HeaderControls
            filters={filters}
            ready={!!data}
            fetching={list.isFetching || blocks.isFetching}
            onRefresh={() => {
              void list.refetch();
              void blocks.refetch();
            }}
            onRange={(r) => nav.set(r)}
          />
        }
      />
      <div className="grid gap-6">
        <div className={blocks.data && !blocks.data.controls.available ? 'grid items-start gap-3 lg:grid-cols-2' : 'grid gap-3'}>
          <Coverage />
          {blocks.data && !blocks.data.controls.available && (
            <p className="flex items-start gap-2 rounded-xl bg-warning/10 px-4 py-3 text-sm text-warning">
              <AlertTriangle aria-hidden strokeWidth={1.5} className="mt-0.5 size-4 shrink-0" />
              Unverified proxy sources can’t be blocked.
            </p>
          )}
        </div>
        {data ? (
          <div className="grid min-w-0 gap-6" aria-busy={list.isFetching || undefined}>
            {list.isError && (
              <p role="alert" className="flex items-start gap-2 rounded-lg bg-warning/10 px-4 py-3 text-sm text-warning">
                <AlertTriangle aria-hidden strokeWidth={1.5} className="mt-0.5 size-4 shrink-0" />
                Couldn’t refresh. These results are from {formatTimestamp(data.evaluatedAt)} and may be out of date.
              </p>
            )}
            <p aria-live="polite" className="-mt-2 text-sm text-foreground-muted">
              Last refreshed {formatTimestamp(data.evaluatedAt)} ({timeZoneLabel(new Date(data.evaluatedAt))}). Showing{' '}
              {formatDateTime(data.window.from)} to {formatDateTime(data.window.to)}.
            </p>
            <section aria-labelledby="security-summary" className="grid gap-3">
              <h2 id="security-summary" className="sr-only">
                Recorded events in this period
              </h2>
              <ul className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 xl:grid-cols-4">
                {CARDS.map(({ label, category, Icon }) => (
                  <li key={label}>
                    <Link
                      href={nav.href({ ...dates, ...unfilteredBy, category })}
                      aria-current={filtered && filters.category === category ? 'true' : undefined}
                      className={`flex h-full items-center gap-4 rounded-xl border border-border bg-surface p-5 ${cardClass}`}
                    >
                      <Icon aria-hidden strokeWidth={1.25} className="size-7 shrink-0 text-primary" />
                      <span className="grid min-w-0 gap-1">
                        <span className="text-sm text-foreground-secondary">{label}</span>
                        <span className="font-heading text-[32px] leading-none tabular-nums">
                          {(category ? data.counts[category] : total).toLocaleString('en-AU')}
                        </span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
              <ul aria-label="Other recorded categories" className="flex flex-wrap gap-2">
                {OTHER_CATEGORIES.map((c) => (
                  <li key={c}>
                    <Link
                      href={nav.href({ ...dates, ...unfilteredBy, category: c })}
                      aria-current={filters.category === c ? 'true' : undefined}
                      className={`inline-flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1.5 text-sm ${cardClass}`}
                    >
                      {SECURITY_CATEGORY_LABEL[c]}
                      <span className="font-medium tabular-nums">{data.counts[c].toLocaleString('en-AU')}</span>
                    </Link>
                  </li>
                ))}
              </ul>
              <p className="text-sm text-foreground-muted">
                The cards, the graph and source activity use the date range only. The events table also uses the filters
                above it. Covered event types only. One admin sign-in records several steps (password, two-factor,
                session start), so sign-in figures count recorded steps, not people or completed sign-ins.
              </p>
            </section>
            <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_21rem]">
              <Panel title="Recorded security events" className="min-w-0 sm:p-6">
                <SecurityChart series={data.series} />
              </Panel>
              <IpControlsPanel sources={data.sources} sourcesTrusted={data.sourcesTrusted} />
            </div>
            <Panel title="Recorded events" className="min-w-0 sm:p-6">
              <SecurityFilterForm key={JSON.stringify(filters)} filters={filters} onApply={nav.set} />
              {data.items.length === 0 ? (
                <EmptyState
                  icon={ShieldCheck}
                  title={filtered ? 'No recorded events match these filters' : 'No security events recorded in this period'}
                  description={filtered ? undefined : 'This only covers the event types listed above; it is not a sign that nothing was attempted.'}
                  action={
                    filtered ? (
                      <Link href={BASE} className={linkClass}>
                        Clear filters
                      </Link>
                    ) : undefined
                  }
                />
              ) : (
                <div className="min-w-0">
                  <DataTable
                    caption="Security events"
                    rows={data.items}
                    rowKey={(e) => e.reference}
                    columns={[
                      { header: 'Recorded', cell: (e) => <span className="whitespace-nowrap">{formatTimestamp(e.recordedAt)}</span> },
                      { header: 'Event', cell: (e) => SECURITY_EVENT_LABEL[e.eventType] ?? e.eventType },
                      { header: 'Outcome', cell: (e) => <Outcome outcome={e.outcome} /> },
                      { header: 'Actor', cell: (e) => <Actor e={e} /> },
                      {
                        header: 'Account',
                        cell: (e) => (e.accountId ? <span className="font-mono text-xs" title={e.accountId}>{shortId(e.accountId)}</span> : '—'),
                      },
                      { header: 'Source', cell: (e) => <Source network={e.network} trusted={e.sourceTrusted} /> },
                      {
                        header: 'Details',
                        cell: (e) => (
                          <Link
                            href={`${BASE}/${e.reference}`}
                            aria-label={`View details: ${SECURITY_EVENT_LABEL[e.eventType] ?? e.eventType}, ${formatTimestamp(e.recordedAt)}`}
                            className={linkClass}
                          >
                            View
                          </Link>
                        ),
                      },
                    ]}
                  />
                  <Pager pagination={data.pagination} hrefFor={(page) => nav.href({ page })} />
                </div>
              )}
            </Panel>
          </div>
        ) : (
          <QueryView query={list} loadingLabel="Loading security events">
            {() => null}
          </QueryView>
        )}
      </div>
    </>
  );
}

const Actor = ({ e }: { e: SecurityEvent }) => (
  <span title={e.actorUserId ?? undefined}>
    {AUDIT_ACTOR_LABEL[e.actorType] ?? e.actorType}
    {e.actorUserId && <span className="font-mono text-xs text-foreground-muted"> {shortId(e.actorUserId)}</span>}
  </span>
);

/** Event, outcome and actor apply when changed; ids and dates apply on submit, checked before they reach the URL. */
function SecurityFilterForm({ filters, onApply }: { filters: SecurityUrlFilters; onApply: (f: Partial<SecurityUrlFilters>) => void }) {
  const [f, setF] = useState(filters);
  const [errors, setErrors] = useState<Partial<Record<keyof SecurityUrlFilters, string>>>({});
  const field = (k: 'reference' | 'accountId' | 'from' | 'to') => ({
    value: f[k] ?? '',
    error: errors[k],
    onChange: (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value || undefined }),
  });
  const select = <K extends 'category' | 'outcome' | 'actorType'>(k: K) => ({
    value: filters[k] ?? '',
    onChange: (e: { target: { value: string } }) => onApply({ [k]: e.target.value || undefined }),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const t = { ...f, reference: f.reference?.trim() || undefined, accountId: f.accountId?.trim() || undefined };
    const next: typeof errors = {};
    if (t.reference && !UUID.test(t.reference)) next.reference = 'Enter a full event reference.';
    if (t.accountId && !UUID.test(t.accountId)) next.accountId = 'Enter a full account ID.';
    if (t.from && t.to && t.from > t.to) next.to = 'Must be on or after the start date.';
    setErrors(next);
    if (Object.keys(next).length === 0) onApply({ reference: t.reference, accountId: t.accountId, from: t.from, to: t.to });
  };
  const hasFilters = Object.entries(filters).some(([k, v]) => k !== 'page' && v);
  const moreOpen = !!(filters.reference || filters.accountId);
  return (
    <form onSubmit={submit} noValidate aria-label="Filter security events" className="grid gap-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <SelectField
          id="category"
          label="Event"
          {...select('category')}
          options={[{ value: '', label: 'All covered events' }, ...SECURITY_CATEGORIES.map((c) => ({ value: c, label: SECURITY_CATEGORY_LABEL[c] }))]}
        />
        <SelectField
          id="outcome"
          label="Outcome"
          {...select('outcome')}
          options={[{ value: '', label: 'Any outcome' }, ...SECURITY_OUTCOMES.map((o) => ({ value: o, label: SECURITY_OUTCOME[o].label }))]}
        />
        <SelectField
          id="actorType"
          label="Actor"
          {...select('actorType')}
          options={[{ value: '', label: 'Anyone' }, ...SECURITY_ACTOR_TYPES.map((a) => ({ value: a, label: AUDIT_ACTOR_LABEL[a] }))]}
        />
      </div>
      <details open={moreOpen || undefined} className="group">
        <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-sm text-sm font-medium text-primary outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
          More filters
          <ChevronDown aria-hidden strokeWidth={1.75} className="size-3.5 transition-transform group-open:rotate-180" />
        </summary>
        <div className="mt-4 grid gap-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <TextField id="reference" label="Event reference" spellCheck={false} className="font-mono" {...field('reference')} />
            <TextField id="accountId" label="Account ID" spellCheck={false} className="font-mono" {...field('accountId')} />
            <div className="grid grid-cols-2 gap-4">
              <TextField id="from" label="From" type="date" {...field('from')} />
              <TextField id="to" label="To" type="date" {...field('to')} />
            </div>
          </div>
          <p className="text-sm text-foreground-muted">Without dates: the last 30 days. Up to 366 days at a time.</p>
          <div>
            <Button type="submit">Apply filters</Button>
          </div>
        </div>
      </details>
      {hasFilters && (
        <Link href={BASE} className={`w-fit text-sm ${linkClass}`}>
          Clear filters
        </Link>
      )}
    </form>
  );
}

// ─── Detail ─────────────────────────────────────────────────────────────────

const NOT_FOUND = { title: 'We couldn’t find this security event', backHref: BASE, backLabel: 'Back to security activity' };

export function SecurityDetail({ reference }: { reference: string }) {
  const query = useSecurityEvent(reference);
  return (
    <QueryView query={query} notFound={NOT_FOUND} loadingLabel="Loading security event">
      {(e) => (
        <>
          <PageHeader
            back={{ href: BASE, label: 'Security activity' }}
            eyebrow="Security event"
            title={SECURITY_EVENT_LABEL[e.eventType] ?? e.eventType}
            description={formatDateTime(e.recordedAt)}
          />
          <div className="grid gap-6 lg:grid-cols-2">
            <Panel title="Event">
              <Facts
                items={[
                  ['Reference', <span key="r" className="font-mono text-sm break-all">{e.reference}</span>],
                  ['Recorded', formatDateTime(e.recordedAt)],
                  ['Category', SECURITY_CATEGORY_LABEL[e.category]],
                  ['Outcome', <Outcome key="o" outcome={e.outcome} />],
                  ['Reason', securityReason(e.reason)],
                  ['Actor', AUDIT_ACTOR_LABEL[e.actorType] ?? e.actorType],
                  [
                    'Actor account',
                    e.actorUserId ? (
                      <Link key="a" href={`/admin/users/${e.actorUserId}`} className={`font-mono text-sm break-all ${linkClass}`}>
                        {e.actorUserId}
                      </Link>
                    ) : null,
                  ],
                  [
                    'Account',
                    e.accountId ? (
                      <Link key="s" href={`/admin/users/${e.accountId}`} className={`font-mono text-sm break-all ${linkClass}`}>
                        {e.accountId}
                      </Link>
                    ) : null,
                  ],
                  ['Source', <Source key="n" network={e.network} trusted={e.sourceTrusted} />],
                ]}
              />
            </Panel>
            <div className="grid content-start gap-6">
              <Panel title="About this record">
                <ul className="grid list-disc gap-1.5 pl-5 text-sm text-foreground-secondary">
                  <li>{SECURITY_OUTCOME[e.outcome].description}</li>
                  <li>Accounts are the ones the server recorded, never an address someone typed.</li>
                  <li>
                    Source is a /24 or /48 network prefix as the API saw the request, never a full IP address, so it
                    can’t be used as a block target. Behind an unverified proxy it may be the proxy’s network.
                  </li>
                  <li>Passwords, codes, secrets, sessions, browser details and free-text notes are not shown.</li>
                </ul>
              </Panel>
              <nav aria-label="Related records" className="grid gap-2 text-sm">
                <Link href={`/admin/audit-logs/${e.reference}`} className={`w-fit ${linkClass}`}>
                  Same entry in the audit log
                </Link>
                {e.accountId && (
                  <Link href={`${BASE}?accountId=${e.accountId}`} className={`w-fit ${linkClass}`}>
                    All security events for this account
                  </Link>
                )}
              </nav>
            </div>
          </div>
        </>
      )}
    </QueryView>
  );
}
