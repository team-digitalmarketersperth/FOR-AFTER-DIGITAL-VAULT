'use client';

import { Lock, Users } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import {
  CaseStatusBadge,
  DataTable,
  Facts,
  linkClass,
  Pager,
  Panel,
  RoleBadge,
  SelectField,
  useFilterNav,
  UserStatusBadge,
} from '@/components/admin/admin-ui';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { SearchBox } from '@/components/shared/list-controls';
import { TextAreaField } from '@/components/shared/form-field';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyState, QueryView } from '@/components/shared/states';
import { Button } from '@/components/ui/button';
import { useAdminSession, useAdminUser, useAdminUsers, useReactivateUser, useSuspendUser } from '@/hooks/use-admin';
import {
  SUSPEND_REASON_MAX,
  USER_ROLES,
  USER_STATUSES,
  type AdminMe,
  type AdminUserDetail,
  type UserFilters,
} from '@/lib/api/admin';
import { canManage, personName, ROLE_LABEL, STATUS_LABEL } from '@/lib/admin';
import { formatDate, formatDateTime } from '@/lib/format';

const BASE = '/admin/users';

export function UserList({ filters }: { filters: UserFilters }) {
  const list = useAdminUsers(filters);
  const nav = useFilterNav(BASE, filters);
  return (
    <>
      <PageHeader
        eyebrow="Management"
        title="Users"
        description="Account metadata only. Customers' messages, memories, stories and wishes are never shown here."
      />
      <div className="mb-6 grid gap-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)] sm:items-end">
        <SearchBox
          value={filters.search}
          onSearch={(search) => nav.set({ search })}
          placeholder="Email, first or last name"
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
      </div>
      <QueryView query={list} loadingLabel="Loading users">
        {({ items, pagination }) =>
          items.length === 0 ? (
            <EmptyState icon={Users} title="No users match these filters" description="Try a different search or filter." />
          ) : (
            <div aria-busy={list.isPlaceholderData || undefined}>
              <DataTable
                caption="Users"
                rows={items}
                rowKey={(u) => u.id}
                columns={[
                  {
                    header: 'Name',
                    cell: (u) => (
                      <Link href={`${BASE}/${u.id}`} className={linkClass}>
                        {personName(u) ?? 'No name'}
                      </Link>
                    ),
                  },
                  { header: 'Email', cell: (u) => u.email },
                  { header: 'Role', cell: (u) => <RoleBadge role={u.role} /> },
                  { header: 'Status', cell: (u) => <UserStatusBadge status={u.status} /> },
                  { header: 'Created', cell: (u) => formatDate(u.createdAt) },
                ]}
              />
              <Pager pagination={pagination} hrefFor={(page) => nav.href({ page })} />
            </div>
          )
        }
      </QueryView>
    </>
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
