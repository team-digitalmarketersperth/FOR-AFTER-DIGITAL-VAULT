'use client';

import { BillingBadge, BillingFacts } from '@/components/admin/billing';
import {
  AlertTriangle,
  ArrowRight,
  Check,
  CircleAlert,
  CreditCard,
  Info,
  Lock,
  Mail,
  RefreshCw,
  UserCheck,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import {
  Badge,
  CaseStatusBadge,
  DataTable,
  Facts,
  linkClass,
  Pager,
  Panel,
  RoleBadge,
  SelectField,
  SummaryCard,
  useFilterNav,
  UserStatusBadge,
} from '@/components/admin/admin-ui';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { SearchBox } from '@/components/shared/list-controls';
import { TextAreaField } from '@/components/shared/form-field';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyState, QueryView, Spinner } from '@/components/shared/states';
import { Button } from '@/components/ui/button';
import { useAdminSession, useAdminUser, useAdminUsers, useReactivateUser, useSuspendUser } from '@/hooks/use-admin';
import {
  EMAIL_VERIFICATION,
  SUSPEND_REASON_MAX,
  USER_ROLES,
  USER_STATUSES,
  type AdminMe,
  type AdminUser,
  type AdminUserDetail,
  type EmailVerification,
  type UserFilters,
  type UserPage,
  type UserSummary,
} from '@/lib/api/admin';
import type { UserRole } from '@/lib/api/auth';
import { canManage, personName, ROLE_LABEL, STATUS_LABEL } from '@/lib/admin';
import { formatDate, formatDateTime, formatTimestamp, timeZoneLabel } from '@/lib/format';
import { cn } from '@/lib/utils';

const BASE = '/admin/users';

const VERIFICATION_LABEL: Record<EmailVerification, string> = { verified: 'Verified', unverified: 'Unverified' };
const NOUN: Record<UserRole | 'ALL', [string, string]> = {
  ALL: ['user', 'users'],
  CUSTOMER: ['customer', 'customers'],
  ADMIN: ['admin', 'admins'],
  SUPER_ADMIN: ['super admin', 'super admins'],
};
const noun = (role: UserRole | undefined, n: number) => NOUN[role ?? 'ALL'][n === 1 ? 0 : 1];
const count = (n: number) => n.toLocaleString('en-AU');
/** Whole percent of a known total; an empty population is 0, never a division by zero. */
const percent = (n: number, of: number) => (of > 0 ? Math.round((n / of) * 100) : 0);

const userInitials = (u: AdminUser) =>
  ((u.firstName?.trim()[0] ?? '') + (u.lastName?.trim()[0] ?? '') || u.email[0] || '?').toUpperCase();

/** Billing counts reach SUPER_ADMIN viewers only, and only describe customers. */
const billingInScope = (s: UserSummary, role?: UserRole) =>
  s.customersWithBillingRecord !== undefined && (!role || role === 'CUSTOMER');

/**
 * Admin → Users. Account metadata only: cards, tracker and table come from one
 * API response, counted over every account the filters match (not just this
 * page). Refresh is read-only; there is no polling.
 */
export function UserList({ filters }: { filters: UserFilters }) {
  const list = useAdminUsers(filters);
  const nav = useFilterNav(BASE, filters);
  const data = list.data;
  return (
    <>
      <PageHeader
        title="Users"
        description={
          <>
            Manage accounts and review their status.
            <span className="mt-2 flex items-start gap-2 text-sm text-foreground-secondary">
              <Lock aria-hidden strokeWidth={1.5} className="mt-0.5 size-4 shrink-0" />
              Account metadata only. Private customer content is never shown.
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
                Last updated {formatTimestamp(data.summary.generatedAt)}
                <span className="block text-xs">{timeZoneLabel(new Date(data.summary.generatedAt))}</span>
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
              Couldn’t refresh. Showing results from {formatTimestamp(data.summary.generatedAt)}, which may be out of date or
              not match the current filters.
            </p>
          )}
          <SummaryCards summary={data.summary} role={filters.role} />
          <Tracker summary={data.summary} filters={filters} unverifiedHref={nav.href({ verification: 'unverified', page: undefined })} />
          <UserTable data={data} filters={filters} nav={nav} />
        </div>
      ) : (
        <QueryView query={list} loadingLabel="Loading users">
          {() => null}
        </QueryView>
      )}
    </>
  );
}

function SummaryCards({ summary: s, role }: { summary: UserSummary; role?: UserRole }) {
  const billing = billingInScope(s, role);
  const nouns = noun(role, 2);
  return (
    <section aria-labelledby="users-summary">
      <h2 id="users-summary" className="sr-only">
        Summary of the selected {nouns}
      </h2>
      <ul className={cn('grid grid-cols-1 gap-3 min-[420px]:grid-cols-2', billing ? 'xl:grid-cols-4' : 'xl:grid-cols-3')}>
        <li>
          <SummaryCard icon={Users} label={`Total ${nouns}`} value={count(s.total)} />
        </li>
        <li>
          <SummaryCard icon={UserCheck} label="Active accounts" value={count(s.active)} />
        </li>
        <li>
          <SummaryCard icon={Mail} label="Email verified" value={count(s.emailVerified)} />
        </li>
        {billing && (
          <li>
            <SummaryCard icon={CreditCard} label="No billing record" value={count(s.customers - s.customersWithBillingRecord!)} />
          </li>
        )}
      </ul>
    </section>
  );
}

function Meter({
  icon: Icon,
  label,
  value,
  of,
  text,
  bar,
}: {
  icon: LucideIcon;
  label: string;
  value: number;
  of: number;
  text: string;
  bar: string;
}) {
  const p = percent(value, of);
  return (
    <li className="grid gap-2 sm:grid-cols-[10.5rem_minmax(0,1fr)_minmax(8.5rem,auto)] sm:items-center sm:gap-5">
      <span className="flex items-center gap-3 text-[15px]">
        <Icon aria-hidden strokeWidth={1.5} className="size-5 shrink-0 text-foreground-muted" />
        {label}
      </span>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={p}
        aria-valuetext={of ? `${text} (${p}%)` : text}
        className="h-2 overflow-hidden rounded-full bg-brand-lilac-grey"
      >
        <div className={cn('h-full rounded-full', bar)} style={{ width: `${p}%` }} />
      </div>
      <span className="text-sm text-foreground-secondary tabular-nums">{text}</span>
    </li>
  );
}

function Tracker({ summary: s, filters, unverifiedHref }: { summary: UserSummary; filters: UserFilters; unverifiedHref: string }) {
  const role = filters.role;
  const billing = billingInScope(s, role);
  const none = `No ${noun(role, 2)}`;
  const unverified = s.total - s.emailVerified;
  const noRecord = billing ? s.customers - s.customersWithBillingRecord! : 0;
  return (
    <section aria-labelledby="account-tracker" className="rounded-xl border border-border bg-surface p-5 sm:p-7">
      <div className="grid gap-8 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] lg:gap-0">
        <div className="grid content-start gap-5 lg:pr-8">
          <h2 id="account-tracker" className="text-2xl">
            Account tracker
          </h2>
          <ul className="grid gap-4">
            <Meter
              icon={Mail}
              label="Email verification"
              value={s.emailVerified}
              of={s.total}
              bar="bg-primary"
              text={s.total ? `${count(s.emailVerified)} of ${count(s.total)} verified` : none}
            />
            <Meter
              icon={Users}
              label="Account status"
              value={s.active}
              of={s.total}
              bar="bg-success"
              text={s.total ? `${count(s.active)} of ${count(s.total)} active` : none}
            />
            {billing && (
              <Meter
                icon={CreditCard}
                label="Billing records"
                value={s.customersWithBillingRecord!}
                of={s.customers}
                bar="bg-primary"
                text={s.customers ? `${count(s.customersWithBillingRecord!)} of ${count(s.customers)} recorded` : 'No customers'}
              />
            )}
          </ul>
          {s.customersWithBillingRecord === undefined && role !== 'ADMIN' && role !== 'SUPER_ADMIN' && (
            <p className="text-sm text-foreground-muted">Billing records are visible to super admins only.</p>
          )}
        </div>
        <div className="grid content-start gap-4 border-border lg:border-l lg:pl-8">
          <h2 className="text-2xl">Needs review</h2>
          <ul className="grid gap-3">
            <li>
              {unverified > 0 ? (
                <Link
                  href={unverifiedHref}
                  aria-current={filters.verification === 'unverified' ? 'true' : undefined}
                  className="flex items-center gap-3 rounded-lg p-1 text-[15px] outline-none hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring aria-[current=true]:bg-primary-soft"
                >
                  <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-lg bg-warning/10 text-warning">
                    <Mail strokeWidth={1.5} className="size-4" />
                  </span>
                  <span>
                    {count(unverified)} {unverified === 1 ? 'email' : 'emails'} unverified
                    <span className="sr-only"> (show these accounts)</span>
                  </span>
                </Link>
              ) : (
                <ReviewNote>{s.total ? 'Every email address is verified' : 'No unverified email addresses'}</ReviewNote>
              )}
            </li>
            {billing && (
              <li>
                {noRecord > 0 ? (
                  <div className="flex items-start gap-3 p-1 text-[15px]">
                    <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-lg bg-surface-muted text-foreground-secondary">
                      <CreditCard strokeWidth={1.5} className="size-4" />
                    </span>
                    <span className="grid">
                      {count(noRecord)} without billing records
                      <span className="text-sm text-foreground-muted">No billing record does not mean unpaid.</span>
                    </span>
                  </div>
                ) : (
                  <ReviewNote>{s.customers ? 'Every customer has a billing record' : 'No customers in this selection'}</ReviewNote>
                )}
              </li>
            )}
          </ul>
        </div>
      </div>
      <p className="mt-6 flex items-start gap-2 border-t border-border pt-4 text-sm text-foreground-muted">
        <Info aria-hidden strokeWidth={1.5} className="mt-0.5 size-4 shrink-0" />
        Verification, account status and billing are tracked independently.
      </p>
    </section>
  );
}

const ReviewNote = ({ children }: { children: string }) => (
  <p className="flex items-center gap-3 p-1 text-[15px] text-foreground-muted">
    <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-lg bg-success/10 text-success">
      <Check strokeWidth={1.5} className="size-4" />
    </span>
    {children}
  </p>
);

const VerificationBadge = ({ at }: { at: string | null }) =>
  at ? (
    <Badge tone="done" className="gap-1">
      <Check aria-hidden strokeWidth={2} className="size-3.5" />
      Verified
    </Badge>
  ) : (
    <Badge tone="warning" className="gap-1">
      <CircleAlert aria-hidden strokeWidth={2} className="size-3.5" />
      Unverified
    </Badge>
  );

type FilterKey = Exclude<keyof UserFilters, 'page'>;

function UserTable({ data, filters, nav }: { data: UserPage; filters: UserFilters; nav: ReturnType<typeof useFilterNav<UserFilters>> }) {
  const { items, pagination, summary } = data;
  const role = filters.role;
  const chips: [FilterKey, string | undefined][] = [
    ['search', filters.search && `Search: “${filters.search}”`],
    ['status', filters.status && `Status: ${STATUS_LABEL[filters.status]}`],
    ['role', filters.role && `Role: ${ROLE_LABEL[filters.role]}`],
    ['verification', filters.verification && `Email: ${VERIFICATION_LABEL[filters.verification]}`],
  ];
  const active = chips.filter((c): c is [FilterKey, string] => !!c[1]);
  const clearAll = () => nav.set({ search: undefined, status: undefined, role: undefined, verification: undefined });
  const showPlan = summary.customersWithBillingRecord !== undefined && role !== 'ADMIN' && role !== 'SUPER_ADMIN';
  return (
    <section aria-labelledby="user-list" className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5 rounded-xl border border-border bg-surface p-5 sm:p-7">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="user-list" className="text-2xl">
          All {noun(role, 2)}
        </h2>
        <Badge>
          {count(pagination.total)} {noun(role, pagination.total)}
        </Badge>
      </div>
      <div className="grid gap-4 sm:grid-cols-[repeat(2,minmax(0,1fr))] lg:grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,1fr))] lg:items-end">
        <SearchBox
          value={filters.search}
          onSearch={(search) => nav.set({ search })}
          label="Search name or email"
          placeholder="Search name or email"
          maxLength={254}
        />
        <SelectField
          id="status"
          label="Status"
          value={filters.status ?? ''}
          onChange={(e) => nav.set({ status: e.target.value || undefined } as Partial<UserFilters>)}
          options={[{ value: '', label: 'All statuses' }, ...USER_STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] }))]}
        />
        <SelectField
          id="role"
          label="Role"
          value={filters.role ?? ''}
          onChange={(e) => nav.set({ role: e.target.value || undefined } as Partial<UserFilters>)}
          options={[{ value: '', label: 'All roles' }, ...USER_ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r] }))]}
        />
        <SelectField
          id="verification"
          label="Verification"
          value={filters.verification ?? ''}
          onChange={(e) => nav.set({ verification: e.target.value || undefined } as Partial<UserFilters>)}
          options={[{ value: '', label: 'All' }, ...EMAIL_VERIFICATION.map((v) => ({ value: v, label: VERIFICATION_LABEL[v] }))]}
        />
      </div>
      {active.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-foreground-muted">Filtered by</span>
          {active.map(([key, label]) => (
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
      {items.length === 0 ? (
        pagination.total > 0 ? (
          <EmptyState
            heading="h3"
            icon={Users}
            title="This page is past the end of the list"
            action={
              <Button asChild variant="outline">
                <Link href={nav.href({ page: undefined })}>Go to the first page</Link>
              </Button>
            }
          />
        ) : active.length ? (
          <EmptyState
            heading="h3"
            icon={Users}
            title={`No ${noun(role, 2)} match these filters`}
            description="Try a different search or filter."
            action={
              <Button type="button" variant="outline" onClick={clearAll}>
                Clear filters
              </Button>
            }
          />
        ) : (
          <EmptyState heading="h3" icon={Users} title="No users yet" description="Accounts appear here once people sign up." />
        )
      ) : (
        <div>
          <DataTable
            caption={`All ${noun(role, 2)}`}
            rows={items}
            rowKey={(u) => u.id}
            columns={[
              {
                header: 'User',
                cell: (u) => (
                  <span className="flex min-w-0 items-center gap-3">
                    <span
                      aria-hidden
                      className="grid size-9 shrink-0 place-items-center rounded-full bg-primary-soft text-xs font-semibold text-primary"
                    >
                      {userInitials(u)}
                    </span>
                    <span className="grid min-w-0 gap-0.5">
                      <span className="font-medium break-words">{personName(u) ?? 'No name'}</span>
                      <span className="text-[13px] break-all text-foreground-muted">{u.email}</span>
                      {/* Mixed-role lists say who is who; with a role filter the heading does. */}
                      {!role && <RoleBadge role={u.role} />}
                    </span>
                  </span>
                ),
              },
              { header: 'Email verification', cell: (u) => <VerificationBadge at={u.emailVerifiedAt} /> },
              { header: 'Account status', cell: (u) => <UserStatusBadge status={u.status} /> },
              ...(showPlan
                ? [
                    {
                      header: 'Plan',
                      cell: (u: AdminUser) =>
                        u.role !== 'CUSTOMER' ? (
                          <span className="text-foreground-muted">Not applicable</span>
                        ) : u.billing ? (
                          <BillingBadge b={u.billing} />
                        ) : (
                          <span className="text-foreground-muted">Unavailable</span>
                        ),
                    },
                  ]
                : []),
              { header: 'Created', cell: (u) => <span className="whitespace-nowrap">{formatDate(u.createdAt)}</span> },
              {
                header: 'Action',
                cell: (u) => (
                  <Link href={`${BASE}/${u.id}`} className={cn(linkClass, 'inline-flex items-center gap-1 whitespace-nowrap')}>
                    View account
                    <span className="sr-only">: {personName(u) ?? u.email}</span>
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

// ─── Detail ─────────────────────────────────────────────────────────────────

const NOT_FOUND = { title: 'We couldn’t find this user', backHref: BASE, backLabel: 'Back to users' };

export function UserDetail({ id }: { id: string }) {
  const user = useAdminUser(id);
  const me = useAdminSession().data;
  return (
    <QueryView query={user} notFound={NOT_FOUND} loadingLabel="Loading user">
      {(u) => (
        <>
          <PageHeader
            back={{ href: BASE, label: 'Users' }}
            eyebrow={ROLE_LABEL[u.role]}
            title={personName(u) ?? u.email}
            description={u.email}
          />
          <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <div className="grid content-start gap-6">
              <Panel title="Account">
                <Facts
                  items={[
                    ['Status', <UserStatusBadge key="s" status={u.status} />],
                    ['Role', <RoleBadge key="r" role={u.role} />],
                    ['Email', u.email],
                    ['Email verified', u.emailVerifiedAt ? formatDate(u.emailVerifiedAt) : 'Not verified'],
                    ['Two-factor', u.mfaEnabled ? 'Set up' : 'Not set up'],
                    ['Created', formatDateTime(u.createdAt)],
                    ['Last updated', formatDateTime(u.updatedAt)],
                    ...(u.passedAt ? [['Date of death (verified)', formatDateTime(u.passedAt)] as [string, string]] : []),
                    ...(u.deletedAt ? [['Deleted', formatDateTime(u.deletedAt)] as [string, string]] : []),
                    ['User ID', <span key="id" className="font-mono text-sm">{u.id}</span>],
                  ]}
                />
              </Panel>
              <Panel title="Totals">
                <Facts
                  items={[
                    ['People I Love', u.counts.recipientCount],
                    ['Trusted contacts', u.counts.trustedContactCount],
                    ['Messages', u.counts.messageCount],
                    ['Released messages', u.counts.releasedMessageCount],
                    ['Memory Vault items', u.counts.memoryVaultCount],
                  ]}
                />
                <p className="flex gap-2 text-sm text-foreground-muted">
                  <Lock aria-hidden strokeWidth={1.5} className="mt-0.5 size-4 shrink-0" />
                  Numbers only. The content itself stays private to the account holder and the people they chose.
                </p>
              </Panel>
            </div>
            <div className="grid content-start gap-6">
              <Panel title="Account access">{me && <AccessActions me={me} user={u} />}</Panel>
              {u.billing && (
                <Panel title="Plan">
                  <BillingFacts b={u.billing} />
                </Panel>
              )}
              <Panel title="Death verification">
                {u.deathVerification ? (
                  <div className="grid gap-3">
                    <CaseStatusBadge status={u.deathVerification.status} />
                    <Link href={`/admin/death-verifications/${u.deathVerification.caseId}`} className={linkClass}>
                      Open the case
                    </Link>
                  </div>
                ) : (
                  <p className="text-[15px] text-foreground-muted">No death has been reported for this account.</p>
                )}
              </Panel>
              <Link href={`/admin/audit-logs?subjectType=User&subjectId=${u.id}`} className={`w-fit text-sm ${linkClass}`}>
                Audit events for this account
              </Link>
            </div>
          </div>
        </>
      )}
    </QueryView>
  );
}

/** What the API would refuse is not offered; its 403/409 stay authoritative. */
function AccessActions({ me, user }: { me: AdminMe; user: AdminUserDetail }) {
  if (user.status === 'PASSED') {
    return (
      <p className="text-[15px] text-foreground-secondary">
        This account holder&apos;s death has been verified. The account can&apos;t be reactivated or changed here.
      </p>
    );
  }
  if (user.status === 'DELETED') return <p className="text-[15px] text-foreground-secondary">This account is deleted.</p>;
  if (!canManage(me, user)) {
    return (
      <p className="text-[15px] text-foreground-secondary">
        {me.id === user.id
          ? 'You can’t change your own account status.'
          : user.role === 'SUPER_ADMIN'
            ? 'Super admin accounts can’t be suspended from the portal.'
            : 'Only a super admin can change an administrator account.'}
      </p>
    );
  }
  return user.status === 'ACTIVE' ? <SuspendAction user={user} /> : <ReactivateAction user={user} />;
}

function SuspendAction({ user }: { user: AdminUserDetail }) {
  const suspend = useSuspendUser(user.id);
  const [reason, setReason] = useState('');
  const name = personName(user) ?? user.email;
  return (
    <div className="grid gap-4">
      <p className="text-[15px] text-foreground-secondary">
        Active. Suspending blocks sign-in and API access straight away; nothing they stored is deleted.
      </p>
      <ConfirmDialog
        trigger={<Button variant="outline" className="w-fit">Suspend account…</Button>}
        title={`Suspend ${name}?`}
        description={
          <>
            They won&apos;t be able to sign in, and any session they have open stops working on its next request. Their
            stored content is <strong>not</strong> deleted, and the account can be reactivated later.
          </>
        }
        confirmLabel="Suspend account"
        pending={suspend.isPending}
        error={suspend.error}
        confirmDisabled={!reason.trim() || reason.length > SUSPEND_REASON_MAX}
        onOpenChange={(open) => {
          if (!open) {
            setReason('');
            suspend.reset();
          }
        }}
        onConfirm={() =>
          suspend.mutateAsync(reason.trim()).then(() => toast(`${name} is suspended`))
        }
      >
        <TextAreaField
          id="suspend-reason"
          label="Reason"
          hint="Required. Kept in the audit log, not shown to the account holder."
          rows={3}
          maxLength={SUSPEND_REASON_MAX}
          length={reason.length}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </ConfirmDialog>
    </div>
  );
}

function ReactivateAction({ user }: { user: AdminUserDetail }) {
  const reactivate = useReactivateUser(user.id);
  const [reason, setReason] = useState('');
  const name = personName(user) ?? user.email;
  return (
    <div className="grid gap-4">
      <p className="text-[15px] text-foreground-secondary">Suspended. They can&apos;t sign in until reactivated.</p>
      <ConfirmDialog
        tone="default"
        trigger={<Button className="w-fit">Reactivate account…</Button>}
        title={`Reactivate ${name}?`}
        description="They'll be able to sign in again with their existing password."
        confirmLabel="Reactivate account"
        pending={reactivate.isPending}
        error={reactivate.error}
        confirmDisabled={reason.length > SUSPEND_REASON_MAX}
        onOpenChange={(open) => {
          if (!open) {
            setReason('');
            reactivate.reset();
          }
        }}
        onConfirm={() =>
          reactivate.mutateAsync(reason.trim() || null).then(() => toast(`${name} is active again`))
        }
      >
        <TextAreaField
          id="reactivate-reason"
          label="Reason"
          optional
          hint="Kept in the audit log."
          rows={3}
          maxLength={SUSPEND_REASON_MAX}
          length={reason.length}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </ConfirmDialog>
    </div>
  );
}
