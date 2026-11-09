'use client';

import { CheckCircle2, CircleSlash, Info, KeyRound, ShieldCheck, UserPlus } from 'lucide-react';
import Link from 'next/link';
import { useRef, useState, type FormEvent } from 'react';
import {
  Badge,
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
import { FormError, TextField } from '@/components/shared/form-field';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyState, QueryView, Spinner } from '@/components/shared/states';
import { Button } from '@/components/ui/button';
import { useAdminAccount, useAdminAccounts, useAdminSession, useCreateAdmin, useResendAdminInvitation } from '@/hooks/use-admin';
import { USER_STATUSES, type AdminAccessFilters, type AdminAccountDetail, type InvitationResult } from '@/lib/api/admin';
import { AUDIT_ACTOR_LABEL, AUDIT_EVENT_LABEL, personName, shortId, STATUS_LABEL } from '@/lib/admin';
import { formatDateTime, formatTimestamp } from '@/lib/format';

const BASE = '/admin/access';

export const MfaBadge = ({ enrolled }: { enrolled: boolean }) => (
  <Badge tone={enrolled ? 'done' : 'warning'} className="gap-1">
    {enrolled ? <CheckCircle2 aria-hidden className="size-3.5" /> : <CircleSlash aria-hidden className="size-3.5" />}
    {enrolled ? 'Two-factor enrolled' : 'Two-factor not enrolled'}
  </Badge>
);

const lastSignIn = (at: string | null) => (at ? formatTimestamp(at) : 'None recorded');

/** Read-only: who has admin access, with what role, status and two-factor enrolment. */
export function AdminAccessList({ filters }: { filters: AdminAccessFilters }) {
  const list = useAdminAccounts(filters);
  const nav = useFilterNav(BASE, filters);
  const filtered = Object.entries(filters).some(([k, v]) => k !== 'page' && v);
  return (
    <>
      <PageHeader
        eyebrow="Security"
        title="Admin access"
        description="Administrator accounts, their role and two-factor enrolment. Suspension stays on each account’s user page, under its existing rules; roles cannot be changed in the app."
        action={<CreateAdminLink />}
      />
      <AccessFilterForm key={JSON.stringify(filters)} filters={filters} onApply={nav.set} />
      <QueryView query={list} loadingLabel="Loading administrators">
        {({ items, pagination }) =>
          items.length === 0 ? (
            <EmptyState
              icon={ShieldCheck}
              title={filtered ? 'No administrators match these filters' : 'No administrator accounts'}
              action={
                filtered ? (
                  <Link href={BASE} className={linkClass}>
                    Clear filters
                  </Link>
                ) : undefined
              }
            />
          ) : (
            <div aria-busy={list.isPlaceholderData || undefined}>
              <DataTable
                caption="Administrators"
                rows={items}
                rowKey={(a) => a.id}
                columns={[
                  {
                    header: 'Administrator',
                    cell: (a) => (
                      <Link href={`${BASE}/${a.id}`} className={`grid ${linkClass}`}>
                        <span>{personName(a) ?? 'No name'}</span>
                        <span className="text-xs font-normal text-foreground-muted">{a.email}</span>
                      </Link>
                    ),
                  },
                  { header: 'Role', cell: (a) => <RoleBadge role={a.role} /> },
                  {
                    header: 'Account',
                    cell: (a) =>
                      a.invitationPending ? <Badge tone="open">Invitation pending</Badge> : <UserStatusBadge status={a.status} />,
                  },
                  { header: 'Two-factor', cell: (a) => <MfaBadge enrolled={a.mfaEnrolled} /> },
                  { header: 'Last admin sign-in', cell: (a) => <span className="whitespace-nowrap">{lastSignIn(a.lastSignInAt)}</span> },
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

function AccessFilterForm({ filters, onApply }: { filters: AdminAccessFilters; onApply: (f: Partial<AdminAccessFilters>) => void }) {
  const [f, setF] = useState(filters);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onApply({ ...f, search: f.search?.trim() || undefined });
  };
  const hasFilters = Object.entries(filters).some(([k, v]) => k !== 'page' && v);
  return (
    <form onSubmit={submit} aria-label="Filter administrators" className="mb-8 grid gap-4 rounded-xl border border-border bg-surface p-5">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <TextField id="search" label="Name or email" maxLength={254} value={f.search ?? ''} onChange={(e) => setF({ ...f, search: e.target.value || undefined })} />
        <SelectField
          id="role"
          label="Role"
          value={f.role ?? ''}
          onChange={(e) => setF({ ...f, role: (e.target.value || undefined) as AdminAccessFilters['role'] })}
          options={[
            { value: '', label: 'Any role' },
            { value: 'ADMIN', label: 'Admin' },
            { value: 'SUPER_ADMIN', label: 'Super admin' },
          ]}
        />
        <SelectField
          id="status"
          label="Account"
          value={f.status ?? ''}
          onChange={(e) => setF({ ...f, status: (e.target.value || undefined) as AdminAccessFilters['status'] })}
          options={[{ value: '', label: 'Any status' }, ...USER_STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] }))]}
        />
        <SelectField
          id="mfa"
          label="Two-factor"
          value={f.mfa ?? ''}
          onChange={(e) => setF({ ...f, mfa: (e.target.value || undefined) as AdminAccessFilters['mfa'] })}
          options={[
            { value: '', label: 'Any' },
            { value: 'enrolled', label: 'Enrolled' },
            { value: 'not_enrolled', label: 'Not enrolled' },
          ]}
        />
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

/** Shown to SUPER_ADMIN only; the API enforces it (and recent two-factor) on every request. */
function CreateAdminLink() {
  const me = useAdminSession().data;
  if (me?.role !== 'SUPER_ADMIN') return null;
  return (
    <Button asChild>
      <Link href={`${BASE}/new`}>
        <UserPlus aria-hidden strokeWidth={1.5} />
        Create admin
      </Link>
    </Button>
  );
}

/** What happened to the invitation email, in plain words (accepted by the provider is not delivered). */
const INVITATION_TEXT: Record<InvitationResult['invitation'], { tone: 'done' | 'warning'; text: string }> = {
  sent: { tone: 'done', text: 'The invitation email was accepted by the email provider. The link works once and expires in 72 hours.' },
  not_sent: { tone: 'warning', text: 'The invitation email could not be sent. Resend it from the admin’s page.' },
  capped: { tone: 'warning', text: 'Too many invitations for this admin in the last hour. Try again later.' },
};

const InvitationNote = ({ result }: { result: InvitationResult['invitation'] }) => (
  <p
    role="status"
    className={`rounded-lg px-4 py-3 text-[15px] ${INVITATION_TEXT[result].tone === 'done' ? 'bg-success/10 text-success' : 'bg-warning/10 text-warning'}`}
  >
    {INVITATION_TEXT[result].text}
  </p>
);

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Create an ordinary ADMIN: names and email only; they set their own password from the invitation. */
export function CreateAdminPage() {
  const create = useCreateAdmin();
  const me = useAdminSession().data;
  const [f, setF] = useState({ firstName: '', lastName: '', email: '' });
  const [errors, setErrors] = useState<Partial<Record<keyof typeof f, string>>>({});
  const busy = useRef(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (busy.current) return;
    const t = { firstName: f.firstName.trim(), lastName: f.lastName.trim(), email: f.email.trim() };
    const next: typeof errors = {};
    if (!t.firstName) next.firstName = 'Enter a first name.';
    if (!t.lastName) next.lastName = 'Enter a last name.';
    if (!EMAIL.test(t.email)) next.email = 'Enter a valid email address.';
    setErrors(next);
    if (Object.keys(next).length) return;
    busy.current = true;
    create.mutate(t, { onSettled: () => (busy.current = false) });
  };
  return (
    <>
      <PageHeader
        back={{ href: BASE, label: 'Admin access' }}
        eyebrow="Security"
        title="Create admin"
        description="Creates an Admin account (never a super admin). They get an email link to set their own password, then set up two-factor authentication when they first sign in."
      />
      {me && me.role !== 'SUPER_ADMIN' ? (
        <p className="text-[15px] text-foreground-muted">Only a super admin can create admins.</p>
      ) : create.isSuccess ? (
        <div className="grid max-w-2xl gap-4">
          <p className="text-[15px]">The admin account was created. It can’t be used until they set a password and two-factor authentication.</p>
          <InvitationNote result={create.data.invitation} />
          <div className="flex flex-wrap gap-3">
            <Button asChild>
              <Link href={`${BASE}/${create.data.id}`}>View admin</Link>
            </Button>
            <Button asChild variant="outline">
              <Link href={BASE}>Back to admin access</Link>
            </Button>
          </div>
        </div>
      ) : (
        <form onSubmit={submit} noValidate aria-label="Create admin" className="grid max-w-2xl gap-5">
          <div className="grid gap-5 sm:grid-cols-2">
            <TextField id="firstName" label="First name" autoComplete="off" maxLength={100} value={f.firstName} onChange={set('firstName')} error={errors.firstName} />
            <TextField id="lastName" label="Last name" autoComplete="off" maxLength={100} value={f.lastName} onChange={set('lastName')} error={errors.lastName} />
          </div>
          <TextField id="email" label="Email" type="email" autoComplete="off" maxLength={254} value={f.email} onChange={set('email')} error={errors.email} />
          <FormError error={create.error} title="The admin wasn’t created" />
          <Button type="submit" className="w-fit" disabled={create.isPending}>
            {create.isPending && <Spinner />}
            Create admin and send invitation
          </Button>
        </form>
      )}
    </>
  );
}

function ResendInvitation({ id }: { id: string }) {
  const resend = useResendAdminInvitation(id);
  return (
    <div className="grid gap-2">
      <p className="text-sm text-foreground-secondary">This admin hasn’t set a password yet. A new link replaces the previous one.</p>
      {resend.data && <InvitationNote result={resend.data.invitation} />}
      <FormError error={resend.error} />
      <Button variant="outline" className="w-fit" disabled={resend.isPending} onClick={() => !resend.isPending && resend.mutate()}>
        {resend.isPending && <Spinner />}
        Resend invitation
      </Button>
    </div>
  );
}

// ─── Detail ─────────────────────────────────────────────────────────────────

const NOT_FOUND = { title: 'We couldn’t find this administrator', backHref: BASE, backLabel: 'Back to admin access' };

const PERMISSION_TEXT: [keyof AdminAccountDetail['permissions'], string][] = [
  ['adminPortal', 'Use the admin portal (after password and two-factor)'],
  ['manageCustomerAccounts', 'Suspend and reactivate customer accounts'],
  ['manageAdminAccounts', 'Suspend and reactivate admin accounts'],
  ['manageSuperAdminAccounts', 'Suspend and reactivate super admin accounts'],
  ['changeRoles', 'Change anyone’s role'],
];

export function AdminAccessDetail({ id }: { id: string }) {
  const query = useAdminAccount(id);
  const me = useAdminSession().data;
  return (
    <QueryView query={query} notFound={NOT_FOUND} loadingLabel="Loading administrator">
      {(a) => (
        <>
          <PageHeader
            back={{ href: BASE, label: 'Admin access' }}
            eyebrow="Administrator"
            title={personName(a) ?? a.email}
            description={a.email}
            action={<RoleBadge role={a.role} />}
          />
          <div className="grid gap-6 lg:grid-cols-2">
            <Panel title="Access">
              <Facts
                items={[
                  ['Reference', <span key="r" className="font-mono text-sm break-all">{a.id}</span>],
                  ['Role', <RoleBadge key="ro" role={a.role} />],
                  ['Account', <UserStatusBadge key="s" status={a.status} />],
                  ['Two-factor', <MfaBadge key="m" enrolled={a.mfaEnrolled} />],
                  ['Enrolled', a.mfaEnrolledAt ? formatDateTime(a.mfaEnrolledAt) : 'Not enrolled'],
                  ['Last admin sign-in', lastSignIn(a.lastSignInAt)],
                  ['Account created', formatDateTime(a.createdAt)],
                ]}
              />
              <p className="flex items-start gap-2 text-sm text-foreground-muted">
                <Info aria-hidden strokeWidth={1.5} className="mt-0.5 size-4 shrink-0" />
                Enrolment means an authenticator was set up; every admin sign-in still needs a fresh code. A suspension
                applies to the whole account and ends its sessions on the next request.
              </p>
              {a.invitationPending && me?.role === 'SUPER_ADMIN' && <ResendInvitation id={a.id} />}
              {a.viewerCanManage ? (
                <Link href={`/admin/users/${a.id}`} className={`w-fit ${linkClass}`}>
                  Suspend or reactivate on the user page
                </Link>
              ) : (
                <p className="text-sm text-foreground-muted">You can’t change this account’s access.</p>
              )}
            </Panel>
            <Panel title="What this role can do">
              <ul className="grid gap-2">
                {PERMISSION_TEXT.map(([key, text]) => (
                  <li key={key} className="flex items-start gap-2 text-[15px]">
                    {a.permissions[key] ? (
                      <CheckCircle2 aria-hidden className="mt-0.5 size-4 shrink-0 text-success" />
                    ) : (
                      <CircleSlash aria-hidden className="mt-0.5 size-4 shrink-0 text-foreground-muted" />
                    )}
                    <span>
                      <span className="sr-only">{a.permissions[key] ? 'Allowed: ' : 'Not allowed: '}</span>
                      {text}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="text-sm text-foreground-muted">From the server’s own access rules. Roles are assigned by the operator, not in the app.</p>
            </Panel>
          </div>
          <section aria-labelledby="access-history" className="mt-6 grid gap-3">
            <h2 id="access-history" className="flex items-center gap-2 font-heading text-2xl">
              <KeyRound aria-hidden strokeWidth={1.5} className="size-5" />
              Access history
            </h2>
            {a.history.length === 0 ? (
              <p className="text-[15px] text-foreground-muted">No suspensions, reactivations or two-factor setups recorded.</p>
            ) : (
              <DataTable
                caption="Access history"
                rows={a.history}
                rowKey={(h) => h.reference}
                columns={[
                  { header: 'Recorded', cell: (h) => <span className="whitespace-nowrap">{formatTimestamp(h.recordedAt)}</span> },
                  {
                    header: 'Event',
                    cell: (h) => (
                      <Link href={`/admin/audit-logs/${h.reference}`} className={linkClass}>
                        {AUDIT_EVENT_LABEL[h.eventType as keyof typeof AUDIT_EVENT_LABEL] ?? h.eventType}
                      </Link>
                    ),
                  },
                  {
                    header: 'Change',
                    cell: (h) => (h.previousStatus && h.newStatus ? `${STATUS_LABEL[h.previousStatus]} → ${STATUS_LABEL[h.newStatus]}` : '—'),
                  },
                  {
                    header: 'By',
                    cell: (h) => (
                      <span>
                        {AUDIT_ACTOR_LABEL[h.actorType] ?? h.actorType}
                        {h.actorUserId && <span className="font-mono text-xs text-foreground-muted"> {shortId(h.actorUserId)}</span>}
                      </span>
                    ),
                  },
                ]}
              />
            )}
          </section>
        </>
      )}
    </QueryView>
  );
}
