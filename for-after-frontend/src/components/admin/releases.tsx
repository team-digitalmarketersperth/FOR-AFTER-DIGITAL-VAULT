'use client';

import { AlertTriangle, CalendarClock, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { useState, type FormEvent, type ReactNode } from 'react';
import {
  Badge,
  CaseStatusBadge,
  DataTable,
  Facts,
  linkClass,
  Pager,
  Panel,
  SelectField,
  useFilterNav,
} from '@/components/admin/admin-ui';
import { TextField } from '@/components/shared/form-field';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyState, QueryView, Spinner } from '@/components/shared/states';
import { Button } from '@/components/ui/button';
import { useAdminRelease, useAdminReleases } from '@/hooks/use-admin';
import {
  RELEASE_STATUSES,
  RELEASE_TRIGGERS,
  type ReleaseDetail as Detail,
  type ReleaseFilters,
  type ReleaseStatus,
  type ReleaseTrigger,
} from '@/lib/api/admin';
import { ASSESSMENT, HISTORY_LABEL, shortId, TRIGGER_LABEL, UUID } from '@/lib/admin';
import { formatTimestamp, localToOffsetIso, timeZoneLabel } from '@/lib/format';
import { cn } from '@/lib/utils';

const BASE = '/admin/releases';
export const DATE = /^\d{4}-\d{2}-\d{2}$/;

const STATUS_LABEL: Record<ReleaseStatus, string> = {
  SCHEDULED: 'Scheduled',
  RELEASED: 'Released',
  CANCELLED: 'Cancelled',
};
const SORT_OPTIONS = [
  { value: 'updatedAt:desc', label: 'Last changed, newest first' },
  { value: 'createdAt:desc', label: 'Created, newest first' },
  { value: 'createdAt:asc', label: 'Created, oldest first' },
  { value: 'scheduledFor:asc', label: 'Scheduled time, earliest first' },
  { value: 'scheduledFor:desc', label: 'Scheduled time, latest first' },
];

/** The page keeps calendar days in the URL; the API gets ISO instants (local start/end of day). */
export type ReleaseUrlFilters = Omit<ReleaseFilters, 'scheduledFrom' | 'scheduledTo'> & { from?: string; to?: string };
const toApi = ({ from, to, ...rest }: ReleaseUrlFilters): ReleaseFilters => ({
  ...rest,
  scheduledFrom: from ? localToOffsetIso(from, '00:00') : undefined,
  scheduledTo: to ? localToOffsetIso(to, '23:59').replace('T23:59:00', 'T23:59:59.999') : undefined,
});

const AssessmentBadge = ({ a }: { a: keyof typeof ASSESSMENT }) => (
  // Long labels wrap on narrow screens instead of widening the page.
  <Badge tone={ASSESSMENT[a].tone} className="whitespace-normal">
    {ASSESSMENT[a].label}
  </Badge>
);
const when = (iso: string | null) => (iso ? formatTimestamp(iso) : '—');

/**
 * Read-only release monitoring: ids, states, trigger types and stored times
 * only (no titles, content or recipient details). The assessment is computed
 * by the API at a stated time; it is a snapshot, not permission to release.
 */
export function ReleaseList({ filters }: { filters: ReleaseUrlFilters }) {
  const list = useAdminReleases(toApi(filters));
  const nav = useFilterNav(BASE, filters);
  const filtered = Object.entries(filters).some(([k, v]) => k !== 'page' && k !== 'sort' && k !== 'dir' && v);
  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Releases"
        description="Operational metadata for scheduled and released messages: references, triggers, states and stored times. Never message content or recipient details."
      />
      <ReleaseFilterForm key={JSON.stringify(filters)} filters={filters} onApply={nav.set} />
      {list.data ? (
        <div className="grid gap-4" aria-busy={list.isFetching || undefined}>
          <Snapshot
            evaluatedAt={list.data.evaluatedAt}
            fetching={list.isFetching}
            failed={list.isError}
            onRefresh={() => void list.refetch()}
          />
          {list.data.items.length === 0 ? (
            <EmptyState
              icon={CalendarClock}
              title={filtered ? 'No releases match these filters' : 'No scheduled or released messages yet'}
              action={
                filtered ? (
                  <Link href={BASE} className={linkClass}>
                    Clear filters
                  </Link>
                ) : undefined
              }
            />
          ) : (
            <>
              <DataTable
                caption="Releases"
                rows={list.data.items}
                rowKey={(r) => r.reference}
                columns={[
                  {
                    header: 'Reference',
                    cell: (r) => (
                      <Link href={`${BASE}/${r.reference}`} className={cn(linkClass, 'font-mono text-xs')} title={r.reference}>
                        <span className="sr-only">Release </span>
                        {shortId(r.reference)}
                      </Link>
                    ),
                  },
                  {
                    header: 'Account',
                    cell: (r) => (
                      <Link href={`/admin/users/${r.accountId}`} className={cn(linkClass, 'font-mono text-xs')} title={r.accountId}>
                        <span className="sr-only">Account </span>
                        {shortId(r.accountId)}
                      </Link>
                    ),
                  },
                  { header: 'Trigger', cell: (r) => (r.triggerType ? TRIGGER_LABEL[r.triggerType] : '—') },
                  { header: 'Scheduled for', cell: (r) => when(r.scheduledFor) },
                  {
                    header: 'Assessment',
                    cell: (r) => (
                      <span className="grid gap-1">
                        <AssessmentBadge a={r.assessment} />
                        {r.assessment === 'past_due' && <span className="text-xs text-foreground-muted">Reason not recorded</span>}
                        {r.deathCaseStatus && (
                          <span className="text-xs text-foreground-muted">
                            Case: <CaseStatusBadge status={r.deathCaseStatus} />
                            {r.safeguardEndsAt && <> · safeguard ends {formatTimestamp(r.safeguardEndsAt)}</>}
                          </span>
                        )}
                      </span>
                    ),
                  },
                  { header: 'Released', cell: (r) => when(r.releasedAt) },
                  { header: 'Last recorded', cell: (r) => when(r.lastRecordedAt) },
                ]}
              />
              <Pager pagination={list.data.pagination} hrefFor={(page) => nav.href({ page })} />
            </>
          )}
        </div>
      ) : (
        <QueryView query={list} loadingLabel="Loading releases">
          {() => null}
        </QueryView>
      )}
    </>
  );
}

/** When the API assessed the rows; a failed refresh keeps them and says so. */
export function Snapshot({
  evaluatedAt,
  fetching,
  failed,
  onRefresh,
  note = 'A snapshot only: the worker re-checks every condition before it releases anything.',
}: {
  evaluatedAt: string;
  fetching: boolean;
  failed: boolean;
  onRefresh: () => void;
  note?: string;
}) {
  return (
    <div className="grid gap-3">
      {failed && (
        <p role="alert" className="flex items-start gap-2 rounded-lg bg-warning/10 px-4 py-3 text-sm text-warning">
          <AlertTriangle aria-hidden strokeWidth={1.5} className="mt-0.5 size-4 shrink-0" />
          Couldn’t refresh. These results are from {formatTimestamp(evaluatedAt)} and may be out of date.
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-foreground-muted">
        <p aria-live="polite">
          Assessed {formatTimestamp(evaluatedAt)} ({timeZoneLabel(new Date(evaluatedAt))}). {note}
        </p>
        <Button type="button" variant="outline" size="sm" disabled={fetching} onClick={onRefresh}>
          {fetching ? <Spinner /> : <RefreshCw aria-hidden strokeWidth={1.5} />}
          Refresh
        </Button>
      </div>
    </div>
  );
}

/** Applied on submit; ids and dates are checked before they reach the URL. */
function ReleaseFilterForm({
  filters,
  onApply,
}: {
  filters: ReleaseUrlFilters;
  onApply: (f: Partial<ReleaseUrlFilters>) => void;
}) {
  const [f, setF] = useState(filters);
  const [errors, setErrors] = useState<Partial<Record<'reference' | 'accountId' | 'to', string>>>({});
  const text = (k: 'reference' | 'accountId' | 'from' | 'to') => ({
    value: f[k] ?? '',
    error: errors[k as keyof typeof errors],
    onChange: (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value.trim() || undefined }),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const next: typeof errors = {};
    if (f.reference && !UUID.test(f.reference)) next.reference = 'Enter a full release reference.';
    if (f.accountId && !UUID.test(f.accountId)) next.accountId = 'Enter a full account ID.';
    if (f.from && f.to && f.from > f.to) next.to = 'Must be on or after the start date.';
    setErrors(next);
    if (Object.keys(next).length === 0) onApply({ ...f, page: undefined });
  };
  return (
    <form onSubmit={submit} noValidate aria-label="Filter releases" className="mb-8 grid gap-4 rounded-xl border border-border bg-surface p-5">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <SelectField
          id="status"
          label="Message status"
          value={f.status ?? ''}
          onChange={(e) => setF({ ...f, status: (e.target.value || undefined) as ReleaseStatus | undefined })}
          options={[{ value: '', label: 'Any' }, ...RELEASE_STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] }))]}
        />
        <SelectField
          id="triggerType"
          label="Trigger"
          value={f.triggerType ?? ''}
          onChange={(e) => setF({ ...f, triggerType: (e.target.value || undefined) as ReleaseTrigger | undefined })}
          options={[{ value: '', label: 'Any' }, ...RELEASE_TRIGGERS.map((t) => ({ value: t, label: TRIGGER_LABEL[t] }))]}
        />
        <SelectField
          id="sort"
          label="Sort"
          value={`${f.sort ?? 'updatedAt'}:${f.dir ?? 'desc'}`}
          onChange={(e) => {
            const [sort, dir] = e.target.value.split(':') as [ReleaseUrlFilters['sort'], ReleaseUrlFilters['dir']];
            setF({ ...f, sort, dir });
          }}
          options={SORT_OPTIONS}
        />
        <TextField id="from" label="Scheduled from" type="date" optional {...text('from')} />
        <TextField id="to" label="Scheduled to" type="date" optional {...text('to')} />
        <TextField
          id="reference"
          label="Release reference"
          optional
          maxLength={36}
          className="font-mono text-sm"
          {...text('reference')}
        />
        <TextField
          id="accountId"
          label="Account ID"
          optional
          maxLength={36}
          className="font-mono text-sm"
          {...text('accountId')}
        />
      </div>
      <label className="flex min-h-11 w-fit cursor-pointer items-center gap-3 text-sm">
        <input
          type="checkbox"
          className="size-4 accent-primary"
          checked={f.pastDue === 'true'}
          onChange={(e) => setF({ ...f, pastDue: e.target.checked ? 'true' : undefined })}
        />
        Only past due, not yet released
      </label>
      <p className="text-sm text-foreground-muted">
        Scheduled dates apply to fixed-date and custom-event schedules (days in {timeZoneLabel()}). Past due uses the
        same definition as the Overview.
      </p>
      <div className="flex flex-wrap gap-3">
        <Button type="submit">Apply filters</Button>
        <Button asChild variant="ghost">
          <Link href={BASE}>Clear</Link>
        </Button>
      </div>
    </form>
  );
}

// ─── Detail ─────────────────────────────────────────────────────────────────

const NOT_FOUND = { title: 'We couldn’t find this release', backHref: BASE, backLabel: 'Back to releases' };

/** Stored facts only; links go to existing admin pages (each keeps its own access rules and audit). */
export function ReleaseDetail({ reference }: { reference: string }) {
  const query = useAdminRelease(reference);
  return (
    <QueryView query={query} notFound={NOT_FOUND} loadingLabel="Loading release">
      {(d) => (
        <>
          <PageHeader back={{ href: BASE, label: 'Releases' }} eyebrow="Release" title={`Release ${shortId(d.reference)}`} />
          <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <div className="grid content-start gap-6">
              <Panel title="Current assessment">
                <div className="grid gap-2">
                  <AssessmentBadge a={d.assessment} />
                  <p className="text-[15px] text-foreground-secondary">{ASSESSMENT[d.assessment].description}</p>
                  {d.assessment === 'past_due' && (
                    <p className="text-sm font-medium text-foreground">Reason not recorded</p>
                  )}
                  <p className="text-sm text-foreground-muted">
                    Assessed {formatTimestamp(d.evaluatedAt)} ({timeZoneLabel(new Date(d.evaluatedAt))}) from stored
                    records. A snapshot only: the worker re-checks every condition before it releases anything.
                  </p>
                </div>
              </Panel>
              <Panel title="Current schedule">
                <Facts
                  items={[
                    ['Reference', <span key="r" className="font-mono text-xs break-all">{d.reference}</span>],
                    [
                      'Account',
                      <Link key="a" href={`/admin/users/${d.accountId}`} className={cn(linkClass, 'font-mono text-xs break-all')}>
                        {d.accountId}
                      </Link>,
                    ],
                    ['Message status', STATUS_LABEL[d.status]],
                    ['Trigger', d.schedule ? TRIGGER_LABEL[d.schedule.triggerType] : 'No schedule stored'],
                    ['Scheduled for', when(d.schedule?.scheduledFor ?? null)],
                    ['Days after death', d.schedule?.afterDeathDays ?? '—'],
                    ['Live recipients', d.liveRecipients],
                    ['Schedule last saved', when(d.schedule?.updatedAt ?? null)],
                  ]}
                />
              </Panel>
              <Panel title="Release record">
                {d.release ? (
                  <Facts
                    items={[
                      ['Release', <span key="id" className="font-mono text-xs break-all">{d.release.id}</span>],
                      ['Released at', formatTimestamp(d.release.releasedAt)],
                      ['Trigger used', TRIGGER_LABEL[d.release.triggerType]],
                      ['Recipient access grants', d.release.accessGrants],
                    ]}
                  />
                ) : (
                  <p className="text-[15px] text-foreground-secondary">No whole-message release is recorded.</p>
                )}
                {(d.occurrences.released > 0 || d.occurrences.pending > 0) && (
                  <Facts
                    items={[
                      ['Yearly occurrences released', d.occurrences.released],
                      ['Yearly occurrences pending', d.occurrences.pending],
                      ['Pending and due by now', d.occurrences.pastDue],
                      ['Next occurrence due', when(d.occurrences.nextDueAt)],
                    ]}
                  />
                )}
              </Panel>
              <History history={d.history} />
            </div>
            <div className="grid content-start gap-6">
              <DeathPanel d={d} />
              <Panel title="Release emails">
                <Facts
                  narrow
                  items={[
                    ['Waiting to send', d.releaseEmails.pending - d.releaseEmails.retrying],
                    ['Retrying after a failed attempt', d.releaseEmails.retrying],
                    ['Accepted by the email provider', d.releaseEmails.accepted],
                    ['Failed for good', d.releaseEmails.failed],
                  ]}
                />
                <p className="text-sm text-foreground-muted">Accepted is not confirmed delivery.</p>
                <Link href={`/admin/deliveries?releaseReference=${d.reference}`} className={cn(linkClass, 'w-fit text-sm')}>
                  View this release’s emails
                </Link>
              </Panel>
              <Panel title="Failed background jobs">
                {d.deadLetters.length === 0 ? (
                  <p className="text-[15px] text-foreground-secondary">No dead letters are recorded for this message.</p>
                ) : (
                  <ul className="grid gap-3">
                    {d.deadLetters.map((dl) => (
                      <li key={dl.id} className="grid gap-1 rounded-lg border border-border p-4 text-sm">
                        <span className="font-medium">{dl.queueName}</span>
                        <span className="text-foreground-muted">
                          {dl.errorCode ?? 'No error category'} · {formatTimestamp(dl.failedAt)} · {dl.failureCount}{' '}
                          {dl.failureCount === 1 ? 'failure' : 'failures'} · {dl.status.toLowerCase()}
                        </span>
                        <Link href={`/admin/system/queues?dlQueue=${encodeURIComponent(dl.queueName)}`} className={cn(linkClass, 'w-fit')}>
                          Open in Queues
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>
            </div>
          </div>
        </>
      )}
    </QueryView>
  );
}

function DeathPanel({ d }: { d: Detail }) {
  const caseId = d.deathCase?.id ?? d.deathActivation?.deathVerificationCaseId;
  if (!caseId) return null;
  const items: [string, ReactNode][] = [];
  if (d.deathCase) {
    items.push(
      ['Case status', <CaseStatusBadge key="s" status={d.deathCase.status} />],
      ['Opened', formatTimestamp(d.deathCase.openedAt)],
      ['Safeguard ends', when(d.deathCase.safeguardEndsAt)],
      ['Verified', when(d.deathCase.verifiedAt)],
    );
  }
  if (d.deathActivation) {
    items.push(
      ['Trigger activated', formatTimestamp(d.deathActivation.activatedAt)],
      ['Due', formatTimestamp(d.deathActivation.dueAt)],
    );
  }
  return (
    <Panel title="Death verification">
      <Facts narrow items={items} />
      <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
        <Link href={`/admin/death-verifications/${caseId}`} className={linkClass}>
          Open case
        </Link>
        <Link
          href={`/admin/audit-logs?subjectType=DeathVerificationCase&subjectId=${caseId}`}
          className={linkClass}
        >
          Case audit events
        </Link>
      </div>
    </Panel>
  );
}

function History({ history }: { history: Detail['history'] }) {
  return (
    <Panel title="Recorded history">
      {history.length === 0 ? (
        <p className="text-[15px] text-foreground-secondary">No events are recorded for this message.</p>
      ) : (
        <ol className="grid gap-3">
          {history.map((h, i) => (
            <li key={`${h.event}-${h.at}-${i}`} className="flex flex-wrap justify-between gap-x-4 gap-y-1 border-b border-border pb-3 text-sm last:border-0">
              <span>{HISTORY_LABEL[h.event]}</span>
              <time dateTime={h.at} className="text-foreground-muted">
                {formatTimestamp(h.at)}
              </time>
            </li>
          ))}
        </ol>
      )}
      <p className="text-sm text-foreground-muted">
        Only events with a stored time. Earlier schedules replaced by a change, and why the worker skipped a release,
        are not stored.
      </p>
    </Panel>
  );
}
