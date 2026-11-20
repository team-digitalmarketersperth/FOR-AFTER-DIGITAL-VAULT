'use client';

import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Headset,
  Hourglass,
  Inbox,
  Info,
  Lock,
  Plus,
  RefreshCw,
  Search,
  SlidersHorizontal,
  UserRound,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { CopyButton } from '@/components/shared/copy-button';
import { Badge, DataTable, linkClass, Pager, SegmentedBar, SelectField, SummaryCard, useFilterNav } from '@/components/admin/admin-ui';
import { FilterChips, FormError, TextField } from '@/components/shared/form-field';
import { SearchBox } from '@/components/shared/list-controls';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyState, QueryView, Spinner } from '@/components/shared/states';
import { Composer } from '@/components/support/composer';
import { StatusBadge } from '@/components/support/support';
import { Button } from '@/components/ui/button';
import {
  useAdminSupportList,
  useAdminSupportRequest,
  useSupportNote,
  useSupportReply,
  useSupportStatus,
} from '@/hooks/use-admin';
import type { AdminSupportFilters, AdminSupportRequest, SupportPage } from '@/lib/api/admin';
import { SUPPORT_CATEGORIES, type SupportStatus } from '@/lib/api/support';
import { shortId, UUID } from '@/lib/admin';
import { formatCalendarDate, formatDateTime, formatTimestamp, localToOffsetIso, timeZoneLabel } from '@/lib/format';
import { cn } from '@/lib/utils';
import { nextStatuses, SUPPORT_CATEGORY_LABEL, SUPPORT_STATUS } from '@/lib/support';

const BASE = '/admin/support';

/** What the URL holds: dates as calendar days in the viewer's timezone. */
export type SupportUrlFilters = AdminSupportFilters;

const toApi = ({ from, to, ...rest }: SupportUrlFilters): AdminSupportFilters => ({
  ...rest,
  from: from ? localToOffsetIso(from, '00:00') : undefined,
  to: to ? localToOffsetIso(to, '23:59').replace('T23:59:00', 'T23:59:59.999') : undefined,
});

/** Mutually exclusive stored statuses, in workflow order; muted fills, the legend carries the words. */
const STATUS_ORDER: SupportStatus[] = ['OPEN', 'IN_PROGRESS', 'WAITING_FOR_CUSTOMER', 'RESOLVED'];
const FILL: Record<SupportStatus, string> = {
  OPEN: 'bg-brand-gold/70',
  IN_PROGRESS: 'bg-primary-soft',
  WAITING_FOR_CUSTOMER: 'bg-brand-lilac-grey',
  RESOLVED: 'bg-success/40',
};
const CARD_ICON: Record<SupportStatus, LucideIcon> = {
  OPEN: Inbox,
  IN_PROGRESS: Headset,
  WAITING_FOR_CUSTOMER: Hourglass,
  RESOLVED: CheckCircle2,
};
const SECONDARY = ['category', 'reference', 'accountId', 'from', 'to'] as const;
const count = (n: number) => n.toLocaleString('en-AU');

/** The inbox: newest first; no assignment, bulk actions, export or inline replies. Reading changes nothing. */
export function AdminSupportList({ filters }: { filters: SupportUrlFilters }) {
  const list = useAdminSupportList(toApi(filters));
  const nav = useFilterNav(BASE, filters);
  const data = list.data;
  return (
    <>
      <PageHeader
        title="Support"
        description={
          <>
            Keep customer requests moving.
            <span className="mt-2 flex items-start gap-2 text-sm text-foreground-secondary">
              <Lock aria-hidden strokeWidth={1.5} className="mt-0.5 size-4 shrink-0" />
              Only support requests are visible. Private legacy content stays private.
            </span>
          </>
        }
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
          <SupportInbox data={data} filters={filters} nav={nav} />
          <p className="flex items-start gap-3 rounded-xl border border-border bg-surface px-5 py-4 text-sm text-foreground-secondary">
            <Info aria-hidden strokeWidth={1.5} className="mt-0.5 size-4 shrink-0" />
            Open a request to review the conversation and available actions.
          </p>
        </div>
      ) : (
        <QueryView query={list} loadingLabel="Loading support requests">
          {() => null}
        </QueryView>
      )}
    </>
  );
}

type Nav = ReturnType<typeof useFilterNav<SupportUrlFilters>>;

/** What the counts cover, in words: every non-status filter, never the page. */
function scopeText(f: SupportUrlFilters) {
  const parts = [
    f.search && `matching “${f.search}”`,
    f.category && `in ${SUPPORT_CATEGORY_LABEL[f.category]}`,
    f.reference && `reference ${shortId(f.reference)}`,
    f.accountId && `account ${shortId(f.accountId)}`,
    f.from || f.to ? `created ${f.from ? formatCalendarDate(f.from) : 'any time'} to ${f.to ? formatCalendarDate(f.to) : 'now'}` : 'all time',
  ].filter(Boolean);
  return `All statuses · requests ${parts.join(', ')}`;
}

function Overview({ data, filters, nav }: { data: SupportPage; filters: SupportUrlFilters; nav: Nav }) {
  const { counts } = data;
  const total = STATUS_ORDER.reduce((n, s) => n + counts[s], 0);
  return (
    <>
      <section aria-labelledby="support-summary" className="grid gap-3">
        <h2 id="support-summary" className="sr-only">
          Request summary
        </h2>
        <p className="flex items-start gap-2 text-sm text-foreground-muted">
          <Info aria-hidden strokeWidth={1.5} className="mt-0.5 size-4 shrink-0" />
          {scopeText(filters)}
        </p>
        <ul className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5">
          <li>
            <SummaryCard icon={Users} label="Total requests" value={count(total)} />
          </li>
          {STATUS_ORDER.map((s) => (
            <li key={s}>
              <SummaryCard icon={CARD_ICON[s]} label={SUPPORT_STATUS[s].admin} value={count(counts[s])} />
            </li>
          ))}
        </ul>
      </section>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <section aria-labelledby="request-overview" className="grid content-start gap-5 rounded-xl border border-border bg-surface p-5 sm:p-7">
          <h2 id="request-overview" className="text-2xl">
            Request overview
          </h2>
          <SegmentedBar
            what="requests"
            segments={STATUS_ORDER.map((s) => ({
              key: s,
              label: SUPPORT_STATUS[s].admin,
              short: SUPPORT_STATUS[s].admin,
              n: counts[s],
              fill: FILL[s],
            }))}
          />
        </section>
        <section aria-labelledby="needs-attention" className="grid content-start gap-3 rounded-xl border border-border bg-surface p-5 sm:p-7">
          <h2 id="needs-attention" className="text-2xl">
            Needs attention
          </h2>
          <p className="text-[15px]">
            <span className="font-heading text-2xl tabular-nums">{count(counts.OPEN)}</span>{' '}
            {counts.OPEN === 1 ? 'open request' : 'open requests'}
          </p>
          {counts.OPEN > 0 ? (
            <>
              <p className="text-sm text-foreground-muted">Status Open: not yet in progress, waiting for customer or resolved.</p>
              <Link
                href={`${nav.href({ status: 'OPEN', page: undefined })}#support-inbox`}
                scroll={false}
                aria-current={filters.status === 'OPEN' ? 'true' : undefined}
                className={cn(linkClass, 'inline-flex w-fit items-center gap-1')}
              >
                View open requests
                <ArrowRight aria-hidden strokeWidth={1.5} className="size-4" />
              </Link>
            </>
          ) : (
            <p className="text-sm text-foreground-muted">No open requests in this selection.</p>
          )}
        </section>
      </div>
    </>
  );
}

function SupportInbox({ data, filters, nav }: { data: SupportPage; filters: SupportUrlFilters; nav: Nav }) {
  const { items, pagination, counts, evaluatedAt } = data;
  const total = STATUS_ORDER.reduce((n, s) => n + counts[s], 0);
  const secondary = SECONDARY.filter((k) => filters[k]);
  const filtered = !!(filters.status || filters.search || secondary.length);
  const clearAll = () => nav.set(Object.fromEntries(['status', 'search', ...SECONDARY].map((k) => [k, undefined])));
  const chips: [keyof SupportUrlFilters, string][] = [
    ...(filters.status ? [['status', `Status: ${SUPPORT_STATUS[filters.status].admin}`] as [keyof SupportUrlFilters, string]] : []),
    ...(filters.search ? [['search', `Search: “${filters.search}”`] as [keyof SupportUrlFilters, string]] : []),
    ...(filters.category ? [['category', `Category: ${SUPPORT_CATEGORY_LABEL[filters.category]}`] as [keyof SupportUrlFilters, string]] : []),
    ...(filters.reference ? [['reference', `Reference: ${shortId(filters.reference)}`] as [keyof SupportUrlFilters, string]] : []),
    ...(filters.accountId ? [['accountId', `Account: ${shortId(filters.accountId)}`] as [keyof SupportUrlFilters, string]] : []),
    ...(filters.from ? [['from', `From ${formatCalendarDate(filters.from)}`] as [keyof SupportUrlFilters, string]] : []),
    ...(filters.to ? [['to', `To ${formatCalendarDate(filters.to)}`] as [keyof SupportUrlFilters, string]] : []),
  ];
  return (
    <section id="support-inbox" aria-labelledby="support-inbox-title" className="grid min-w-0 scroll-mt-6 grid-cols-[minmax(0,1fr)] gap-5 rounded-xl border border-border bg-surface p-5 sm:p-7">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="support-inbox-title" className="text-2xl">
          Support inbox
        </h2>
        <Badge>
          {count(pagination.total)} {pagination.total === 1 ? 'request' : 'requests'}
        </Badge>
      </div>
      <FilterChips
        label="Filter by status"
        className="mb-0"
        chips={[
          { label: `All ${count(total)}`, href: nav.href({ status: undefined, page: undefined }), active: !filters.status },
          ...STATUS_ORDER.map((s) => ({
            label: `${SUPPORT_STATUS[s].admin} ${count(counts[s])}`,
            href: nav.href({ status: s, page: undefined }),
            active: filters.status === s,
          })),
        ]}
      />
      <SearchBox
        value={filters.search}
        onSearch={(search) => nav.set({ search })}
        label="Search subject or full reference"
        placeholder="Subject, or a full request reference"
        maxLength={150}
      />
      <details open={secondary.length > 0 || undefined} className="group rounded-lg border border-border">
        <summary className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg px-4 text-sm font-medium outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring">
          <SlidersHorizontal aria-hidden strokeWidth={1.5} className="size-4" />
          More filters
          {secondary.length > 0 && <Badge>{secondary.length} active</Badge>}
        </summary>
        <div className="border-t border-border p-4">
          <SupportFilterForm key={JSON.stringify(filters)} filters={filters} onApply={nav.set} />
        </div>
      </details>
      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-foreground-muted">Filtered by</span>
          {chips.map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => nav.set({ [key]: undefined })}
              className="inline-flex min-h-8 max-w-full items-center gap-1 rounded-full border border-border bg-surface-muted px-3 outline-none hover:border-border-strong focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring"
            >
              <span className="truncate">{label}</span>
              <X aria-hidden className="size-3.5 shrink-0" />
              <span className="sr-only">(remove filter)</span>
            </button>
          ))}
          <Button type="button" variant="link" size="sm" onClick={clearAll}>
            Clear filters
          </Button>
        </div>
      )}
      <p className="text-xs text-foreground-muted">
        Times in {timeZoneLabel(new Date(evaluatedAt))}. Newest requests first. Last public activity counts the request, customer
        follow-ups and public replies, never internal notes.
      </p>
      {items.length === 0 ? (
        pagination.total > 0 ? (
          <EmptyState
            heading="h3"
            icon={Inbox}
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
            title="No requests match these filters"
            action={
              <Button type="button" variant="outline" onClick={clearAll}>
                Clear filters
              </Button>
            }
          />
        ) : (
          <EmptyState heading="h3" icon={Inbox} title="No support requests yet" description="Requests appear here when customers ask for help." />
        )
      ) : (
        <div>
          <DataTable
            caption="Support requests"
            rows={items}
            rowKey={(r) => r.id}
            columns={[
              {
                header: 'Request',
                cell: (r) => (
                  <span className="grid min-w-0 gap-1">
                    {/* Customer text: rendered as text, never HTML. */}
                    <span className="font-medium [overflow-wrap:anywhere]">{r.subject}</span>
                    <Reference value={r.id} label="request reference" />
                  </span>
                ),
              },
              { header: 'Category', cell: (r) => SUPPORT_CATEGORY_LABEL[r.category] },
              { header: 'Status', cell: (r) => <StatusBadge status={r.status} admin /> },
              {
                header: 'Account',
                cell: (r) => (
                  <Link
                    href={nav.href({ accountId: r.ownerUserId, page: undefined })}
                    scroll={false}
                    title={r.ownerUserId}
                    className={cn(linkClass, 'font-mono text-xs')}
                  >
                    {shortId(r.ownerUserId)}
                    <span className="sr-only"> (show this account’s requests)</span>
                  </Link>
                ),
              },
              { header: 'Created', cell: (r) => <span className="whitespace-nowrap">{formatTimestamp(r.createdAt)}</span> },
              {
                header: 'Last public activity',
                cell: (r) => <span className="whitespace-nowrap">{formatTimestamp(r.lastPublicActivityAt)}</span>,
              },
              {
                header: 'Action',
                cell: (r) => (
                  <Link href={`${BASE}/${r.id}`} className={cn(linkClass, 'inline-flex items-center gap-1 whitespace-nowrap')}>
                    View request
                    <span className="sr-only">: {r.subject}</span>
                    <ArrowRight aria-hidden strokeWidth={1.5} className="size-4" />
                  </Link>
                ),
              },
            ]}
          />
          <Pager pagination={pagination} hrefFor={(page) => nav.href({ page })} />
        </div>
      )}
    </section>
  );
}

function SupportFilterForm({ filters, onApply }: { filters: SupportUrlFilters; onApply: (f: Partial<SupportUrlFilters>) => void }) {
  const [f, setF] = useState(filters);
  const [errors, setErrors] = useState<Partial<Record<keyof SupportUrlFilters, string>>>({});
  const field = (k: 'reference' | 'accountId' | 'from' | 'to') => ({
    value: f[k] ?? '',
    error: errors[k],
    onChange: (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value || undefined }),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const t = { ...f, reference: f.reference?.trim() || undefined, accountId: f.accountId?.trim() || undefined };
    const next: typeof errors = {};
    if (t.reference && !UUID.test(t.reference)) next.reference = 'Enter a full request reference.';
    if (t.accountId && !UUID.test(t.accountId)) next.accountId = 'Enter a full account ID.';
    if (t.from && t.to && t.from > t.to) next.to = 'Must be on or after the start date.';
    setErrors(next);
    if (Object.keys(next).length === 0) onApply(t);
  };
  return (
    <form onSubmit={submit} noValidate aria-label="More filters" className="grid gap-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <SelectField
          id="category"
          label="Category"
          value={f.category ?? ''}
          onChange={(e) => setF({ ...f, category: (e.target.value || undefined) as SupportUrlFilters['category'] })}
          options={[{ value: '', label: 'Any category' }, ...SUPPORT_CATEGORIES.map((c) => ({ value: c, label: SUPPORT_CATEGORY_LABEL[c] }))]}
        />
        <TextField id="reference" label="Request reference" spellCheck={false} className="font-mono" {...field('reference')} />
        <TextField id="accountId" label="Account ID" spellCheck={false} className="font-mono" {...field('accountId')} />
        <TextField id="from" label="Created from" type="date" {...field('from')} />
        <TextField id="to" label="Created to" type="date" {...field('to')} />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit">Apply filters</Button>
      </div>
    </form>
  );
}

// ─── Detail ─────────────────────────────────────────────────────────────────

const NOT_FOUND = { title: 'We couldn’t find this support request', backHref: BASE, backLabel: 'All support requests' };
const card = 'grid content-start gap-4 rounded-xl border border-border bg-surface p-5 shadow-soft sm:p-6';
const panelTitle = 'font-heading text-2xl leading-tight';
// Long words and links wrap instead of widening the page.
const textBody = 'text-[15px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]';

export function AdminSupportDetail({ id }: { id: string }) {
  const query = useAdminSupportRequest(id);
  return (
    <QueryView query={query} notFound={NOT_FOUND} loadingLabel="Loading support request">
      {(r) => <Detail r={r} />}
    </QueryView>
  );
}

/**
 * The support workspace: the public conversation with its reply box, internal
 * notes in their own panel, and status/details beside them. Reply, note and
 * status are separate commands; none changes another.
 */
function Detail({ r }: { r: AdminSupportRequest }) {
  const reply = useSupportReply(r.id);
  const tz = timeZoneLabel(new Date(r.lastPublicActivityAt));
  return (
    <>
      <PageHeader
        back={{ href: BASE, label: 'All support requests' }}
        eyebrow={SUPPORT_CATEGORY_LABEL[r.category]}
        title={<span className="[overflow-wrap:anywhere]">{r.subject}</span>}
        description={`Created ${formatTimestamp(r.createdAt)} · Last public activity ${formatTimestamp(r.lastPublicActivityAt)} · ${tz}`}
        action={<StatusBadge status={r.status} admin />}
      />
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] lg:grid-rows-[auto_1fr]">
        {/* Mobile: status first, then the conversation, then the details. */}
        <div className="order-2 grid min-w-0 gap-6 lg:order-none lg:row-span-2">
          <section aria-labelledby="conversation" className={card}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 id="conversation" className={panelTitle}>
                Conversation
              </h2>
              <p className="flex items-center gap-1.5 text-sm text-foreground-muted">
                <Users aria-hidden strokeWidth={1.5} className="size-4" />
                Visible to the customer
              </p>
            </div>
            <ol className="grid divide-y divide-border">
              <Entry role="CUSTOMER" body={r.description} at={r.createdAt} />
              {r.messages.map((m) => (
                <Entry key={m.id} role={m.authorRole} body={m.body} at={m.createdAt} />
              ))}
            </ol>
            <div className="border-t border-border pt-4">
              <Composer
                id="reply"
                label="Reply to customer"
                hint="The customer can see this reply."
                placeholder="Write a helpful reply…"
                submitLabel="Send reply"
                compact
                onSubmit={(input) => reply.mutateAsync(input)}
                pending={reply.isPending}
                error={reply.error}
              />
            </div>
          </section>
          <InternalNotes r={r} />
        </div>
        <div className="order-1 min-w-0 lg:order-none">
          <StatusPanel key={r.status} r={r} />
        </div>
        <div className="order-3 min-w-0 lg:order-none">
          <DetailsPanel r={r} tz={tz} />
        </div>
      </div>
    </>
  );
}

/** One public entry: a role label (never an admin id), a compact time, the text as typed. */
function Entry({ role, body, at }: { role: 'CUSTOMER' | 'ADMIN'; body: string; at: string }) {
  const team = role === 'ADMIN';
  const Icon = team ? Headset : UserRound;
  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 py-4 first:pt-0">
      <span
        aria-hidden
        className={`row-span-2 grid size-10 place-items-center rounded-full ${team ? 'bg-primary text-primary-foreground' : 'bg-surface-muted text-foreground-secondary'}`}
      >
        <Icon strokeWidth={1.5} className="size-5" />
      </span>
      <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
        <span className="font-medium text-foreground">{team ? 'For After support' : 'Customer'}</span>
        <time dateTime={at} title={formatDateTime(at)} className="text-foreground-muted">
          {formatTimestamp(at)}
        </time>
      </p>
      <p className={`rounded-lg px-4 py-3 ${textBody} ${team ? 'bg-primary-soft' : 'bg-surface-muted'}`}>{body}</p>
    </li>
  );
}

/**
 * Admin-only notes in their own tinted panel. The composer stays mounted while
 * hidden, so collapsing it never discards a draft.
 */
function InternalNotes({ r }: { r: AdminSupportRequest }) {
  const note = useSupportNote(r.id);
  const [open, setOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const show = (next: boolean) => {
    setOpen(next);
    // Focus follows the change: into the box when opened, back to the button when closed.
    requestAnimationFrame(() => (next ? document.getElementById('note')?.focus() : toggle.current?.focus()));
  };
  return (
    <section aria-labelledby="internal-notes" className="grid gap-4 rounded-xl border border-border bg-brand-ivory p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id="internal-notes" className={`flex items-center gap-2 ${panelTitle}`}>
              <Lock aria-hidden strokeWidth={1.5} className="size-5" />
              Internal notes
            </h2>
            <Badge tone="neutral" className="gap-1">
              <Lock aria-hidden strokeWidth={1.75} className="size-3" />
              Administrators only
            </Badge>
          </div>
          <p className="text-sm text-foreground-secondary">Never shown to the customer.</p>
        </div>
        <Button ref={toggle} type="button" variant="outline" aria-expanded={open} aria-controls="note-composer" onClick={() => show(!open)}>
          {open ? (
            'Hide note box'
          ) : (
            <>
              <Plus aria-hidden strokeWidth={1.75} />
              Add internal note
            </>
          )}
        </Button>
      </div>
      {r.internalNotes.length === 0 ? (
        <p className="text-[15px] text-foreground-muted">No internal notes yet.</p>
      ) : (
        <ol aria-label="Internal notes" className="grid gap-2">
          {r.internalNotes.map((n) => (
            <li key={n.id} className="grid gap-1 rounded-lg border border-border bg-surface px-4 py-3">
              <p className="text-sm text-foreground-muted">
                <span className="font-medium text-foreground">Administrator</span> ·{' '}
                <time dateTime={n.createdAt} title={formatDateTime(n.createdAt)}>
                  {formatTimestamp(n.createdAt)}
                </time>
              </p>
              <p className={textBody}>{n.body}</p>
            </li>
          ))}
        </ol>
      )}
      <div id="note-composer" hidden={!open}>
        <Composer
          id="note"
          label="Internal note"
          hint="Visible to authorised administrators only. Never shown to the customer."
          submitLabel="Save internal note"
          compact
          onSubmit={async (input) => {
            await note.mutateAsync(input);
            show(false);
          }}
          pending={note.isPending}
          error={note.error}
        />
      </div>
    </section>
  );
}

/** Sends the status this page showed, so another admin's change is a conflict, not overwritten. */
function StatusPanel({ r }: { r: AdminSupportRequest }) {
  const change = useSupportStatus(r.id);
  const options = nextStatuses(r.status);
  const [to, setTo] = useState<SupportStatus>(options[0]!);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!change.isPending) change.mutate({ status: to, expectedStatus: r.status });
  };
  return (
    <section aria-labelledby="request-status" className={card}>
      <h2 id="request-status" className={panelTitle}>
        Request status
      </h2>
      <p className="flex items-center gap-2 text-sm text-foreground-secondary">
        <span className="sr-only">Current status:</span>
        <StatusBadge status={r.status} admin />
      </p>
      <form onSubmit={submit} className="grid gap-3">
        {/* Side by side only where the card is wide enough for the longest status without clipping. */}
        <div className="grid items-end gap-3 sm:grid-cols-[minmax(0,1fr)_auto] lg:grid-cols-1 2xl:grid-cols-[minmax(0,1fr)_auto]">
          <div className="min-w-0 *:min-w-0 [&_select]:w-full">
            <SelectField
              id="new-status"
              label="Change to"
              value={to}
              onChange={(e) => setTo(e.target.value as SupportStatus)}
              options={options.map((s) => ({ value: s, label: SUPPORT_STATUS[s].admin }))}
            />
          </div>
          <Button type="submit" variant="outline" disabled={change.isPending}>
            {change.isPending && <Spinner />}
            Update status
          </Button>
        </div>
        <FormError error={change.error} />
        <p className="text-sm text-foreground-muted">
          Status changes are saved separately. Replies and notes never change the status.
        </p>
      </form>
    </section>
  );
}

/** Full-width rows; ids shortened for reading, the full value one click away. */
function DetailsPanel({ r, tz }: { r: AdminSupportRequest; tz: string }) {
  const rows: [string, ReactNode][] = [
    ['Request reference', <Reference key="r" value={r.id} label="request reference" />],
    ['Account reference', <Reference key="a" value={r.ownerUserId} label="account reference" />],
    ['Category', SUPPORT_CATEGORY_LABEL[r.category]],
    ['Created', formatTimestamp(r.createdAt)],
    ['Last public activity', formatTimestamp(r.lastPublicActivityAt)],
  ];
  return (
    <section aria-labelledby="request-details" className={card}>
      <h2 id="request-details" className={panelTitle}>
        Request details
      </h2>
      <dl className="grid divide-y divide-border">
        {rows.map(([label, value]) => (
          <div key={label} className="grid gap-1 py-3 first:pt-0">
            <dt className="text-xs font-medium tracking-[0.08em] text-foreground-muted uppercase">{label}</dt>
            <dd className="text-[15px] text-foreground">{value}</dd>
          </div>
        ))}
      </dl>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3 text-sm">
        <Link href={`/admin/users/${r.ownerUserId}`} className={`inline-flex items-center gap-1.5 ${linkClass}`}>
          View account
          <ArrowRight aria-hidden strokeWidth={1.5} className="size-4" />
        </Link>
        <span className="text-foreground-muted">Times shown in {tz}</span>
      </div>
    </section>
  );
}

function Reference({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-2">
      <details className="min-w-0">
        <summary className="cursor-pointer rounded-sm font-mono text-sm outline-none focus-visible:outline-2 focus-visible:outline-ring">
          <span aria-hidden>{shortId(value)}</span>
          <span className="sr-only">Show the full {label}</span>
        </summary>
        <code className="mt-1 block font-mono text-xs break-all text-foreground-secondary">{value}</code>
      </details>
      <CopyButton value={value} label="Copy" />
    </div>
  );
}
