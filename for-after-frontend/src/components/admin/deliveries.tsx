'use client';

import { AlertTriangle, Info, Mail } from 'lucide-react';
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
import { Snapshot } from '@/components/admin/releases';
import { FilterChips, TextField } from '@/components/shared/form-field';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyState, QueryView } from '@/components/shared/states';
import { Button } from '@/components/ui/button';
import { useAdminDeliveries, useReleaseEmail, useSafetyNotice } from '@/hooks/use-admin';
import {
  ERROR_CATEGORIES,
  RELEASE_EMAIL_STATUSES,
  SAFETY_NOTICE_STATUSES,
  type DeliveryFilters,
  type ErrorCategory,
  type ReleaseEmailItem,
  type ReleaseEmailStatus,
  type SafetyNoticeItem,
  type SafetyNoticeStatus,
} from '@/lib/api/admin';
import {
  ERROR_CATEGORY_LABEL,
  RELEASE_EMAIL_STATUS,
  SAFETY_NOTICE_STATUS,
  shortId,
  UUID,
} from '@/lib/admin';
import { formatTimestamp, localToOffsetIso, timeZoneLabel } from '@/lib/format';
import { cn } from '@/lib/utils';

const BASE = '/admin/deliveries';

/** The page keeps calendar days in the URL; the API gets ISO instants (local start/end of day). */
export type DeliveryUrlFilters = Omit<DeliveryFilters, 'createdFrom' | 'createdTo'> & { from?: string; to?: string };
const toApi = ({ from, to, ...rest }: DeliveryUrlFilters): DeliveryFilters => ({
  ...rest,
  createdFrom: from ? localToOffsetIso(from, '00:00') : undefined,
  createdTo: to ? localToOffsetIso(to, '23:59').replace('T23:59:00', 'T23:59:59.999') : undefined,
});

const when = (iso: string | null) => (iso ? formatTimestamp(iso) : '—');
const mono = cn(linkClass, 'font-mono text-xs');
const EmailStatus = ({ s }: { s: ReleaseEmailStatus }) => (
  <Badge tone={RELEASE_EMAIL_STATUS[s].tone} className="whitespace-normal">
    {RELEASE_EMAIL_STATUS[s].label}
  </Badge>
);
const NoticeStatus = ({ s }: { s: SafetyNoticeStatus }) => (
  <Badge tone={SAFETY_NOTICE_STATUS[s].tone} className="whitespace-normal">
    {SAFETY_NOTICE_STATUS[s].label}
  </Badge>
);
const Uncertain = () => (
  <Badge tone="warning" className="whitespace-normal">
    Last attempt: outcome uncertain
  </Badge>
);

/** What this page can and cannot show, said once, plainly. */
function Coverage() {
  return (
    <aside aria-label="Coverage" className="mb-8 flex gap-3 rounded-xl bg-primary-soft p-5 text-sm text-foreground-secondary">
      <Info aria-hidden strokeWidth={1.5} className="mt-0.5 size-4 shrink-0 text-primary" />
      <div className="grid gap-1">
        <p>
          Covers the two deliveries For After records durably: <strong>release emails</strong> (“a message is waiting
          for you”) and the <strong>death-verification safety notice</strong>. Both are email.
        </p>
        <p>
          Not covered: Trusted Contact invitations, one-time codes, account emails and any SMS. Their outcomes are
          only in server logs. Nothing here is marked “Delivered”: no provider confirms inbox delivery, so the
          strongest status is “Accepted by the email provider”.
        </p>
      </div>
    </aside>
  );
}

/**
 * Read-only delivery monitoring: references, states, counts, times and safe
 * failure categories only. No address, subject, body, link or provider text,
 * and no resend or retry control (failed jobs stay on the Queues page).
 */
export function DeliveryList({ filters }: { filters: DeliveryUrlFilters }) {
  const category = filters.category ?? 'release_email';
  const list = useAdminDeliveries(toApi({ ...filters, category }));
  const nav = useFilterNav(BASE, filters);
  const filtered = Object.entries(filters).some(([k, v]) => !['page', 'sort', 'dir', 'category'].includes(k) && v);
  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Deliveries"
        description="Recorded delivery intents and their stored outcome, by reference. Never message content, addresses or links."
      />
      <Coverage />
      <FilterChips
        label="Delivery type"
        chips={[
          { label: 'Release emails', href: BASE, active: category === 'release_email' },
          { label: 'Safety notices', href: `${BASE}?category=safety_notice`, active: category === 'safety_notice' },
        ]}
      />
      <DeliveryFilterForm key={JSON.stringify(filters)} filters={{ ...filters, category }} onApply={nav.set} />
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
              icon={Mail}
              title={
                filtered
                  ? 'No deliveries match these filters'
                  : category === 'release_email'
                    ? 'No release emails recorded yet'
                    : 'No safety notices recorded yet'
              }
              action={
                filtered ? (
                  <Link href={category === 'release_email' ? BASE : `${BASE}?category=safety_notice`} className={linkClass}>
                    Clear filters
                  </Link>
                ) : undefined
              }
            />
          ) : (
            <>
              {list.data.category === 'release_email' ? (
                <ReleaseEmailTable rows={list.data.items} />
              ) : (
                <SafetyNoticeTable rows={list.data.items} />
              )}
              <Pager pagination={list.data.pagination} hrefFor={(page) => nav.href({ page })} />
            </>
          )}
        </div>
      ) : (
        <QueryView query={list} loadingLabel="Loading deliveries">
          {() => null}
        </QueryView>
      )}
    </>
  );
}

function ReleaseEmailTable({ rows }: { rows: ReleaseEmailItem[] }) {
  return (
    <DataTable
      caption="Release emails"
      rows={rows}
      rowKey={(r) => r.reference}
      columns={[
        {
          header: 'Reference',
          cell: (r) => (
            <Link href={`${BASE}/release-emails/${r.reference}`} className={mono} title={r.reference}>
              <span className="sr-only">Delivery </span>
              {shortId(r.reference)}
            </Link>
          ),
        },
        {
          header: 'Release',
          cell: (r) => (
            <Link href={`/admin/releases/${r.releaseReference}`} className={mono} title={r.releaseReference}>
              <span className="sr-only">Release </span>
              {shortId(r.releaseReference)}
            </Link>
          ),
        },
        {
          header: 'Recipient',
          cell: (r) => (
            <span className="grid gap-0.5">
              <span className="break-all">{r.destination ?? 'No email recorded'}</span>
              <span className="font-mono text-xs text-foreground-muted" title={r.recipientReference}>
                {shortId(r.recipientReference)}
              </span>
            </span>
          ),
        },
        {
          header: 'Status',
          cell: (r) => (
            <span className="grid gap-1">
              <EmailStatus s={r.status} />
              {r.lastAttemptUncertain && <Uncertain />}
            </span>
          ),
        },
        { header: 'Attempts', cell: (r) => r.attemptCount },
        { header: 'Last error', cell: (r) => (r.errorCategory ? ERROR_CATEGORY_LABEL[r.errorCategory] : '—') },
        { header: 'Accepted', cell: (r) => when(r.acceptedAt) },
        { header: 'Created', cell: (r) => when(r.createdAt) },
        { header: 'Last updated', cell: (r) => when(r.updatedAt) },
      ]}
    />
  );
}

function SafetyNoticeTable({ rows }: { rows: SafetyNoticeItem[] }) {
  return (
    <DataTable
      caption="Safety notices"
      rows={rows}
      rowKey={(r) => r.reference}
      columns={[
        {
          header: 'Reference',
          cell: (r) => (
            <Link href={`${BASE}/safety-notices/${r.reference}`} className={mono} title={r.reference}>
              <span className="sr-only">Delivery </span>
              {shortId(r.reference)}
            </Link>
          ),
        },
        {
          header: 'Account',
          cell: (r) => (
            <Link href={`/admin/users/${r.accountId}`} className={mono} title={r.accountId}>
              <span className="sr-only">Account </span>
              {shortId(r.accountId)}
            </Link>
          ),
        },
        { header: 'Status', cell: (r) => <NoticeStatus s={r.status} /> },
        { header: 'Case', cell: (r) => <CaseStatusBadge status={r.caseStatus} /> },
        { header: 'Attempts', cell: (r) => r.attemptCount },
        { header: 'Last attempt started', cell: (r) => when(r.lastAttemptAt) },
        { header: 'Accepted', cell: (r) => when(r.acceptedAt) },
        { header: 'Case opened', cell: (r) => when(r.createdAt) },
      ]}
    />
  );
}

/** Applied on submit; ids and dates are checked before they reach the URL. */
function DeliveryFilterForm({
  filters,
  onApply,
}: {
  filters: DeliveryUrlFilters;
  onApply: (f: Partial<DeliveryUrlFilters>) => void;
}) {
  const [f, setF] = useState(filters);
  const [errors, setErrors] = useState<Partial<Record<'reference' | 'releaseReference' | 'to', string>>>({});
  const email = f.category !== 'safety_notice';
  const statuses = email ? RELEASE_EMAIL_STATUSES : SAFETY_NOTICE_STATUSES;
  const statusLabel = (s: string) =>
    email ? RELEASE_EMAIL_STATUS[s as ReleaseEmailStatus].label : SAFETY_NOTICE_STATUS[s as SafetyNoticeStatus].label;
  const text = (k: 'reference' | 'releaseReference' | 'from' | 'to') => ({
    value: f[k] ?? '',
    error: errors[k as keyof typeof errors],
    onChange: (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value.trim() || undefined }),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const next: typeof errors = {};
    if (f.reference && !UUID.test(f.reference)) next.reference = 'Enter a full delivery reference.';
    if (f.releaseReference && !UUID.test(f.releaseReference)) next.releaseReference = 'Enter a full release reference.';
    if (f.from && f.to && f.from > f.to) next.to = 'Must be on or after the start date.';
    setErrors(next);
    if (Object.keys(next).length === 0) onApply({ ...f, page: undefined });
  };
  return (
    <form onSubmit={submit} noValidate aria-label="Filter deliveries" className="mb-8 grid gap-4 rounded-xl border border-border bg-surface p-5">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <SelectField
          id="status"
          label="Recorded status"
          value={f.status ?? ''}
          onChange={(e) => setF({ ...f, status: (e.target.value || undefined) as DeliveryFilters['status'] })}
          options={[{ value: '', label: 'Any' }, ...statuses.map((s) => ({ value: s, label: statusLabel(s) }))]}
        />
        {email && (
          <SelectField
            id="errorCategory"
            label="Last error"
            value={f.errorCategory ?? ''}
            onChange={(e) => setF({ ...f, errorCategory: (e.target.value || undefined) as ErrorCategory | undefined })}
            options={[{ value: '', label: 'Any' }, ...ERROR_CATEGORIES.map((c) => ({ value: c, label: ERROR_CATEGORY_LABEL[c] }))]}
          />
        )}
        <SelectField
          id="sort"
          label="Sort"
          value={`${f.sort ?? 'createdAt'}:${f.dir ?? 'desc'}`}
          onChange={(e) => {
            const [sort, dir] = e.target.value.split(':') as [DeliveryUrlFilters['sort'], DeliveryUrlFilters['dir']];
            setF({ ...f, sort, dir });
          }}
          options={[
            { value: 'createdAt:desc', label: 'Created, newest first' },
            { value: 'createdAt:asc', label: 'Created, oldest first' },
            { value: 'updatedAt:desc', label: 'Last updated, newest first' },
          ]}
        />
        <TextField id="from" label="Created from" type="date" optional {...text('from')} />
        <TextField id="to" label="Created to" type="date" optional {...text('to')} />
        <TextField
          id="reference"
          label={email ? 'Delivery reference' : 'Case reference'}
          optional
          maxLength={36}
          className="font-mono text-sm"
          {...text('reference')}
        />
        {email && (
          <TextField
            id="releaseReference"
            label="Release reference"
            optional
            maxLength={36}
            className="font-mono text-sm"
            {...text('releaseReference')}
          />
        )}
      </div>
      {email && (
        <label className="flex min-h-11 w-fit cursor-pointer items-center gap-3 text-sm">
          <input
            type="checkbox"
            className="size-4 accent-primary"
            checked={f.outcomeUncertain === 'true'}
            onChange={(e) => setF({ ...f, outcomeUncertain: e.target.checked ? 'true' : undefined })}
          />
          Only where the last attempt’s outcome is uncertain
        </label>
      )}
      <p className="text-sm text-foreground-muted">
        Created = when the delivery was recorded (days in {timeZoneLabel()}).
      </p>
      <div className="flex flex-wrap gap-3">
        <Button type="submit">Apply filters</Button>
        <Button asChild variant="ghost">
          <Link href={email ? BASE : `${BASE}?category=safety_notice`}>Clear</Link>
        </Button>
      </div>
    </form>
  );
}

// ─── Details ────────────────────────────────────────────────────────────────

const NOT_FOUND = { title: 'We couldn’t find this delivery', backHref: BASE, backLabel: 'Back to deliveries' };
const HISTORY: Record<string, string> = {
  intent_created: 'Delivery recorded',
  provider_accepted: 'Accepted by the email provider',
  failed_for_good: 'Failed for good',
  dead_lettered: 'Background job failed for good (dead letter)',
  case_opened: 'Case opened',
  last_attempt_started: 'Most recent attempt started',
};
const QUEUE_STATE: Record<string, string> = {
  waiting: 'Waiting in the queue',
  delayed: 'Retry scheduled (time not shown)',
  active: 'Attempt in progress',
  completed: 'Completed in the queue',
  failed: 'Failed in the queue',
  prioritized: 'Waiting in the queue',
  'waiting-children': 'Waiting in the queue',
  missing: 'No job in the queue (finished and removed, or never queued)',
};

function History({ history, note }: { history: { at: string; event: string }[]; note: ReactNode }) {
  return (
    <Panel title="Recorded history">
      {history.length === 0 ? (
        <p className="text-[15px] text-foreground-secondary">No events are recorded.</p>
      ) : (
        <ol className="grid gap-3">
          {history.map((h, i) => (
            <li key={`${h.event}-${h.at}-${i}`} className="flex flex-wrap justify-between gap-x-4 gap-y-1 border-b border-border pb-3 text-sm last:border-0">
              <span>{HISTORY[h.event] ?? h.event}</span>
              <time dateTime={h.at} className="text-foreground-muted">
                {formatTimestamp(h.at)}
              </time>
            </li>
          ))}
        </ol>
      )}
      <p className="text-sm text-foreground-muted">{note}</p>
    </Panel>
  );
}

const Assessed = ({ at }: { at: string }) => (
  <p className="text-sm text-foreground-muted">
    Read {formatTimestamp(at)} ({timeZoneLabel(new Date(at))}) from stored records.
  </p>
);

/** One release email: stored fields, optional queue state, dead letters. */
export function ReleaseEmailDetail({ reference }: { reference: string }) {
  const query = useReleaseEmail(reference);
  return (
    <QueryView query={query} notFound={NOT_FOUND} loadingLabel="Loading delivery">
      {(d) => (
        <>
          <PageHeader back={{ href: BASE, label: 'Deliveries' }} eyebrow="Release email" title={`Delivery ${shortId(d.reference)}`} />
          <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <div className="grid content-start gap-6">
              <Panel title="Recorded status">
                <div className="grid gap-2">
                  <div className="flex flex-wrap gap-2">
                    <EmailStatus s={d.status} />
                    {d.lastAttemptUncertain && <Uncertain />}
                  </div>
                  <p className="text-[15px] text-foreground-secondary">{RELEASE_EMAIL_STATUS[d.status].description}</p>
                  {d.lastAttemptUncertain && (
                    <p role="note" className="flex items-start gap-2 rounded-lg bg-warning/10 px-4 py-3 text-sm text-warning">
                      <AlertTriangle aria-hidden strokeWidth={1.5} className="mt-0.5 size-4 shrink-0" />
                      The last attempt timed out or lost its connection, so the provider may already have sent it. A
                      retry can deliver a second copy; do not treat it as safe to resend.
                    </p>
                  )}
                  <Assessed at={d.evaluatedAt} />
                </div>
              </Panel>
              <Panel title="Delivery">
                <Facts
                  items={[
                    ['Reference', <span key="r" className="font-mono text-xs break-all">{d.reference}</span>],
                    ['Channel', 'Email'],
                    [
                      'Release',
                      <Link key="rel" href={`/admin/releases/${d.releaseReference}`} className={cn(mono, 'break-all')}>
                        {d.releaseReference}
                      </Link>,
                    ],
                    ['Recipient (masked)', d.destination ?? 'No email recorded'],
                    ['Recipient reference', <span key="rr" className="font-mono text-xs break-all">{d.recipientReference}</span>],
                    ['Yearly occurrence', d.occurrence ? `${d.occurrence.occurrenceYear} (due ${formatTimestamp(d.occurrence.dueAt)})` : 'No (whole-message release)'],
                    ['Attempts recorded', d.attemptCount],
                    ['Last error', d.errorCategory ? ERROR_CATEGORY_LABEL[d.errorCategory] : '—'],
                    ['Accepted at', when(d.acceptedAt)],
                    ['Failed for good at', when(d.failedAt)],
                    ['Provider message id', d.providerMessageId ? <span key="p" className="font-mono text-xs break-all">{d.providerMessageId}</span> : '—'],
                    ['Created', formatTimestamp(d.createdAt)],
                    ['Last updated', formatTimestamp(d.updatedAt)],
                  ]}
                />
                <p className="text-sm text-foreground-muted">
                  The provider message id identifies an accepted request; it is not a delivery receipt.
                </p>
              </Panel>
              <History
                history={d.history}
                note="Only the attempt count and the last error are stored, not each attempt. Earlier errors are overwritten."
              />
            </div>
            <div className="grid content-start gap-6">
              <Panel title="Queue">
                {d.queueJob === undefined ? (
                  <p className="text-[15px] text-foreground-secondary">Not looked up: the email was already accepted.</p>
                ) : d.queueJob === null ? (
                  <p role="status" className="text-[15px] text-warning">
                    Queue data is unavailable right now. The stored record above is unaffected.
                  </p>
                ) : (
                  <Facts
                    narrow
                    items={[
                      ['Job state', QUEUE_STATE[d.queueJob.state] ?? d.queueJob.state],
                      [
                        'Queue attempts',
                        d.queueJob.attemptsMade === null ? '—' : `${d.queueJob.attemptsMade} of ${d.queueJob.maxAttempts}`,
                      ],
                    ]}
                  />
                )}
              </Panel>
              <Panel title="Failed background jobs">
                {d.deadLetters.length === 0 ? (
                  <p className="text-[15px] text-foreground-secondary">No dead letters are recorded for this email.</p>
                ) : (
                  <ul className="grid gap-3">
                    {d.deadLetters.map((dl) => (
                      <li key={dl.id} className="grid gap-1 rounded-lg border border-border p-4 text-sm">
                        <span className="text-foreground-muted">
                          {formatTimestamp(dl.failedAt)} · {dl.failureCount} {dl.failureCount === 1 ? 'failure' : 'failures'} ·{' '}
                          {dl.status.toLowerCase()}
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

/** One case's safety notice: the case's own fields and its SAFETY_NOTICE_SENT events. */
export function SafetyNoticeDetail({ reference }: { reference: string }) {
  const query = useSafetyNotice(reference);
  return (
    <QueryView query={query} notFound={NOT_FOUND} loadingLabel="Loading delivery">
      {(d) => (
        <>
          <PageHeader
            back={{ href: `${BASE}?category=safety_notice`, label: 'Deliveries' }}
            eyebrow="Safety notice"
            title={`Notice for case ${shortId(d.reference)}`}
          />
          <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <div className="grid content-start gap-6">
              <Panel title="Recorded status">
                <div className="grid gap-2">
                  <NoticeStatus s={d.status} />
                  <p className="text-[15px] text-foreground-secondary">{SAFETY_NOTICE_STATUS[d.status].description}</p>
                  <Assessed at={d.evaluatedAt} />
                </div>
              </Panel>
              <Panel title="Delivery">
                <Facts
                  items={[
                    ['Case', <span key="c" className="font-mono text-xs break-all">{d.reference}</span>],
                    ['Channel', 'Email'],
                    [
                      'Account',
                      <Link key="a" href={`/admin/users/${d.accountId}`} className={cn(mono, 'break-all')}>
                        {d.accountId}
                      </Link>,
                    ],
                    ['Case status', <CaseStatusBadge key="s" status={d.caseStatus} />],
                    ['Attempts started', d.attemptCount],
                    ['Most recent attempt started', when(d.lastAttemptAt)],
                    ['Accepted at', when(d.acceptedAt)],
                  ]}
                />
              </Panel>
              <History
                history={d.history}
                note="Only the attempt count, the most recent attempt time and the accepted time are stored; failure reasons are only in server logs."
              />
            </div>
            <div className="grid content-start gap-6">
              <Panel title="Case">
                <p className="text-sm text-foreground-secondary">
                  {d.caseEvents.length === 0
                    ? 'No “safety notice sent” event is recorded on the case.'
                    : `${d.caseEvents.length} “safety notice sent” ${d.caseEvents.length === 1 ? 'event' : 'events'} on the case timeline.`}
                </p>
                <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
                  <Link href={`/admin/death-verifications/${d.reference}`} className={linkClass}>
                    Open case
                  </Link>
                  <Link href={`/admin/audit-logs?subjectType=DeathVerificationCase&subjectId=${d.reference}`} className={linkClass}>
                    Case audit events
                  </Link>
                </div>
              </Panel>
            </div>
          </div>
        </>
      )}
    </QueryView>
  );
}
