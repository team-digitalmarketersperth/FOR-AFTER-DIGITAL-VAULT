'use client';

import { AlertTriangle, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { CaseStatusBadge, DataTable, Facts, linkClass, Pager, Panel, useFilterNav, UserStatusBadge } from '@/components/admin/admin-ui';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { FilterChips, TextAreaField } from '@/components/shared/form-field';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyState, QueryView } from '@/components/shared/states';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useDeathCase, useDeathCases, useRejectDeath, useVerifyDeath } from '@/hooks/use-admin';
import { DECISION_NOTE_MAX, type CaseFilters, type DeathCaseDetail } from '@/lib/api/admin';
import type { ApiError } from '@/lib/api/errors';
import type { CaseStatus } from '@/lib/api/portals';
import { CASE_EVENT_LABEL, shortId } from '@/lib/admin';
import { ADMIN_STATUS } from '@/lib/death-verification';
import { formatCalendarDate, formatDate, formatDateTime, localToOffsetIso, timeZoneLabel } from '@/lib/format';

const BASE = '/admin/death-verifications';

// Decision work first, then open cases, then closed ones.
const FILTER_ORDER: CaseStatus[] = [
  'READY_FOR_REVIEW',
  'SAFEGUARD_ACTIVE',
  'PENDING_VERIFICATION',
  'VERIFIED',
  'REJECTED',
  'CANCELLED',
];

export function CaseList({ filters }: { filters: CaseFilters }) {
  const list = useDeathCases(filters);
  const nav = useFilterNav(BASE, filters);
  return (
    <>
      <PageHeader
        eyebrow="Management"
        title="Death verification"
        description="Reports from trusted contacts. A case can only be decided once the safety notice was sent and the safeguard period has ended."
      />
      <FilterChips
        label="Filter by status"
        chips={[
          { label: 'All', href: BASE, active: !filters.status },
          ...FILTER_ORDER.map((s) => ({
            label: ADMIN_STATUS[s].label,
            href: nav.href({ status: s, page: undefined }),
            active: filters.status === s,
          })),
        ]}
      />
      <QueryView query={list} loadingLabel="Loading cases">
        {({ items, pagination }) =>
          items.length === 0 ? (
            <EmptyState
              icon={ShieldCheck}
              title={filters.status === 'READY_FOR_REVIEW' ? 'No cases ready for review' : 'No cases match this filter'}
            />
          ) : (
            <div aria-busy={list.isPlaceholderData || undefined}>
              <DataTable
                caption="Death verification cases"
                rows={items}
                rowKey={(c) => c.caseId}
                columns={[
                  {
                    header: 'Account holder',
                    cell: (c) => (
                      <Link href={`${BASE}/${c.caseId}`} className={linkClass}>
                        {c.accountHolder.displayName ?? c.accountHolder.email}
                      </Link>
                    ),
                  },
                  { header: 'Email', cell: (c) => c.accountHolder.email },
                  { header: 'Status', cell: (c) => <CaseStatusBadge status={c.status} /> },
                  { header: 'Opened', cell: (c) => formatDate(c.openedAt) },
                  { header: 'Safeguard ends', cell: (c) => (c.safeguardEndsAt ? formatDate(c.safeguardEndsAt) : '—') },
                  { header: 'Reports', cell: (c) => c.reportCount },
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
          <div className="flex flex-wrap gap-3">
            <VerifyAction c={c} name={name} onConflict={onConflict} />
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
