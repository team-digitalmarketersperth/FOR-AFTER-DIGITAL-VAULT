'use client';

import {
  AlertTriangle,
  ArrowRight,
  CreditCard,
  FlaskConical,
  Info,
  Lock,
  RefreshCw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  UserCheck,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Badge, DataTable, Facts, linkClass, Pager, SegmentedBar, SelectField, SummaryCard, useFilterNav } from '@/components/admin/admin-ui';
import { TextField } from '@/components/shared/form-field';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyState, QueryView, Spinner } from '@/components/shared/states';
import { Button } from '@/components/ui/button';
import { useBillingAccounts } from '@/hooks/use-admin';
import { BILLING_FILTERS, type BillingFilters, type BillingPage, type BillingSummary } from '@/lib/api/admin';
import type { AccessState } from '@/lib/api/billing';
import { personName, shortId, UUID } from '@/lib/admin';
import { ACCESS_LABEL, ACCESS_TONE, planLabel } from '@/lib/billing';
import { formatCalendarDate, formatDateTime, formatTimestamp, localToOffsetIso, timeZoneLabel } from '@/lib/format';
import { cn } from '@/lib/utils';

const BASE = '/admin/billing';

export const BillingBadge = ({ b }: { b: BillingSummary | null }) =>
  b ? <Badge tone={ACCESS_TONE[b.state]}>{ACCESS_LABEL[b.state]}</Badge> : <span className="text-foreground-muted">—</span>;

/** Admin → Users detail: the same summary, for SUPER_ADMIN viewers only (the API omits it otherwise). */
export function BillingFacts({ b }: { b: BillingSummary }) {
  return (
    <>
      <Facts
        items={[
          ['Access', <BillingBadge key="s" b={b} />],
          ['Plan', planLabel(b.plan)],
          ['Trial ends', b.trialEndsAt ? formatDateTime(b.trialEndsAt) : '—'],
          ['Paid period ends', b.currentPeriodEnd ? formatDateTime(b.currentPeriodEnd) : '—'],
        ]}
      />
      <Link href={`${BASE}?accountId=${b.accountId}`} className={`w-fit text-sm ${linkClass}`}>
        Billing details
      </Link>
    </>
  );
}

const toApi = ({ from, to, ...rest }: BillingFilters): BillingFilters => ({
  ...rest,
  from: from ? localToOffsetIso(from, '00:00') : undefined,
  to: to ? localToOffsetIso(to, '23:59').replace('T23:59:00', 'T23:59:59.999') : undefined,
});

/** Each account sits in exactly one state; this order puts access first and the no-record states last. */
const STATE_ORDER: AccessState[] = [
  'trial_active',
  'paid_active',
  'cancellation_scheduled',
  'payment_issue',
  'payment_pending',
  'plan_unresolved',
  'trial_expired',
  'access_ended',
  'trial_available',
  'no_billing_record',
];
const FILL: Record<AccessState, string> = {
  trial_active: 'bg-primary-soft',
  paid_active: 'bg-success/50',
  cancellation_scheduled: 'bg-brand-gold/60',
  payment_issue: 'bg-danger/30',
  payment_pending: 'bg-brand-gold/30',
  plan_unresolved: 'bg-danger/15',
  trial_expired: 'bg-brand-lilac-grey',
  access_ended: 'bg-brand-stone',
  trial_available: 'bg-primary/20',
  no_billing_record: 'bg-surface-muted',
};
const SECONDARY = ['subscriptionReference', 'from', 'to'] as const;
const count = (n: number) => n.toLocaleString('en-AU');

/** Subscriptions & payments: read-only. No refunds, charges, extensions, price edits or Stripe calls. */
export function AdminBillingList({ filters }: { filters: BillingFilters }) {
  const list = useBillingAccounts(toApi(filters));
  const nav = useFilterNav(BASE, filters);
  const data = list.data;
  return (
    <>
      <PageHeader
        title="Subscriptions & payments"
        description="Review trial access and subscription records."
        action={
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <Badge className="gap-1.5 px-3 py-1 text-sm">
              <Lock aria-hidden strokeWidth={1.5} className="size-3.5" />
              Read-only
            </Badge>
            <Button type="button" variant="outline" className="h-11" disabled={list.isFetching} onClick={() => void list.refetch()}>
              {list.isFetching ? <Spinner /> : <RefreshCw aria-hidden strokeWidth={1.5} />}
              Refresh
            </Button>
            {data && (
              <p aria-live="polite" className="text-sm text-foreground-muted">
                Page data read {formatTimestamp(data.evaluatedAt)}
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
              Couldn’t refresh. Showing data read {formatTimestamp(data.evaluatedAt)}, which may be out of date or not match the
              current filters.
            </p>
          )}
          <ModeNotice data={data} />
          <Summary data={data} filters={filters} />
          <Records data={data} filters={filters} nav={nav} />
          <p className="flex items-start gap-3 rounded-xl bg-primary-soft px-4 py-3 text-sm text-foreground">
            <Info aria-hidden strokeWidth={1.5} className="mt-0.5 size-4 shrink-0 text-primary" />
            Subscription states are the last stored Stripe verification, not a live provider check. Refresh re-reads stored data
            only. Card and payment-method details are never shown.
          </p>
        </div>
      ) : (
        <QueryView query={list} loadingLabel="Loading billing records">
          {() => null}
        </QueryView>
      )}
    </>
  );
}

/** States that come only from a stored Stripe subscription status. */
const STRIPE_STATES: AccessState[] = ['paid_active', 'cancellation_scheduled', 'payment_issue', 'payment_pending', 'plan_unresolved', 'access_ended'];

function ModeNotice({ data }: { data: BillingPage }) {
  const withSubscriptions = STRIPE_STATES.some((s) => data.summary.states[s] > 0);
  return (
    <section aria-labelledby="billing-mode" className="flex flex-wrap items-start gap-4 rounded-xl border border-border bg-primary-soft/60 p-5 sm:flex-nowrap sm:p-6">
      <ShieldCheck aria-hidden strokeWidth={1.25} className="size-9 shrink-0 text-primary" />
      <div className="grid min-w-0 flex-1 gap-1">
        <h2 id="billing-mode" className="text-2xl">
          {data.enabled ? 'Billing is switched on' : 'Billing is switched off'}
        </h2>
        {data.enabled ? (
          <p className="text-[15px]">
            Accounts created from {formatDateTime(data.enforceFrom!)} need a trial or plan to add or change content; older
            accounts keep their access. This is the application setting; it doesn’t confirm the Stripe connection.
          </p>
        ) : (
          <p className="text-[15px]">
            No billing access restrictions apply. Trials and checkout are unavailable.
            {withSubscriptions && ' Existing Stripe subscriptions are not cancelled by this setting and may continue independently.'}
          </p>
        )}
        <p className="text-xs text-foreground-muted">Status from application configuration.</p>
      </div>
      <Badge tone={data.enabled ? 'open' : 'neutral'} className="px-3 py-1 text-sm">
        {data.enabled ? 'On' : 'Off'}
      </Badge>
    </section>
  );
}

/** What the summary covers, in words: every applied filter except Access. */
function scopeText(f: BillingFilters, enabled: boolean) {
  const parts = [
    f.plan && `${PLAN_FILTER_LABEL[f.plan]} plan`,
    f.accountId && `account ${shortId(f.accountId)}`,
    f.subscriptionReference && `subscription ${f.subscriptionReference}`,
    f.from || f.to
      ? `accounts created ${f.from ? formatCalendarDate(f.from) : 'any time'} to ${f.to ? formatCalendarDate(f.to) : 'now'}`
      : 'all time',
  ].filter(Boolean);
  return `Recorded billing states · every access state · ${parts.join(', ')} · Billing enforcement is ${enabled ? 'on' : 'off'}`;
}

function Summary({ data, filters }: { data: BillingPage; filters: BillingFilters }) {
  const { accounts, verified, states } = data.summary;
  const paid = states.paid_active + states.cancellation_scheduled + states.payment_issue;
  // Admin → Users' "billing record" (a trial or a subscription status): every listed state but the two "nothing yet"
  // ones. `accounts` also lists customers whose checkout was opened but never completed.
  const withRecord = accounts - states.trial_available - states.no_billing_record;
  return (
    <>
      <section aria-labelledby="billing-summary" className="grid gap-3">
        <h2 id="billing-summary" className="sr-only">
          Billing summary
        </h2>
        <ul className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 xl:grid-cols-4">
          <li>
            <SummaryCard icon={CreditCard} label="Accounts listed" value={count(accounts)} />
          </li>
          <li>
            <SummaryCard icon={UserCheck} label="Paid, in current period" value={count(paid)} />
          </li>
          <li>
            <SummaryCard icon={FlaskConical} label="Active trials" value={count(states.trial_active)} />
          </li>
          <li>
            <SummaryCard icon={AlertTriangle} label="Payment issues" value={count(states.payment_issue)} tone={states.payment_issue ? 'warning' : undefined} />
          </li>
        </ul>
        <p className="flex items-start gap-2 text-sm text-foreground-muted">
          <Info aria-hidden strokeWidth={1.5} className="mt-0.5 size-4 shrink-0" />
          {scopeText(filters, data.enabled)}. Paid counts subscribed, cancelling and payment-issue accounts, so cards can overlap.
        </p>
      </section>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <section aria-labelledby="access-overview" className="grid content-start gap-4 rounded-xl border border-border bg-surface p-5 sm:p-7">
          <h2 id="access-overview" className="text-2xl">
            {data.enabled ? 'Access overview' : 'Recorded access states'}
          </h2>
          {accounts === 0 ? (
            <p className="text-sm text-foreground-muted">No billing records to summarise. Access states appear when records exist.</p>
          ) : (
            <>
              {!data.enabled && (
                <p className="text-sm text-foreground-muted">How each account is classified; with billing off, none of these restrict access.</p>
              )}
              <SegmentedBar
                what="billing accounts"
                segments={STATE_ORDER.filter((s) => states[s] > 0).map((s) => ({
                  key: s,
                  label: ACCESS_LABEL[s],
                  short: ACCESS_LABEL[s],
                  n: states[s],
                  fill: FILL[s],
                }))}
              />
            </>
          )}
        </section>
        <section aria-labelledby="data-access" className="grid content-start gap-4 rounded-xl border border-border bg-surface p-5 sm:p-7">
          <h2 id="data-access" className="text-2xl">
            Data &amp; access
          </h2>
          <dl className="grid gap-3 text-[15px]">
            <Row label="Billing mode" value={<Badge tone={data.enabled ? 'open' : 'neutral'}>{data.enabled ? 'On' : 'Off'}</Badge>} />
            <Row label="Accounts listed" value={accounts ? count(accounts) : 'None'} />
            <Row label="With a billing record" value={accounts ? count(withRecord) : 'None'} />
            <Row
              label="Stripe verification"
              value={
                accounts === 0
                  ? 'Not available'
                  : verified === 0
                    ? 'None stored'
                    : `${count(verified)} of ${count(accounts)} accounts`
              }
            />
          </dl>
          {verified > 0 && <p className="text-sm text-foreground-muted">Verification times vary by account: see Last verified.</p>}
          <p className="border-t border-border pt-3 text-sm text-foreground-muted">No billing record does not mean unpaid.</p>
        </section>
      </div>
    </>
  );
}

const Row = ({ label, value }: { label: string; value: ReactNode }) => (
  <div className="flex items-center justify-between gap-4 border-b border-border pb-3 last:border-0 last:pb-0">
    <dt className="text-foreground-secondary">{label}</dt>
    <dd className="text-right font-medium">{value}</dd>
  </div>
);

/** Trial dates and paid periods kept apart; "ended" is judged against the server's read time. */
function period(b: BillingSummary, serverNow: string) {
  const past = (iso: string) => Date.parse(iso) <= Date.parse(serverNow);
  if (b.currentPeriodEnd) {
    const at = formatTimestamp(b.currentPeriodEnd);
    if (past(b.currentPeriodEnd)) return `Paid period ended ${at}`;
    return b.cancelAtPeriodEnd ? `Paid until ${at}, then ends` : `Paid period renews ${at}`;
  }
  if (b.trialEndsAt) return past(b.trialEndsAt) ? `Trial ended ${formatTimestamp(b.trialEndsAt)}` : `Trial ends ${formatTimestamp(b.trialEndsAt)}`;
  return 'No period recorded';
}

const verifiedText = (b: BillingSummary) =>
  b.lastSyncedAt
    ? formatTimestamp(b.lastSyncedAt)
    : !b.subscriptionStatus && !b.subscriptionReference && b.trialStartedAt
      ? 'Not applicable (trial only)'
      : 'Never verified';

type Nav = ReturnType<typeof useFilterNav<BillingFilters>>;
const PLAN_FILTER_LABEL: Record<NonNullable<BillingFilters['plan']>, string> = { monthly: 'Monthly', annual: 'Annual', unknown: 'Unknown' };

function Records({ data, filters, nav }: { data: BillingPage; filters: BillingFilters; nav: Nav }) {
  const { items, pagination, evaluatedAt } = data;
  const chips: [keyof BillingFilters, string][] = [
    ...(filters.state ? [['state', `Access: ${ACCESS_LABEL[filters.state]}`] as [keyof BillingFilters, string]] : []),
    ...(filters.plan ? [['plan', `Plan: ${PLAN_FILTER_LABEL[filters.plan]}`] as [keyof BillingFilters, string]] : []),
    ...(filters.accountId ? [['accountId', `Account: ${shortId(filters.accountId)}`] as [keyof BillingFilters, string]] : []),
    ...(filters.subscriptionReference ? [['subscriptionReference', `Subscription: ${filters.subscriptionReference}`] as [keyof BillingFilters, string]] : []),
    ...(filters.from ? [['from', `Created from ${formatCalendarDate(filters.from)}`] as [keyof BillingFilters, string]] : []),
    ...(filters.to ? [['to', `Created to ${formatCalendarDate(filters.to)}`] as [keyof BillingFilters, string]] : []),
  ];
  const clearAll = () => nav.set(Object.fromEntries(chips.map(([k]) => [k, undefined])));
  return (
    <section aria-labelledby="subscription-records" className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5 rounded-xl border border-border bg-surface p-5 sm:p-7">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="subscription-records" className="text-2xl">
          Subscription records
        </h2>
        <Badge>
          {count(pagination.total)} {pagination.total === 1 ? 'account' : 'accounts'}
        </Badge>
      </div>
      <FilterForm key={JSON.stringify(filters)} filters={filters} onApply={nav.set} />
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
        Times in {timeZoneLabel(new Date(evaluatedAt))}. Newest accounts first. The access filter narrows this table only.
      </p>
      {items.length === 0 ? (
        pagination.total > 0 ? (
          <EmptyState
            heading="h3"
            icon={CreditCard}
            title="This page is past the end of the list"
            action={
              <Button asChild variant="outline">
                <Link href={nav.href({ page: undefined })}>Go to the first page</Link>
              </Button>
            }
          />
        ) : chips.length ? (
          <EmptyState
            heading="h3"
            icon={Search}
            title="No matching billing records"
            action={
              <Button type="button" variant="outline" onClick={clearAll}>
                Clear filters
              </Button>
            }
          />
        ) : (
          <EmptyState
            heading="h3"
            icon={CreditCard}
            title="No trials or subscriptions yet"
            description="Recorded trials and Stripe subscriptions will appear here when available."
          />
        )
      ) : (
        <div>
          <DataTable
            caption="Billing accounts"
            rows={items}
            rowKey={(b) => b.accountId}
            columns={[
              {
                header: 'Account',
                cell: (b) => (
                  <span className="grid min-w-0 gap-0.5">
                    <span className="font-medium break-words">{personName(b) ?? 'No name'}</span>
                    <span className="text-[13px] break-all text-foreground-muted">{b.email}</span>
                    <span className="font-mono text-xs text-foreground-muted" title={b.accountId}>
                      {shortId(b.accountId)}
                    </span>
                  </span>
                ),
              },
              {
                header: 'Plan',
                cell: (b) => (
                  <span className="grid gap-0.5">
                    <span>{b.plan ? planLabel(b.plan) : b.trialStartedAt && !b.subscriptionStatus ? 'Free trial' : 'No plan'}</span>
                    {b.subscriptionReference && (
                      <span className="font-mono text-xs break-all text-foreground-muted" title={b.subscriptionReference}>
                        {b.subscriptionReference}
                      </span>
                    )}
                  </span>
                ),
              },
              {
                header: 'Access state',
                cell: (b) => (
                  <span className="grid gap-1">
                    <BillingBadge b={b} />
                    {b.subscriptionStatus && <span className="text-xs text-foreground-muted">Stripe: {b.subscriptionStatus}</span>}
                  </span>
                ),
              },
              { header: 'Current period', cell: (b) => <span className="text-sm">{period(b, evaluatedAt)}</span> },
              { header: 'Last verified', cell: (b) => <span className="text-sm whitespace-nowrap">{verifiedText(b)}</span> },
              {
                header: 'Action',
                cell: (b) => (
                  <Link href={`/admin/users/${b.accountId}`} className={cn(linkClass, 'inline-flex items-center gap-1 whitespace-nowrap')}>
                    View account
                    <span className="sr-only">: {personName(b) ?? b.email}</span>
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

function FilterForm({ filters, onApply }: { filters: BillingFilters; onApply: (f: Partial<BillingFilters>) => void }) {
  const [f, setF] = useState(filters);
  const [errors, setErrors] = useState<Partial<Record<keyof BillingFilters, string>>>({});
  const text = (k: 'accountId' | 'subscriptionReference' | 'from' | 'to') => ({
    value: f[k] ?? '',
    error: errors[k],
    onChange: (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value || undefined }),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const t = { ...f, accountId: f.accountId?.trim() || undefined, subscriptionReference: f.subscriptionReference?.trim() || undefined };
    const next: typeof errors = {};
    if (t.accountId && !UUID.test(t.accountId)) next.accountId = 'Enter a full account ID.';
    if (t.subscriptionReference && !/^sub_[A-Za-z0-9]+$/.test(t.subscriptionReference)) next.subscriptionReference = 'Enter a Stripe subscription ID (sub_…).';
    if (t.from && t.to && t.from > t.to) next.to = 'Must be on or after the start date.';
    setErrors(next);
    if (Object.keys(next).length === 0) onApply(t);
  };
  const secondary = SECONDARY.filter((k) => filters[k] || errors[k]).length;
  return (
    <form onSubmit={submit} noValidate aria-label="Filter billing accounts" className="grid gap-4">
      <div className="grid gap-4 sm:grid-cols-[repeat(2,minmax(0,1fr))] lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.5fr)] lg:items-start">
        <SelectField
          id="state"
          label="Access"
          value={f.state ?? ''}
          onChange={(e) => setF({ ...f, state: (e.target.value || undefined) as BillingFilters['state'] })}
          options={[{ value: '', label: 'Any' }, ...BILLING_FILTERS.map((s) => ({ value: s, label: ACCESS_LABEL[s] }))]}
        />
        <SelectField
          id="plan"
          label="Plan"
          value={f.plan ?? ''}
          onChange={(e) => setF({ ...f, plan: (e.target.value || undefined) as BillingFilters['plan'] })}
          options={[
            { value: '', label: 'Any plan' },
            { value: 'monthly', label: 'Monthly' },
            { value: 'annual', label: 'Annual' },
            { value: 'unknown', label: 'Unknown plan' },
          ]}
        />
        <TextField id="accountId" label="Account ID" spellCheck={false} className="font-mono" {...text('accountId')} />
      </div>
      <details open={secondary > 0 || undefined} className="rounded-lg border border-border">
        <summary className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg px-4 text-sm font-medium outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring">
          <SlidersHorizontal aria-hidden strokeWidth={1.5} className="size-4" />
          More filters: subscription ID, account created dates
        </summary>
        <div className="grid gap-4 border-t border-border p-4 sm:grid-cols-[repeat(3,minmax(0,1fr))]">
          <TextField id="subscriptionReference" label="Subscription ID" spellCheck={false} className="font-mono" {...text('subscriptionReference')} />
          <TextField id="from" label="Account created from" type="date" {...text('from')} />
          <TextField id="to" label="Account created to" type="date" {...text('to')} />
        </div>
      </details>
      <div>
        <Button type="submit">Apply filters</Button>
      </div>
    </form>
  );
}
