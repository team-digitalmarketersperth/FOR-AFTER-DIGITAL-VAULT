'use client';

import { ScrollText } from 'lucide-react';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { DataTable, Facts, linkClass, Pager, Panel, SelectField, useFilterNav } from '@/components/admin/admin-ui';
import { TextField } from '@/components/shared/form-field';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyState, QueryView } from '@/components/shared/states';
import { Button } from '@/components/ui/button';
import { useAuditLog, useAuditLogs } from '@/hooks/use-admin';
import { AUDIT_EVENT_TYPES, type AuditEventType, type AuditFilters, type AuditLog } from '@/lib/api/admin';
import { AUDIT_ACTOR_LABEL, AUDIT_EVENT_LABEL, auditSummary, keyLabel, safeMetadata, shortId, UUID } from '@/lib/admin';
import { formatDateTime, formatTimestamp, localToOffsetIso } from '@/lib/format';

const BASE = '/admin/audit-logs';

/** What the URL holds: dates as calendar days in the viewer's timezone. */
export type AuditUrlFilters = Omit<AuditFilters, 'from' | 'to'> & { from?: string; to?: string };

export const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Calendar days → the API's ISO instants: start of `from`, end of `to`, local time. */
const toApi = ({ from, to, ...rest }: AuditUrlFilters): AuditFilters => ({
  ...rest,
  from: from ? localToOffsetIso(from, '00:00') : undefined,
  to: to ? localToOffsetIso(to, '23:59').replace('T23:59:00', 'T23:59:59.999') : undefined,
});

/** Read-only by design: the API has no update or delete, and neither does this UI. */
export function AuditList({ filters }: { filters: AuditUrlFilters }) {
  const list = useAuditLogs(toApi(filters));
  const nav = useFilterNav(BASE, filters);
  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Audit logs"
        description="An append-only record of admin sign-ins and actions. Entries can't be edited or deleted."
      />
      <AuditFilterForm key={JSON.stringify(filters)} filters={filters} onApply={(f) => nav.set(f)} />
      <QueryView query={list} loadingLabel="Loading audit events">
        {({ items, pagination }) =>
          items.length === 0 ? (
            <EmptyState icon={ScrollText} title="No audit events match these filters" />
          ) : (
            <div aria-busy={list.isPlaceholderData || undefined}>
              <DataTable
                caption="Audit events"
                rows={items}
                rowKey={(e) => e.id}
                columns={[
                  { header: 'Time', cell: (e) => <span className="whitespace-nowrap">{formatTimestamp(e.createdAt)}</span> },
                  {
                    header: 'Event',
                    cell: (e) => (
                      <Link href={`${BASE}/${e.id}`} className={linkClass}>
                        {AUDIT_EVENT_LABEL[e.eventType] ?? e.eventType}
                      </Link>
                    ),
                  },
                  { header: 'Actor', cell: (e) => <Actor e={e} /> },
                  { header: 'Subject', cell: (e) => <Subject e={e} /> },
                  { header: 'Summary', cell: (e) => auditSummary(e) ?? '—' },
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

const Actor = ({ e }: { e: AuditLog }) => (
  <span title={e.actorUserId ?? undefined}>
    {AUDIT_ACTOR_LABEL[e.actorType] ?? e.actorType}
    {e.actorUserId && <span className="font-mono text-xs text-foreground-muted"> {shortId(e.actorUserId)}</span>}
  </span>
);

const Subject = ({ e }: { e: AuditLog }) =>
  e.subjectType ? (
    <span title={e.subjectId ?? undefined}>
      {e.subjectType}
      {e.subjectId && <span className="font-mono text-xs text-foreground-muted"> {shortId(e.subjectId)}</span>}
    </span>
  ) : (
    '—'
  );

/** Applied on submit (not per keystroke); ids are checked before they reach the URL. */
function AuditFilterForm({ filters, onApply }: { filters: AuditUrlFilters; onApply: (f: Partial<AuditUrlFilters>) => void }) {
  const [f, setF] = useState(filters);
  const [errors, setErrors] = useState<Partial<Record<keyof AuditUrlFilters, string>>>({});
  const field = (k: 'actorUserId' | 'subjectType' | 'subjectId' | 'from' | 'to') => ({
    value: f[k] ?? '',
    error: errors[k],
    onChange: (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value || undefined }),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = Object.fromEntries(
      Object.entries(f).map(([k, v]) => [k, typeof v === 'string' ? v.trim() || undefined : v]),
    ) as AuditUrlFilters;
    const next: typeof errors = {};
    if (trimmed.actorUserId && !UUID.test(trimmed.actorUserId)) next.actorUserId = 'Enter a full user ID.';
    if (trimmed.subjectType && !/^[A-Za-z]{1,50}$/.test(trimmed.subjectType)) next.subjectType = 'Letters only, e.g. User.';
    if (trimmed.from && trimmed.to && trimmed.from > trimmed.to) next.to = 'Must be on or after the start date.';
    setErrors(next);
    if (Object.keys(next).length === 0) onApply({ ...trimmed });
  };
  const hasFilters = Object.entries(filters).some(([k, v]) => k !== 'page' && v);
  return (
    <form onSubmit={submit} noValidate aria-label="Filter audit events" className="mb-8 grid gap-4 rounded-xl border border-border bg-surface p-5">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <SelectField
          id="eventType"
          label="Event"
          value={f.eventType ?? ''}
          onChange={(e) => setF({ ...f, eventType: (e.target.value || undefined) as AuditEventType | undefined })}
          options={[{ value: '', label: 'All events' }, ...AUDIT_EVENT_TYPES.map((t) => ({ value: t, label: AUDIT_EVENT_LABEL[t] }))]}
        />
        <TextField id="actorUserId" label="Actor user ID" spellCheck={false} className="font-mono" {...field('actorUserId')} />
        <TextField id="subjectType" label="Subject type" placeholder="User, DeathVerificationCase, Job" {...field('subjectType')} />
        <TextField id="subjectId" label="Subject ID" spellCheck={false} maxLength={200} className="font-mono" {...field('subjectId')} />
        <TextField id="from" label="From" type="date" {...field('from')} />
        <TextField id="to" label="To" type="date" {...field('to')} />
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

// ─── Detail ─────────────────────────────────────────────────────────────────

const NOT_FOUND = { title: 'We couldn’t find this audit event', backHref: BASE, backLabel: 'Back to audit logs' };

const subjectHref = (type: string | null, id: string | null) =>
  !id || !UUID.test(id)
    ? null
    : type === 'User'
      ? `/admin/users/${id}`
      : type === 'DeathVerificationCase'
        ? `/admin/death-verifications/${id}`
        : null;

export function AuditDetail({ id }: { id: string }) {
  const query = useAuditLog(id);
  return (
    <QueryView query={query} notFound={NOT_FOUND} loadingLabel="Loading audit event">
      {(e) => {
        const subject = subjectHref(e.subjectType, e.subjectId);
        const metadata = safeMetadata(e.metadata);
        return (
          <>
            <PageHeader
              back={{ href: BASE, label: 'Audit logs' }}
              eyebrow="Audit event"
              title={AUDIT_EVENT_LABEL[e.eventType] ?? e.eventType}
              description={formatDateTime(e.createdAt)}
            />
            <div className="grid gap-6 lg:grid-cols-2">
              <Panel title="Event">
                <Facts
                  items={[
                    ['Event type', <span key="t" className="font-mono text-sm">{e.eventType}</span>],
                    ['Actor', AUDIT_ACTOR_LABEL[e.actorType] ?? e.actorType],
                    [
                      'Actor user',
                      e.actorUserId ? (
                        <Link key="a" href={`/admin/users/${e.actorUserId}`} className={`font-mono text-sm ${linkClass}`}>
                          {e.actorUserId}
                        </Link>
                      ) : null,
                    ],
                    ['Subject type', e.subjectType],
                    [
                      'Subject',
                      subject ? (
                        <Link key="s" href={subject} className={`font-mono text-sm ${linkClass}`}>
                          {e.subjectId}
                        </Link>
                      ) : (
                        e.subjectId && <span className="font-mono text-sm">{e.subjectId}</span>
                      ),
                    ],
                    ['Network', e.ipPrefix],
                    ['Browser', e.userAgent],
                    ['Audit ID', <span key="id" className="font-mono text-sm">{e.id}</span>],
                  ]}
                />
              </Panel>
              <div className="grid content-start gap-6">
                <Panel title="Details">
                  {metadata.length === 0 ? (
                    <p className="text-[15px] text-foreground-muted">No further details were recorded.</p>
                  ) : (
                    <Facts items={metadata.map(([k, v]) => [keyLabel(k), v === null ? '—' : String(v)])} />
                  )}
                  <p className="text-sm text-foreground-muted">
                    Network is a /24 or /48 prefix, never a full IP address. Passwords, codes, secrets and private content
                    are never recorded.
                  </p>
                </Panel>
                <nav aria-label="Related audit events" className="grid gap-2 text-sm">
                  {e.actorUserId && (
                    <Link href={`${BASE}?actorUserId=${e.actorUserId}`} className={`w-fit ${linkClass}`}>
                      All events by this admin
                    </Link>
                  )}
                  {e.subjectType && e.subjectId && (
                    <Link
                      href={`${BASE}?subjectType=${encodeURIComponent(e.subjectType)}&subjectId=${encodeURIComponent(e.subjectId)}`}
                      className={`w-fit ${linkClass}`}
                    >
                      All events for this subject
                    </Link>
                  )}
                </nav>
              </div>
            </div>
          </>
        );
      }}
    </QueryView>
  );
}
