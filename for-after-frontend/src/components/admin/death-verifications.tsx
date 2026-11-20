'use client';

import { useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowRight,
  Clock,
  FileSearch,
  Hourglass,
  Info,
  RefreshCw,
  Search,
  ShieldCheck,
  Users,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import {
  Badge,
  CaseStatusBadge,
  DataTable,
  Facts,
  linkClass,
  Pager,
  Panel,
  SegmentedBar,
  SelectField,
  SummaryCard,
  useFilterNav,
  UserStatusBadge,
} from '@/components/admin/admin-ui';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { FilterChips, TextAreaField } from '@/components/shared/form-field';
import { SearchBox } from '@/components/shared/list-controls';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyState, QueryView, Spinner } from '@/components/shared/states';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useDeathCase, useDeathCases, useRejectDeath, useVerifyDeath } from '@/hooks/use-admin';
import { useOpenSignedFile } from '@/hooks/use-portals';
import {
  adminApi,
  DECISION_NOTE_MAX,
  type CaseFilters,
  type CasePage,
  type DeathCaseDetail,
  type DeathCaseSummary,
} from '@/lib/api/admin';
import type { ApiError } from '@/lib/api/errors';
import type { CaseStatus } from '@/lib/api/portals';
import { CASE_EVENT_LABEL, SAFETY_NOTICE_STATUS, shortId } from '@/lib/admin';
import { ADMIN_STATUS } from '@/lib/death-verification';
import { adminKeys } from '@/lib/query/query-client';
import {
  formatBytes,
  formatCalendarDate,
  formatDate,
  formatDateTime,
  formatTimestamp,
  localToOffsetIso,
  timeZoneLabel,
} from '@/lib/format';
import { cn } from '@/lib/utils';

const BASE = '/admin/death-verifications';

// Decision work first, then open cases, then closed ones. Each case has exactly one
// persisted status, so these categories never overlap and always add up to the total.
const FILTER_ORDER: CaseStatus[] = [
  'READY_FOR_REVIEW',
  'SAFEGUARD_ACTIVE',
  'PENDING_VERIFICATION',
  'VERIFIED',
  'REJECTED',
  'CANCELLED',
];
const OPEN_TABS: CaseStatus[] = ['READY_FOR_REVIEW', 'SAFEGUARD_ACTIVE', 'PENDING_VERIFICATION'];
const CLOSED: CaseStatus[] = ['VERIFIED', 'REJECTED', 'CANCELLED'];
const SHORT: Record<CaseStatus, string> = {
  READY_FOR_REVIEW: 'Ready',
  SAFEGUARD_ACTIVE: 'Safeguard',
  PENDING_VERIFICATION: 'Pending',
  VERIFIED: 'Verified',
  REJECTED: 'Rejected',
  CANCELLED: 'Cancelled',
};
// Muted, distinct fills; the legend always carries the name, count and percent.
const FILL: Record<CaseStatus, string> = {
  READY_FOR_REVIEW: 'bg-primary',
  SAFEGUARD_ACTIVE: 'bg-brand-gold',
  PENDING_VERIFICATION: 'bg-brand-lilac-grey',
  VERIFIED: 'bg-success/70',
  REJECTED: 'bg-brand-bronze/60',
  CANCELLED: 'bg-brand-stone',
};

const count = (n: number) => n.toLocaleString('en-AU');
const plural = (n: number, one: string, many: string) => `${count(n)} ${n === 1 ? one : many}`;

/**
 * The Safeguard column, from recorded timestamps and the case's status, compared
 * with the server's time: never the browser clock, and never "waiting" once closed.
 */
export function safeguardText(c: DeathCaseSummary, serverNow: string): string {
  if (c.status === 'REJECTED' || c.status === 'CANCELLED') return 'Closed';
  if (c.status === 'PENDING_VERIFICATION') return 'Not started';
  if (!c.safeguardEndsAt) return 'Unavailable';
  const ends = formatTimestamp(c.safeguardEndsAt);
  if (c.status === 'SAFEGUARD_ACTIVE') {
    return Date.parse(c.safeguardEndsAt) > Date.parse(serverNow) ? `Ends ${ends}` : `Ended ${ends}, status not updated yet`;
  }
  return `Ended ${ends}`;
}

export function CaseList({ filters }: { filters: CaseFilters }) {
  const list = useDeathCases(filters);
  const nav = useFilterNav(BASE, filters);
  const data = list.data;
  return (
    <>
      <PageHeader
        title="Death verification"
        description="Review trusted-contact reports with care."
        action={
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <Button type="button" variant="outline" className="h-11" disabled={list.isFetching} onClick={() => void list.refetch()}>
              {list.isFetching ? <Spinner /> : <RefreshCw aria-hidden strokeWidth={1.5} />}
              Refresh
            </Button>
            {data && (
              <p aria-live="polite" className="text-sm text-foreground-muted">
                Last updated {formatTimestamp(data.evaluatedAt)}
                <span className="block text-xs">{timeZoneLabel(new Date(data.evaluatedAt))}</span>
              </p>
            )}
          </div>
        }
      />
      <p className="mb-6 flex items-start gap-3 rounded-xl bg-primary-soft px-4 py-3 text-sm text-foreground">
        <ShieldCheck aria-hidden strokeWidth={1.5} className="mt-0.5 size-4 shrink-0 text-primary" />
        <span>
          A case can be decided only once it is Ready for review: the safety notice was accepted by the email provider and the
          safeguard period ended without the account holder responding. Verifying also needs the required trusted-contact
          confirmations, and every condition is checked again on the server when a decision is made.
        </span>
      </p>
      {data ? (
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-6" aria-busy={list.isFetching || undefined}>
          {list.isError && (
            <p role="alert" className="flex items-start gap-2 rounded-lg bg-warning/10 px-4 py-3 text-sm text-warning">
              <AlertTriangle aria-hidden strokeWidth={1.5} className="mt-0.5 size-4 shrink-0" />
              Couldn’t refresh. Showing results from {formatTimestamp(data.evaluatedAt)}, which may be out of date or not match
              the current filters.
            </p>
          )}
          <Overview data={data} filters={filters} nav={nav} />
          <Queue data={data} filters={filters} nav={nav} />
          <WorkflowGuide />
        </div>
      ) : (
        <QueryView query={list} loadingLabel="Loading cases">
          {() => null}
        </QueryView>
      )}
    </>
  );
}

type Nav = ReturnType<typeof useFilterNav<CaseFilters>>;

function Overview({ data, filters, nav }: { data: CasePage; filters: CaseFilters; nav: Nav }) {
  const { counts } = data;
  const total = FILTER_ORDER.reduce((n, s) => n + counts[s], 0);
  const scope = filters.search ? `Cases matching “${filters.search}”, all time, every status` : 'All cases, all time, every status';
  const statusHref = (status: CaseStatus) => nav.href({ status, page: undefined });
  return (
    <>
      <section aria-labelledby="case-summary" className="grid gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="case-summary" className="sr-only">
            Case summary
          </h2>
          <p className="flex items-center gap-2 text-sm text-foreground-muted">
            <Info aria-hidden strokeWidth={1.5} className="size-4 shrink-0" />
            {scope}
          </p>
        </div>
        <ul className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 xl:grid-cols-4">
          <li>
            <SummaryCard icon={Users} label="Total cases" value={count(total)} />
          </li>
          <li>
            <SummaryCard icon={FileSearch} label={ADMIN_STATUS.READY_FOR_REVIEW.label} value={count(counts.READY_FOR_REVIEW)} />
          </li>
          <li>
            <SummaryCard icon={Clock} label={ADMIN_STATUS.SAFEGUARD_ACTIVE.label} value={count(counts.SAFEGUARD_ACTIVE)} />
          </li>
          <li>
            <SummaryCard icon={Hourglass} label={ADMIN_STATUS.PENDING_VERIFICATION.label} value={count(counts.PENDING_VERIFICATION)} />
          </li>
        </ul>
      </section>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <section aria-labelledby="case-overview" className="grid content-start gap-5 rounded-xl border border-border bg-surface p-5 sm:p-7">
          <h2 id="case-overview" className="text-2xl">
            Case overview
          </h2>
          <SegmentedBar
            what="cases"
            segments={FILTER_ORDER.map((s) => ({
              key: s,
              label: ADMIN_STATUS[s].label,
              short: SHORT[s],
              n: counts[s],
              fill: FILL[s],
              ink: s === 'READY_FOR_REVIEW' ? 'text-primary-foreground' : undefined,
            }))}
          />
        </section>
        <section aria-labelledby="review-priorities" className="grid content-start gap-4 rounded-xl border border-border bg-surface p-5 sm:p-7">
          <h2 id="review-priorities" className="text-2xl">
            Review priorities
          </h2>
          <ul className="grid gap-2">
            <Priority icon={FileSearch} href={statusHref('READY_FOR_REVIEW')} active={filters.status === 'READY_FOR_REVIEW'}
              n={counts.READY_FOR_REVIEW} text="ready for review">
              {counts.READY_FOR_REVIEW > 0 &&
                (data.readyAwaitingConfirmations === null
                  ? 'Confirmation check unavailable'
                  : data.readyAwaitingConfirmations > 0
                    ? `${plural(data.readyAwaitingConfirmations, 'needs', 'need')} another confirmation before verifying`
                    : null)}
            </Priority>
            <Priority icon={Clock} href={statusHref('SAFEGUARD_ACTIVE')} active={filters.status === 'SAFEGUARD_ACTIVE'}
              n={counts.SAFEGUARD_ACTIVE} text="in the safeguard period" />
            <Priority icon={Hourglass} href={statusHref('PENDING_VERIFICATION')} active={filters.status === 'PENDING_VERIFICATION'}
              n={counts.PENDING_VERIFICATION} text="waiting for the safety notice" />
          </ul>
          <p className="flex items-start gap-2 border-t border-border pt-4 text-sm text-foreground-muted">
            <Info aria-hidden strokeWidth={1.5} className="mt-0.5 size-4 shrink-0" />
            No case is approved automatically.
          </p>
        </section>
      </div>
    </>
  );
}

function Priority({
  icon: Icon,
  href,
  active,
  n,
  text,
  children,
}: {
  icon: LucideIcon;
  href: string;
  active: boolean;
  n: number;
  text: string;
  children?: ReactNode;
}) {
  const body = (
    <>
      <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary">
        <Icon strokeWidth={1.5} className="size-4" />
      </span>
      <span className="grid">
        <span>
          <span className="font-heading text-xl tabular-nums">{count(n)}</span> {text}
        </span>
        {children && <span className="text-sm text-foreground-muted">{children}</span>}
      </span>
    </>
  );
  return (
    <li>
      {n > 0 ? (
        <Link
          href={href}
          scroll={false}
          aria-current={active ? 'true' : undefined}
          className="flex items-start gap-3 rounded-lg p-1.5 text-[15px] outline-none hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring aria-[current=true]:bg-primary-soft"
        >
          {body}
        </Link>
      ) : (
        <p className="flex items-start gap-3 p-1.5 text-[15px] text-foreground-muted">{body}</p>
      )}
    </li>
  );
}

const NOTICE_TONE = { queued: 'neutral', attempted: 'warning', provider_accepted: 'done', not_sent_case_closed: 'neutral' } as const;

function Queue({ data, filters, nav }: { data: CasePage; filters: CaseFilters; nav: Nav }) {
  const { items, pagination, counts, evaluatedAt } = data;
  const total = FILTER_ORDER.reduce((n, s) => n + counts[s], 0);
  const filtered = !!(filters.search || filters.status);
  const clearAll = () => nav.set({ search: undefined, status: undefined });
  const closedSelected = filters.status && CLOSED.includes(filters.status) ? filters.status : '';
  return (
    <section aria-labelledby="case-queue" className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5 rounded-xl border border-border bg-surface p-5 sm:p-7">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="case-queue" className="text-2xl">
          Case review queue
        </h2>
        <Badge>{plural(pagination.total, 'case', 'cases')}</Badge>
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
        <SearchBox
          value={filters.search}
          onSearch={(search) => nav.set({ search })}
          label="Search account or case ID"
          placeholder="Name, email or full case ID"
          maxLength={254}
        />
        <div className="flex flex-wrap items-end gap-3">
          <FilterChips
            label="Filter by status"
            className="mb-0"
            chips={[
              { label: `All ${count(total)}`, href: nav.href({ status: undefined, page: undefined }), active: !filters.status },
              ...OPEN_TABS.map((s) => ({
                label: `${SHORT[s]} ${count(counts[s])}`,
                href: nav.href({ status: s, page: undefined }),
                active: filters.status === s,
              })),
            ]}
          />
          <SelectField
            id="more-statuses"
            label="More statuses"
            value={closedSelected}
            onChange={(e) => nav.set({ status: (e.target.value || undefined) as CaseStatus | undefined })}
            options={[
              { value: '', label: closedSelected ? 'Open statuses' : 'Choose…' },
              ...CLOSED.map((s) => ({ value: s, label: `${ADMIN_STATUS[s].label} (${count(counts[s])})` })),
            ]}
          />
        </div>
      </div>
      {filtered && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-foreground-muted">Filtered by</span>
          {filters.status && <Badge>Status: {ADMIN_STATUS[filters.status].label}</Badge>}
          {filters.search && (
            <Badge className="max-w-full">
              <span className="truncate">Search: “{filters.search}”</span>
            </Badge>
          )}
          <Button type="button" variant="link" size="sm" onClick={clearAll}>
            Clear filters
          </Button>
        </div>
      )}
      <p className="text-xs text-foreground-muted">Times in {timeZoneLabel(new Date(evaluatedAt))}. Newest cases first.</p>
      {items.length === 0 ? (
        pagination.total > 0 ? (
          <EmptyState
            heading="h3"
            icon={ShieldCheck}
            title="This page is past the end of the list"
            action={
              <Button asChild variant="outline">
                <Link href={nav.href({ page: undefined })}>Go to the first page</Link>
              </Button>
            }
          />
        ) : filtered ? (
          <EmptyState
            heading="h3"
            icon={Search}
            title={filters.status === 'READY_FOR_REVIEW' && !filters.search ? 'No cases ready for review' : 'No cases match these filters'}
            action={
              <Button type="button" variant="outline" onClick={clearAll}>
                Clear filters
              </Button>
            }
          />
        ) : (
          <EmptyState heading="h3" icon={ShieldCheck} title="No death reports yet" description="Cases appear here when a trusted contact reports a death." />
        )
      ) : (
        <div>
          <DataTable
            caption="Death verification cases"
            rows={items}
            rowKey={(c) => c.caseId}
            columns={[
              {
                header: 'Account holder',
                cell: (c) => (
                  <span className="grid min-w-0 gap-0.5">
                    <span className="font-medium break-words">{c.accountHolder.displayName ?? 'No name'}</span>
                    <span className="text-[13px] break-all text-foreground-muted">{c.accountHolder.email}</span>
                    <span className="text-xs text-foreground-muted">
                      Opened {formatDate(c.openedAt)} · Ref <span className="font-mono">{shortId(c.caseId)}</span>
                    </span>
                  </span>
                ),
              },
              {
                header: 'Case status',
                cell: (c) => (
                  <span className="grid gap-1">
                    <CaseStatusBadge status={c.status} />
                    {c.status === 'READY_FOR_REVIEW' && !c.confirmationRequirementMet && (
                      <span className="text-xs text-foreground-muted">
                        {c.requiredConfirmations === null
                          ? 'No confirmation requirement recorded'
                          : `Confirmations ${c.receivedConfirmations} of ${c.requiredConfirmations}`}
                      </span>
                    )}
                  </span>
                ),
              },
              {
                header: 'Safety notice',
                cell: (c) => <Badge tone={NOTICE_TONE[c.safetyNotice]}>{SAFETY_NOTICE_STATUS[c.safetyNotice].label}</Badge>,
              },
              { header: 'Safeguard', cell: (c) => <span className="text-sm">{safeguardText(c, evaluatedAt)}</span> },
              { header: 'Reports', cell: (c) => <span className="tabular-nums">{c.reportCount}</span> },
              {
                header: 'Action',
                cell: (c) => {
                  const label = c.status === 'READY_FOR_REVIEW' ? 'Review case' : 'View case';
                  return (
                    <Link href={`${BASE}/${c.caseId}`} className={cn(linkClass, 'inline-flex items-center gap-1 whitespace-nowrap')}>
                      {label}
                      <span className="sr-only">: {c.accountHolder.displayName ?? c.accountHolder.email}</span>
                      <ArrowRight aria-hidden strokeWidth={1.5} className="size-4" />
                    </Link>
                  );
                },
              },
            ]}
          />
          <Pager pagination={pagination} hrefFor={(page) => nav.href({ page })} />
        </div>
      )}
    </section>
  );
}

const STEPS: [string, string][] = [
  ['Report received', 'A trusted contact reports a death. Nothing is released and no decision is made.'],
  [
    'Safety notice',
    'The account holder is emailed. "Accepted by the email provider" is not proof it was read. If they confirm they are alive, the case is cancelled.',
  ],
  ['Safeguard period', 'A fixed waiting period starts when the notice is accepted. Its end never verifies a case.'],
  ['Manual decision', 'An admin verifies or rejects. Verifying also needs the required confirmations; the server re-checks every condition.'],
];

function WorkflowGuide() {
  return (
    <section aria-labelledby="review-safeguards" className="grid gap-5 rounded-xl border border-border bg-surface p-5 sm:p-7 lg:grid-cols-[minmax(0,1fr)_minmax(0,3fr)]">
      <div className="grid content-start gap-2">
        <h2 id="review-safeguards" className="text-2xl">
          Review safeguards
        </h2>
        <p className="text-sm text-foreground-muted">Workflow guide only. Each case follows its own recorded state, and other checks may apply.</p>
      </div>
      <ol className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {STEPS.map(([title, text], i) => (
          <li key={title} className="flex gap-3">
            <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-full bg-primary-soft text-sm font-semibold text-primary">
              {i + 1}
            </span>
            <span className="grid gap-1">
              <span className="font-medium">{title}</span>
              <span className="text-sm text-foreground-muted">{text}</span>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

// ─── Detail ─────────────────────────────────────────────────────────────────

const NOT_FOUND = { title: 'We couldn’t find this case', backHref: BASE, backLabel: 'Back to cases' };

const ACTOR: Record<DeathCaseDetail['auditEvents'][number]['actorType'], string> = {
  SYSTEM: 'System',
  CUSTOMER: 'Account holder',
  TRUSTED_CONTACT: 'Trusted contact',
  ADMIN: 'Admin',
};

/**
 * Everything the API returns for review: account holder, reports (with the
 * reporter's note), the case's own event trail and death-trigger activations.
 * Never Message, Memory Vault, My Story or My Wishes content.
 */
export function CaseDetail({ id }: { id: string }) {
  const query = useDeathCase(id);
  // Set when a decision lost a race (e.g. the account holder confirmed alive).
  const [changed, setChanged] = useState<string | null>(null);
  return (
    <QueryView query={query} notFound={NOT_FOUND} loadingLabel="Loading case">
      {(c) => {
        const name = c.accountHolder.displayName ?? c.accountHolder.email;
        return (
          <>
            <PageHeader back={{ href: BASE, label: 'Death verification' }} eyebrow="Death verification case" title={name} />
            {changed && (
              <div className="mb-6">
                <Alert>
                  <AlertTriangle aria-hidden />
                  <AlertTitle>This case changed while you were reviewing it</AlertTitle>
                  <AlertDescription>
                    {changed} The case below has been refreshed and shows its current status.
                  </AlertDescription>
                </Alert>
              </div>
            )}
            <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
              <div className="grid content-start gap-6">
                <Panel title="Status">
                  <div className="grid gap-2">
                    <CaseStatusBadge status={c.status} />
                    <p className="text-[15px] text-foreground-secondary">{ADMIN_STATUS[c.status].description}</p>
                  </div>
                  <Facts
                    items={[
                      ['Opened', formatDateTime(c.openedAt)],
                      ['Safety notice sent', c.safetyNoticeSentAt ? formatDateTime(c.safetyNoticeSentAt) : 'Not yet'],
                      ['Safeguard ends', c.safeguardEndsAt ? formatDateTime(c.safeguardEndsAt) : '—'],
                      ['Reports', c.reportCount],
                      ['Confirmations', <Confirmations key="cf" c={c} />],
                    ]}
                  />
                </Panel>
                <Panel title="Reports">
                  <ol className="grid gap-4">
                    {c.reports.map((r, i) => (
                      <li key={r.id} className="grid gap-3 rounded-lg border border-border p-4">
                        <p className="eyebrow">Report {i + 1}</p>
                        <Facts
                          items={[
                            ['Reported by', [r.reporterFirstNameSnapshot, r.reporterLastNameSnapshot].filter(Boolean).join(' ')],
                            ['Contact', [r.reporterEmailNormalized, r.reporterMobileNormalized].filter(Boolean).join(' · ') || '—'],
                            ['Reported date of death', r.reportedDateOfDeath ? formatCalendarDate(r.reportedDateOfDeath) : 'Not given'],
                            ['Submitted', formatDateTime(r.createdAt)],
                          ]}
                        />
                        {r.note && (
                          <div className="grid gap-1">
                            <p className="text-xs font-medium tracking-wide text-foreground-muted uppercase">Note from the reporter</p>
                            <p className="text-[15px] whitespace-pre-wrap">{r.note}</p>
                          </div>
                        )}
                      </li>
                    ))}
                  </ol>
                </Panel>
                <Panel title="Supporting evidence">
                  <EvidenceList c={c} />
                </Panel>
                <Panel title="Timeline">
                  {c.auditEvents.length === 0 ? (
                    <p className="text-[15px] text-foreground-muted">No events have been recorded for this case.</p>
                  ) : (
                    <ol className="grid gap-0 border-l border-border pl-5">
                      {c.auditEvents.map((e, i) => (
                        <li key={i} className="relative pb-5 last:pb-0">
                          <span aria-hidden className="absolute top-1.5 -left-[25px] size-2.5 rounded-full bg-primary ring-4 ring-surface" />
                          <p className="text-[15px]">{CASE_EVENT_LABEL[e.eventType] ?? e.eventType}</p>
                          <p className="text-sm text-foreground-muted">
                            {formatDateTime(e.createdAt)} · {ACTOR[e.actorType] ?? e.actorType}
                          </p>
                        </li>
                      ))}
                    </ol>
                  )}
                </Panel>
                {c.activations.length > 0 && (
                  <Panel title="Death-triggered messages">
                    <p className="text-sm text-foreground-muted">
                      Scheduled by the account holder and released by the system after verification. Contents are never shown here.
                    </p>
                    <DataTable
                      caption="Death-triggered message activations"
                      rows={c.activations}
                      rowKey={(a) => a.messageId}
                      columns={[
                        { header: 'Message', cell: (a) => <span className="font-mono text-xs" title={a.messageId}>{shortId(a.messageId)}</span> },
                        { header: 'Trigger', cell: (a) => (a.triggerType === 'ON_DEATH' ? 'On death' : 'After death') },
                        { header: 'Due', cell: (a) => formatDateTime(a.dueAt) },
                        { header: 'Status', cell: (a) => a.messageStatus.toLowerCase() },
                      ]}
                    />
                  </Panel>
                )}
              </div>

              <div className="grid content-start gap-6">
                <Panel title="Decision">
                  <Decision c={c} name={name} onConflict={setChanged} />
                </Panel>
                <Panel title="Account holder">
                  <Facts
                    narrow
                    items={[
                      ['Name', c.accountHolder.displayName ?? '—'],
                      ['Email', c.accountHolder.email],
                      ['Account status', <UserStatusBadge key="s" status={c.accountHolder.accountStatus} />],
                    ]}
                  />
                  <Link href={`/admin/users/${c.accountHolder.userId}`} className={`w-fit ${linkClass}`}>
                    Open the account
                  </Link>
                </Panel>
              </div>
            </div>
          </>
        );
      }}
    </QueryView>
  );
}

/**
 * Phase 19B: independent Trusted Contact reports (distinct people) against the
 * number snapshotted when the case opened. A prerequisite for verify only:
 * meeting it verifies nothing. Evidence is separate and never counts.
 */
function Confirmations({ c }: { c: DeathCaseDetail }) {
  if (c.requiredConfirmations === null) return <span className="text-foreground-muted">Not recorded (older case)</span>;
  const shown = Math.min(c.receivedConfirmations, c.requiredConfirmations);
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span>
        {shown} of {c.requiredConfirmations}
      </span>
      <span className={c.confirmationRequirementMet ? 'text-success' : 'text-foreground-muted'}>
        {c.confirmationRequirementMet ? 'Confirmation requirement satisfied' : 'Confirmation requirement pending'}
      </span>
    </span>
  );
}

const EVIDENCE_TYPE: Record<string, string> = { 'application/pdf': 'PDF', 'image/jpeg': 'JPEG', 'image/png': 'PNG' };
const EVIDENCE_STATE = { READY: 'Ready for review', PENDING_UPLOAD: 'Upload not finished', FAILED: 'Upload failed checks' };

/**
 * Phase 19A: metadata from the case detail; a file opens only through a
 * short-lived signed URL fetched on click (recorded on the timeline).
 * Supporting material: it is never a condition for, or a cause of, a decision.
 */
function EvidenceList({ c }: { c: DeathCaseDetail }) {
  const qc = useQueryClient();
  const open = useOpenSignedFile((evidenceId) => adminApi.evidenceAccessUrl(c.caseId, evidenceId));
  if (c.evidence.length === 0) {
    return <p className="text-[15px] text-foreground-muted">No evidence has been uploaded for this case.</p>;
  }
  const reportNumber = (reportId: string) => c.reports.findIndex((r) => r.id === reportId) + 1;
  return (
    <div className="grid gap-3">
      <p className="text-sm text-foreground-muted">
        Supporting material from reporters. It doesn&apos;t verify the case: decide through the normal review.
      </p>
      <ul className="grid gap-2">
        {c.evidence.map((e) => (
          <li key={e.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-4">
            <span className="grid min-w-0 gap-0.5">
              <span className="truncate text-[15px] font-medium" title={e.originalFileName}>
                {e.originalFileName}
              </span>
              <span className="text-sm text-foreground-muted">
                {EVIDENCE_TYPE[e.mimeType] ?? 'File'} · {formatBytes(e.sizeBytes)} · Report {reportNumber(e.deathReportId) || '—'} ·{' '}
                {e.uploadedAt ? `Uploaded ${formatDateTime(e.uploadedAt)}` : EVIDENCE_STATE[e.status]}
              </span>
            </span>
            {e.status === 'READY' ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={open.isPending}
                onClick={() =>
                  open.mutate(e.id, { onSettled: () => void qc.invalidateQueries({ queryKey: adminKeys.case(c.caseId) }) })
                }
              >
                <ShieldCheck aria-hidden />
                View securely
              </Button>
            ) : (
              <span className="text-sm text-foreground-muted">{EVIDENCE_STATE[e.status]}</span>
            )}
          </li>
        ))}
      </ul>
      {open.error && (
        <Alert variant="destructive">
          <AlertTriangle aria-hidden />
          <AlertTitle>We couldn&apos;t open this file</AlertTitle>
          <AlertDescription>{open.error.message}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}

const Note = ({ children }: { children: ReactNode }) => <p className="text-[15px] text-foreground-secondary">{children}</p>;

const ByAdmin = ({ id }: { id: string | null }) =>
  id ? (
    <Link href={`/admin/users/${id}`} className={linkClass}>
      Admin {shortId(id)}
    </Link>
  ) : (
    '—'
  );

/** Decisions only where the API allows them (READY_FOR_REVIEW); closed cases are read-only. */
function Decision({ c, name, onConflict }: { c: DeathCaseDetail; name: string; onConflict: (message: string) => void }) {
  switch (c.status) {
    case 'PENDING_VERIFICATION':
      return (
        <Note>
          Review isn&apos;t available yet. The safety notice to the account holder hasn&apos;t been sent
          {c.safetyNoticeAttemptCount > 0 && ` (${c.safetyNoticeAttemptCount} attempts so far, retried automatically)`}; the
          safeguard period starts once it has.
        </Note>
      );
    case 'SAFEGUARD_ACTIVE':
      return (
        <Note>
          Review isn&apos;t available yet. The account holder has been notified and can confirm they&apos;re alive until
          {c.safeguardEndsAt ? ` ${formatDateTime(c.safeguardEndsAt)}` : ' the safeguard period ends'}. The case moves to
          review automatically after that.
        </Note>
      );
    case 'READY_FOR_REVIEW':
      return (
        <div className="grid gap-4">
          <Note>
            The safeguard period has ended without a response from the account holder. Review the reports and timeline, then
            decide.
          </Note>
          {!c.confirmationRequirementMet && (
            <Note>
              {c.requiredConfirmations === null
                ? 'This case has no recorded confirmation requirement, so it can’t be verified. It can still be rejected.'
                : 'Another independent Trusted Contact confirmation is required before this case can be verified. It can still be rejected.'}
            </Note>
          )}
          <div className="flex flex-wrap gap-3">
            {c.confirmationRequirementMet ? (
              <VerifyAction c={c} name={name} onConflict={onConflict} />
            ) : (
              // The API refuses verify too (409); this only explains it.
              <Button disabled>Verify death…</Button>
            )}
            <RejectAction c={c} name={name} onConflict={onConflict} />
          </div>
        </div>
      );
    case 'VERIFIED':
      return (
        <div className="grid gap-4">
          <Facts
            narrow
            items={[
              ['Verified', c.verifiedAt ? formatDateTime(c.verifiedAt) : '—'],
              ['Verified time of death', c.verifiedDeathAt ? formatDateTime(c.verifiedDeathAt) : '—'],
              ['Verified by', <ByAdmin key="by" id={c.verifiedByUserId} />],
              ['Messages activated', c.deathTriggersActivatedAt ? formatDateTime(c.deathTriggersActivatedAt) : 'In progress'],
            ]}
          />
          <DecisionNote note={c.adminDecisionNote} />
          <Note>This decision is final and can&apos;t be changed here.</Note>
        </div>
      );
    case 'REJECTED':
      return (
        <div className="grid gap-4">
          <Facts
            narrow
            items={[
              ['Rejected', c.rejectedAt ? formatDateTime(c.rejectedAt) : '—'],
              ['Rejected by', <ByAdmin key="by" id={c.rejectedByUserId} />],
            ]}
          />
          <DecisionNote note={c.adminDecisionNote} />
          <Note>Nothing was released. This decision is final and can&apos;t be changed here.</Note>
        </div>
      );
    case 'CANCELLED':
      return (
        <Note>
          The account holder confirmed they&apos;re alive{c.cancelledAt && ` on ${formatDateTime(c.cancelledAt)}`}. Nothing was
          released and no decision is needed.
        </Note>
      );
  }
}

const DecisionNote = ({ note }: { note: string | null }) =>
  note ? (
    <div className="grid gap-1">
      <p className="text-xs font-medium tracking-wide text-foreground-muted uppercase">Decision note (admins only)</p>
      <p className="text-[15px] whitespace-pre-wrap">{note}</p>
    </div>
  ) : null;

/** A 409 means the case moved on (cancelled, decided by someone else): say so; the refetch shows where it is now. */
const conflictHandler = (onConflict: (m: string) => void) => (error: ApiError) => {
  if (error.kind === 'conflict') onConflict(error.message);
};

const pad = (n: number) => String(n).padStart(2, '0');
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

function Confirmation({ id, checked, onChange, children }: { id: string; checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <label htmlFor={id} className="flex cursor-pointer items-start gap-3 rounded-md bg-surface-muted p-3 text-sm">
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 size-4 shrink-0 accent-primary" />
      <span>{children}</span>
    </label>
  );
}

/**
 * The most deliberate action in the portal: open case → open this dialog →
 * enter the verified time of death yourself (never copied from a report) →
 * tick the confirmation → confirm. The API then sets PASSED and activates
 * death-triggered messages; the frontend releases nothing.
 */
function VerifyAction({ c, name, onConflict }: { c: DeathCaseDetail; name: string; onConflict: (m: string) => void }) {
  const verify = useVerifyDeath(c.caseId);
  const [when, setWhen] = useState({ date: '', time: '', future: false });
  const [note, setNote] = useState('');
  const [confirmed, setConfirmed] = useState(false);

  const { date, time, future } = when;
  const iso = date && time ? localToOffsetIso(date, time) : null;
  // Checked as it's entered (the API re-checks at submit).
  const change = (next: { date?: string; time?: string }) => {
    const d = next.date ?? date;
    const t = next.time ?? time;
    setWhen({ date: d, time: t, future: !!d && !!t && new Date(localToOffsetIso(d, t)).getTime() > Date.now() });
  };
  const reported = c.reports.map((r) => r.reportedDateOfDeath).filter((d): d is string => !!d);

  return (
    <ConfirmDialog
      trigger={<Button>Verify death…</Button>}
      title={`Verify the death of ${name}?`}
      description={
        <>
          Verifying marks {name} as passed. Their account can no longer be used, and messages they set to be released on or
          after their death will start to be released to the people they chose. This can&apos;t be undone here.
        </>
      }
      confirmLabel="Verify death"
      pending={verify.isPending}
      error={verify.error}
      confirmDisabled={!iso || future || !confirmed || note.length > DECISION_NOTE_MAX}
      onOpenChange={(open) => {
        if (!open) {
          setWhen({ date: '', time: '', future: false });
          setNote('');
          setConfirmed(false);
          verify.reset();
        }
      }}
      onConfirm={() =>
        verify
          .mutateAsync(
            { verifiedDeathAt: iso!, confirmVerification: true, decisionNote: note.trim() || null },
            { onError: conflictHandler(onConflict) },
          )
          .then(() => toast('The death has been verified'))
      }
    >
      <fieldset className="grid gap-4">
        <legend className="mb-2 text-sm font-medium">Verified time of death</legend>
        <div className="grid grid-cols-2 gap-3">
          <div className="grid gap-2">
            <Label htmlFor="verified-date">Date</Label>
            <Input id="verified-date" type="date" max={today()} value={date} onChange={(e) => change({ date: e.target.value })} className="h-11" aria-describedby="verified-hint" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="verified-time">Time</Label>
            <Input id="verified-time" type="time" value={time} onChange={(e) => change({ time: e.target.value })} className="h-11" aria-describedby="verified-hint" />
          </div>
        </div>
        <p id="verified-hint" className="text-sm text-foreground-muted">
          In your timezone: {timeZoneLabel()}.
          {reported.length > 0 && (
            <> Reported by a trusted contact, for reference only: {reported.map(formatCalendarDate).join(', ')}.</>
          )}
        </p>
        {future && (
          <p role="alert" className="text-sm text-danger">
            The time of death can&apos;t be in the future.
          </p>
        )}
      </fieldset>
      <TextAreaField
        id="verify-note"
        label="Decision note"
        optional
        hint="Visible to admins only."
        rows={2}
        maxLength={DECISION_NOTE_MAX}
        length={note.length}
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <Confirmation id="verify-confirm" checked={confirmed} onChange={setConfirmed}>
        I have reviewed this case and confirm the death of {name}.
      </Confirmation>
    </ConfirmDialog>
  );
}

function RejectAction({ c, name, onConflict }: { c: DeathCaseDetail; name: string; onConflict: (m: string) => void }) {
  const reject = useRejectDeath(c.caseId);
  const [note, setNote] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  return (
    <ConfirmDialog
      tone="default"
      trigger={<Button variant="outline">Reject report…</Button>}
      title="Reject this report?"
      description={`The case is closed without verification. ${name}'s account is not changed and nothing is released.`}
      confirmLabel="Reject report"
      pending={reject.isPending}
      error={reject.error}
      confirmDisabled={!confirmed || note.length > DECISION_NOTE_MAX}
      onOpenChange={(open) => {
        if (!open) {
          setNote('');
          setConfirmed(false);
          reject.reset();
        }
      }}
      onConfirm={() =>
        reject
          .mutateAsync({ confirmRejection: true, decisionNote: note.trim() || null }, { onError: conflictHandler(onConflict) })
          .then(() => toast('The report has been rejected'))
      }
    >
      <TextAreaField
        id="reject-note"
        label="Decision note"
        optional
        hint="Visible to admins only."
        rows={2}
        maxLength={DECISION_NOTE_MAX}
        length={note.length}
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <Confirmation id="reject-confirm" checked={confirmed} onChange={setConfirmed}>
        I confirm this report should be rejected.
      </Confirmation>
    </ConfirmDialog>
  );
}
