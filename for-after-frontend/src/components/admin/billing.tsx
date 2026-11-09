'use client';

import { CreditCard, Info } from 'lucide-react';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { Badge, DataTable, Facts, linkClass, Pager, SelectField, useFilterNav } from '@/components/admin/admin-ui';
import { TextField } from '@/components/shared/form-field';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyState, QueryView } from '@/components/shared/states';
import { Button } from '@/components/ui/button';
import { useBillingAccounts } from '@/hooks/use-admin';
import { BILLING_FILTERS, type BillingFilters, type BillingSummary } from '@/lib/api/admin';
import { personName, UUID } from '@/lib/admin';
import { ACCESS_LABEL, ACCESS_TONE, planLabel } from '@/lib/billing';
import { formatDateTime, formatTimestamp, localToOffsetIso } from '@/lib/format';

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

/** Subscriptions & payments: read-only. No refunds, charges, extensions or price edits. */
export function AdminBillingList({ filters }: { filters: BillingFilters }) {
  const list = useBillingAccounts(toApi(filters));
  const nav = useFilterNav(BASE, filters);
  const filtered = Object.entries(filters).some(([k, v]) => k !== 'page' && v);
  return (
    <>
      <PageHeader
        eyebrow="Management"
        title="Subscriptions & payments"
        description="Free trials and Stripe subscriptions as last verified from Stripe. Read only: no card or payment details, and no changes from here."
      />
      <FilterForm key={JSON.stringify(filters)} filters={filters} onApply={nav.set} />
      <QueryView query={list} loadingLabel="Loading subscriptions">
        {(data) => (
          <div className="grid gap-4" aria-busy={list.isPlaceholderData || undefined}>
            <p className="flex items-start gap-2 text-sm text-foreground-muted">
              <Info aria-hidden strokeWidth={1.5} className="mt-0.5 size-4 shrink-0" />
              {data.enabled
                ? `Billing is switched on for accounts created from ${formatDateTime(data.enforceFrom!)}; older accounts keep their access.`
                : 'Billing is switched off: no account is restricted, and trials and checkout are unavailable.'}
            </p>
            {data.items.length === 0 ? (
              <EmptyState
                icon={CreditCard}
                title={filtered ? 'No accounts match these filters' : 'No trials or subscriptions yet'}
                action={
                  filtered ? (
                    <Link href={BASE} className={linkClass}>
                      Clear filters
                    </Link>
                  ) : undefined
                }
              />
            ) : (
              <div>
                <DataTable
                  caption="Billing accounts"
                  rows={data.items}
                  rowKey={(b) => b.accountId}
                  columns={[
                    {
                      header: 'Account',
                      cell: (b) => (
                        <Link href={`/admin/users/${b.accountId}`} className={`grid ${linkClass}`}>
                          <span>{personName(b) ?? 'No name'}</span>
                          <span className="text-xs font-normal text-foreground-muted">{b.email}</span>
                        </Link>
                      ),
                    },
                    { header: 'Access', cell: (b) => <BillingBadge b={b} /> },
                    { header: 'Plan', cell: (b) => planLabel(b.plan) },
                    { header: 'Trial', cell: (b) => (b.trialEndsAt ? `Ends ${formatTimestamp(b.trialEndsAt)}` : '—') },
                    {
                      header: 'Paid period',
                      cell: (b) =>
                        b.currentPeriodEnd ? `${b.cancelAtPeriodEnd ? 'Ends' : 'Renews'} ${formatTimestamp(b.currentPeriodEnd)}` : '—',
                    },
                    { header: 'Stripe status', cell: (b) => b.subscriptionStatus ?? '—' },
                    { header: 'Last synced', cell: (b) => (b.lastSyncedAt ? formatTimestamp(b.lastSyncedAt) : 'Never') },
                  ]}
                />
                <Pager pagination={data.pagination} hrefFor={(page) => nav.href({ page })} />
              </div>
            )}
          </div>
        )}
      </QueryView>
    </>
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
  const hasFilters = Object.entries(filters).some(([k, v]) => k !== 'page' && v);
  return (
    <form onSubmit={submit} noValidate aria-label="Filter billing accounts" className="mb-8 grid gap-4 rounded-xl border border-border bg-surface p-5">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
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
        <TextField id="subscriptionReference" label="Subscription ID" spellCheck={false} className="font-mono" {...text('subscriptionReference')} />
        <TextField id="from" label="Account created from" type="date" {...text('from')} />
        <TextField id="to" label="Account created to" type="date" {...text('to')} />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit">Apply filters</Button>
        {hasFilters && (
          <Button asChild variant="ghost">
            <Link href={BASE}>Clear filters</Link>
          </Button>
        )}
      </div>
    </form>
  );
}
