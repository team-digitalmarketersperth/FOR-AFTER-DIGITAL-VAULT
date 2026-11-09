'use client';

import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Ban,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleSlash,
  Clock,
  Info,
  Mail,
  RefreshCw,
  Search,
  TriangleAlert,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Badge, DataTable, linkClass } from '@/components/admin/admin-ui';
import { CopyButton } from '@/components/shared/copy-button';
import { FormError } from '@/components/shared/form-field';
import { EmptyState, ErrorState, Spinner } from '@/components/shared/states';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { useBroadcast, useCancelBroadcast, useRecipient, useRecipients, useRetry, useRetryReview, useRunEmail } from '@/hooks/use-announcements';
import { adminKeys } from '@/lib/query/query-client';
import type { AudienceScope, Broadcast, BroadcastStatus, RecipientResult, RecipientState } from '@/lib/api/announcements';
import { personName } from '@/lib/admin';
import { formatDateTime, formatTimestamp, timeZoneLabel } from '@/lib/format';
import { cn } from '@/lib/utils';

const ANNOUNCEMENTS = '/admin/announcements';

export const RUNNING: BroadcastStatus[] = ['PREPARING', 'SENDING'];
const ISSUES: RecipientState[] = ['FAILED', 'UNKNOWN', 'SKIPPED', 'CANCELLED'];
const RUN_LABEL: Record<BroadcastStatus, string> = {
  PREPARING: 'Preparing audience',
  SENDING: 'Sending',
  COMPLETED: 'Completed',
  CANCELLED: 'Stopped',
  BLOCKED: 'Stopped by server',
};
/** Completed means processing ended, not that every email was accepted: any failed/unknown/skipped/cancelled recipient shows. */
export const runLabel = (status: BroadcastStatus, issues: number) =>
  status === 'COMPLETED' && issues > 0 ? 'Completed with issues' : RUN_LABEL[status];
export const runTone = (status: BroadcastStatus): 'danger' | 'open' | 'neutral' =>
  status === 'BLOCKED' ? 'danger' : RUNNING.includes(status) ? 'open' : 'neutral';
const runTone2 = (b: Broadcast, issues: number): 'danger' | 'open' | 'neutral' | 'warning' | 'done' =>
  b.status === 'COMPLETED' ? (issues ? 'warning' : 'done') : runTone(b.status);
const AUDIENCE_LABEL: Record<AudienceScope, string> = { PILOT: 'Pilot group', ALL_ELIGIBLE: 'All eligible customers' };

/** One state each: every recipient is in exactly one. Colours are paired with icons and text everywhere. */
const STATE: Record<RecipientState, { label: string; short: string; icon: LucideIcon; tone: 'done' | 'danger' | 'warning' | 'open' | 'neutral'; color: string }> = {
  ACCEPTED: { label: 'Accepted by provider', short: 'Accepted', icon: Check, tone: 'done', color: 'color-mix(in srgb, var(--success) 70%, white)' },
  FAILED: { label: 'Failed', short: 'Failed', icon: X, tone: 'danger', color: 'color-mix(in srgb, var(--danger) 65%, white)' },
  UNKNOWN: { label: 'Unknown outcome', short: 'Unknown', icon: TriangleAlert, tone: 'warning', color: 'var(--brand-gold)' },
  QUEUED: { label: 'Waiting to send', short: 'Pending', icon: Clock, tone: 'open', color: 'var(--brand-aubergine)' },
  PROCESSING: { label: 'Sending now', short: 'Sending', icon: Clock, tone: 'open', color: 'var(--brand-lilac)' },
  SKIPPED: { label: 'Skipped', short: 'Skipped', icon: CircleSlash, tone: 'neutral', color: 'var(--border-strong)' },
  CANCELLED: { label: 'Cancelled before sending', short: 'Cancelled', icon: Ban, tone: 'neutral', color: 'var(--brand-stone)' },
};
const CHART_ORDER: RecipientState[] = ['ACCEPTED', 'FAILED', 'UNKNOWN', 'QUEUED', 'PROCESSING', 'SKIPPED', 'CANCELLED'];

const UNKNOWN_TEXT = 'Provider outcome is uncertain. Do not resend until reconciled.';
// Safe categories only (skip reasons and short provider codes); never a provider response.
const REASON: Record<string, string> = {
  account_unavailable: 'Account no longer available',
  email_invalid: 'Email missing or invalid',
  email_not_verified: 'Email no longer verified',
  email_changed: 'Email changed after the audience was prepared',
  open_death_report: 'Open death report',
  suppressed: 'Unsubscribed, bounced or complained',
  no_consent: 'No longer opted in to product news',
  broadcast_disabled: 'Customer broadcasting was turned off on the server',
  policy_blocked: 'Communication policy not confirmed or changed',
  worker_interrupted: 'Sending was interrupted; the provider may have accepted it',
  manual_retry: 'Queued again by a manual retry',
  rate_limit_exceeded: 'Email provider throttling',
  unauthorized: 'Email provider sign-in refused',
  token_unavailable: 'Email provider sign-in unavailable',
  auth_rejected: 'Email provider sign-in rejected',
  ErrorInvalidRecipients: 'Invalid address',
  mailbox_not_found: 'Sender mailbox not found',
  timeout: 'No response from the provider',
  network_error: 'Network error reaching the provider',
};
// Why a FAILED row cannot be retried (server's retryBlockedReason).
const RETRY_BLOCK: Record<string, string> = {
  permanent_failure: 'Permanent failure',
  retry_limit_reached: 'Retry limit reached',
  run_stopped: 'Send was stopped',
  run_blocked: 'Send was stopped by the server',
  run_preparing: 'Audience still being prepared',
  pilot_only: 'Server allows pilot sends only',
  broadcast_disabled: 'Broadcasting is off',
};
const retryBlockText = (code: string) => RETRY_BLOCK[code] ?? REASON[code] ?? 'Not retryable';

function reasonText(r: Pick<RecipientResult, 'status' | 'reasonCode'>) {
  if (r.status === 'UNKNOWN') return UNKNOWN_TEXT;
  if (r.status === 'ACCEPTED') return 'Accepted by Microsoft';
  if (!r.reasonCode) return r.status === 'QUEUED' ? 'Not sent yet' : '—';
  const label = REASON[r.reasonCode] ?? (r.reasonCode.startsWith('forbidden_') ? 'Sender not permitted to send' : 'Provider rejected the email');
  return r.status === 'QUEUED' && r.reasonCode !== 'manual_retry' ? `${label} (waiting to retry)` : label;
}

const n = (v: number) => v.toLocaleString('en-AU');
const pct = (v: number, total: number) => (total ? `${Math.round((v / total) * 100)}%` : '0%');
const who = (a: { firstName: string | null; lastName: string | null; email: string }) => personName(a) ?? a.email;
// An active run with no recorded change for this long (and not deliberately paused) suggests a stopped worker.
const STALE_MS = 5 * 60_000;

/** The queued email (or a draft) in a sandboxed frame: no scripts, no navigation. */
export function EmailFrame({ html }: { html: string }) {
  // shortcut: height measured on load only; a later width change can leave a little slack. Observe resizes if it matters.
  const fit = (frame: HTMLIFrameElement) => {
    const doc = frame.contentDocument;
    if (doc) frame.style.height = `${doc.documentElement.scrollHeight}px`;
  };
  return (
    <iframe
      title="Email preview"
      sandbox="allow-same-origin"
      srcDoc={html}
      onLoad={(e) => fit(e.currentTarget)}
      className="h-[480px] w-full rounded-lg border border-border bg-brand-ivory"
    />
  );
}

/**
 * Results of a customer send, from the database: run state, recipient outcomes
 * (each recipient counted once), the immutable email, per-recipient results and
 * safe manual retry. Polls only while the run is active.
 */
export function AnnouncementResults({ id, runId }: { id: string; runId: string }) {
  const run = useBroadcast(id, runId);
  const qc = useQueryClient();
  const b = run.data;
  const refresh = () => void qc.invalidateQueries({ queryKey: [...adminKeys.announcements, id, 'broadcast', runId] });

  return (
    <>
      <header className="mb-6 grid gap-3">
        <Link
          href={ANNOUNCEMENTS}
          className="inline-flex w-fit items-center gap-2 rounded-sm text-sm text-foreground-muted outline-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring"
        >
          <ArrowLeft aria-hidden strokeWidth={1.5} className="size-4" />
          Notification centre
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <h1 className="text-[34px] leading-[1.05] break-words sm:text-[42px]">Announcement results</h1>
          <div className="flex flex-wrap items-center gap-3">
            {run.dataUpdatedAt > 0 && (
              <p className="text-sm text-foreground-muted" aria-live="polite">
                Last refreshed {new Date(run.dataUpdatedAt).toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit', second: '2-digit' })}
              </p>
            )}
            <Button type="button" variant="outline" onClick={refresh} disabled={run.isFetching}>
              <RefreshCw aria-hidden strokeWidth={1.5} className={cn('size-4', run.isFetching && 'animate-spin motion-reduce:animate-none')} />
              Refresh
            </Button>
          </div>
        </div>
        {b && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <p className="font-heading text-2xl break-words text-foreground">{b.subject}</p>
            <StatusBadge b={b} />
          </div>
        )}
      </header>

      {run.isPending ? (
        <p className="flex items-center gap-2 text-foreground-muted">
          <Spinner /> Loading results…
        </p>
      ) : !b ? (
        // Never zeros: without data nothing is shown as verified.
        <ErrorState title="Results are unavailable" message="The send results could not be loaded. Nothing is shown until they can be." onRetry={refresh} />
      ) : (
        <Results id={id} runId={runId} b={b} stale={run.isError} checkedAt={run.dataUpdatedAt} />
      )}
    </>
  );
}

function StatusBadge({ b }: { b: Broadcast }) {
  const issues = ISSUES.reduce((sum, k) => sum + b.counts[k], 0);
  return <Badge tone={runTone2(b, issues)}>{b.stopping ? 'Stopping…' : runLabel(b.status, issues)}</Badge>;
}

function Results({ id, runId, b, stale, checkedAt }: { id: string; runId: string; b: Broadcast; stale: boolean; checkedAt: number }) {
  const active = RUNNING.includes(b.status);
  const pending = b.counts.QUEUED + b.counts.PROCESSING;
  return (
    <div className="grid min-w-0 gap-6">
      {stale && (
        <p role="alert" className="rounded-lg bg-warning/10 px-4 py-3 text-sm">
          Couldn’t refresh the results. Showing the last known state, recorded {formatDateTime(b.lastUpdatedAt)}.
        </p>
      )}
      <section aria-label="Summary" className="grid gap-3">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <SummaryCard icon={Users} label="Total recipients" value={b.audiencePrepared ? n(b.prepared) : `${n(b.prepared)} so far`} />
          <SummaryCard icon={Check} label="Accepted by provider" value={n(b.counts.ACCEPTED)} tone="done" />
          <SummaryCard icon={X} label="Failed" value={n(b.counts.FAILED)} tone="danger" />
          <SummaryCard icon={TriangleAlert} label="Unknown outcome" value={n(b.counts.UNKNOWN)} tone="warning" />
        </div>
        {(pending > 0 || b.counts.SKIPPED > 0 || b.counts.CANCELLED > 0) && (
          <ul aria-label="Other outcomes" className="flex flex-wrap gap-2 text-sm">
            {(['QUEUED', 'PROCESSING', 'SKIPPED', 'CANCELLED'] as const)
              .filter((k) => b.counts[k] > 0)
              .map((k) => (
                <li key={k} className="rounded-full border border-border bg-surface px-3 py-1 text-foreground-secondary">
                  {STATE[k].label}: <span className="tabular-nums">{n(b.counts[k])}</span>
                </li>
              ))}
          </ul>
        )}
      </section>

      <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="grid content-start gap-3">
          <OutcomesCard b={b} />
          <p className="flex items-center gap-2 text-sm text-foreground-muted">
            <Info aria-hidden strokeWidth={1.5} className="size-4 shrink-0" />
            Provider acceptance does not confirm inbox delivery.
          </p>
        </div>
        <RunDetails id={id} runId={runId} b={b} checkedAt={checkedAt} />
      </div>

      {!active && (
        <p className="text-sm text-foreground-muted">
          Completed means processing has ended, not that every customer received the email.
          {(b.status === 'CANCELLED' || b.counts.CANCELLED > 0) &&
            ' An email already handed to the provider when sending was stopped keeps its real outcome and may still have been accepted.'}
        </p>
      )}

      <RecipientResults id={id} runId={runId} b={b} />
    </div>
  );
}

function SummaryCard({ icon: Icon, label, value, tone }: { icon: LucideIcon; label: string; value: string; tone?: 'done' | 'danger' | 'warning' }) {
  return (
    <div className="flex items-center gap-4 rounded-xl border border-border bg-surface p-5">
      <span
        aria-hidden
        className={cn(
          'grid size-11 shrink-0 place-items-center rounded-lg',
          !tone && 'bg-primary-soft text-primary',
          tone === 'done' && 'bg-success/10 text-success',
          tone === 'danger' && 'bg-danger/10 text-danger',
          tone === 'warning' && 'bg-warning/10 text-warning',
        )}
      >
        <Icon strokeWidth={1.5} className="size-5" />
      </span>
      <div className="grid min-w-0">
        <span className="text-sm text-foreground-secondary">{label}</span>
        <span
          className={cn(
            'font-heading text-3xl leading-tight tabular-nums',
            tone === 'done' && 'text-success',
            tone === 'danger' && 'text-danger',
            tone === 'warning' && 'text-warning',
          )}
        >
          {value}
        </span>
      </div>
    </div>
  );
}

const R = 48;
const C = 2 * Math.PI * R;

/** Donut of recipient states from the server's counts; the legend is the text equivalent. */
function OutcomesCard({ b }: { b: Broadcast }) {
  const total = CHART_ORDER.reduce((sum, k) => sum + b.counts[k], 0);
  const shown = CHART_ORDER.filter((k) => b.counts[k] > 0 || ['ACCEPTED', 'FAILED', 'UNKNOWN'].includes(k));
  const present = CHART_ORDER.filter((k) => b.counts[k] > 0);
  const segments = present.map((k, i) => ({
    k,
    len: (b.counts[k] / total) * C,
    offset: (present.slice(0, i).reduce((sum, j) => sum + b.counts[j], 0) / total) * C,
  }));
  const summary = total
    ? `Email outcomes for ${n(total)} ${total === 1 ? 'recipient' : 'recipients'}: ` +
      CHART_ORDER.filter((k) => b.counts[k] > 0)
        .map((k) => `${STATE[k].label} ${n(b.counts[k])} (${pct(b.counts[k], total)})`)
        .join(', ')
    : 'No recipients yet';
  return (
    <section aria-labelledby="outcomes-heading" className="grid gap-5 rounded-xl border border-border bg-surface p-5 sm:p-7">
      <h2 id="outcomes-heading" className="text-2xl">
        Email outcomes
      </h2>
      <div className="grid items-center gap-6 sm:grid-cols-[auto_minmax(0,1fr)] sm:gap-10">
        <figure className="relative mx-auto size-48 sm:size-52">
          <svg viewBox="0 0 120 120" role="img" aria-label={summary} className="size-full -rotate-90">
            <circle cx="60" cy="60" r={R} fill="none" strokeWidth="16" style={{ stroke: 'var(--surface-muted)' }} />
            {segments.map((s) => (
              <circle
                key={s.k}
                cx="60"
                cy="60"
                r={R}
                fill="none"
                strokeWidth="16"
                strokeDasharray={`${s.len} ${C - s.len}`}
                strokeDashoffset={-s.offset}
                style={{ stroke: STATE[s.k].color } as CSSProperties}
              />
            ))}
          </svg>
          <figcaption aria-hidden className="absolute inset-0 grid place-content-center text-center">
            <span className="font-heading text-4xl leading-none tabular-nums">{n(total)}</span>
            <span className="text-sm text-foreground-muted">{total === 1 ? 'recipient' : 'recipients'}</span>
          </figcaption>
        </figure>
        <ul aria-label="Outcome legend" className="grid min-w-0 divide-y divide-border sm:border-l sm:border-border sm:pl-8">
          {shown.map((k) => {
            const Icon = STATE[k].icon;
            return (
              <li key={k} className="flex items-center justify-between gap-4 py-3 text-[15px]">
                <span className="flex min-w-0 items-center gap-3">
                  <span aria-hidden className="size-3.5 shrink-0 rounded-[4px]" style={{ background: STATE[k].color }} />
                  <Icon aria-hidden strokeWidth={1.5} className="size-4 shrink-0 text-foreground-muted" />
                  {STATE[k].label}
                </span>
                <span className="shrink-0 tabular-nums">
                  {n(b.counts[k])} <span className="text-sm text-foreground-muted">· {pct(b.counts[k], total)}</span>
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}

function RunDetails({ id, runId, b, checkedAt }: { id: string; runId: string; b: Broadcast; checkedAt: number }) {
  const cancel = useCancelBroadcast(id);
  const [stopOpen, setStopOpen] = useState(false);
  const [emailOpen, setEmailOpen] = useState(false);
  const email = useRunEmail(id, runId, emailOpen);
  const active = RUNNING.includes(b.status);
  const time = (iso: string | null) => (iso ? formatTimestamp(iso) : 'Not yet');
  const stop = () =>
    cancel.mutate(runId, {
      onSuccess: () => {
        setStopOpen(false);
        toast.success('Stopping. No new emails will be sent.');
      },
    });
  const rows: [string, ReactNode][] = [
    ['Audience', AUDIENCE_LABEL[b.audience]],
    ['Version', String(b.announcementVersion)],
    ['Requested by', who(b.requestedBy)],
    [
      'Run reference',
      <span key="ref" className="grid gap-2">
        <code className="text-xs break-all">{b.id}</code>
        <CopyButton value={b.id} label="Copy reference" />
      </span>,
    ],
    ['Requested', time(b.createdAt)],
    ['Started', time(b.preparedAt)],
    ['Completed', time(b.completedAt)],
    ['Processing', <StatusBadge key="state" b={b} />],
  ];
  const retries = b.retry?.activity ?? [];
  return (
    <section aria-labelledby="run-heading" className="grid content-start gap-5 rounded-xl border border-border bg-surface p-5 sm:p-7">
      <h2 id="run-heading" className="text-2xl">
        Run details
      </h2>
      <dl className="grid divide-y divide-border text-[15px]">
        {rows.map(([label, value]) => (
          <div key={label} className="grid grid-cols-[8rem_minmax(0,1fr)] items-start gap-4 py-2.5">
            <dt className="text-foreground-secondary">{label}</dt>
            <dd className="min-w-0 break-words">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="text-xs text-foreground-muted">Times in {timeZoneLabel(new Date(b.lastUpdatedAt))}.</p>

      {active && b.pausedUntil && (
        <p className="rounded-lg bg-warning/10 px-4 py-3 text-sm">
          Paused until {formatDateTime(b.pausedUntil)}: waiting for the email provider’s throttling window or the daily broadcast limit. Sending
          resumes automatically.
        </p>
      )}
      {active && !b.pausedUntil && checkedAt - Date.parse(b.lastUpdatedAt) > STALE_MS && (
        <p role="alert" className="rounded-lg bg-warning/10 px-4 py-3 text-sm">
          No progress has been recorded for over {STALE_MS / 60_000} minutes. The background worker may be unavailable: check{' '}
          <Link href="/admin/system/health" className={linkClass}>
            System health
          </Link>
          . Nothing is lost; the run resumes when the worker is back.
        </p>
      )}
      {b.status === 'BLOCKED' && b.finishReason && (
        <p className="rounded-lg bg-danger/10 px-4 py-3 text-sm text-danger">Stopped by the server: {REASON[b.finishReason] ?? b.finishReason}.</p>
      )}

      <div className="flex flex-wrap gap-3">
        <Dialog open={emailOpen} onOpenChange={setEmailOpen}>
          <DialogTrigger asChild>
            <Button type="button" variant="outline" className="w-fit">
              <Mail aria-hidden strokeWidth={1.5} className="size-4" />
              View email
            </Button>
          </DialogTrigger>
          <DialogContent className="max-h-[90vh] gap-5 overflow-y-auto rounded-xl bg-surface p-6 sm:max-w-2xl sm:p-8">
            <DialogHeader>
              <DialogTitle>Email as queued</DialogTitle>
              <DialogDescription>
                The content fixed when this send was queued (version {b.announcementVersion}). Read only; the unsubscribe link here is not personal.
              </DialogDescription>
            </DialogHeader>
            {email.isPending ? (
              <p className="flex items-center gap-2 text-sm text-foreground-muted">
                <Spinner /> Loading the email…
              </p>
            ) : email.data ? (
              <>
                <p className="text-sm">
                  <span className="text-foreground-muted">Subject:</span> {email.data.subject}
                </p>
                <EmailFrame html={email.data.html} />
              </>
            ) : (
              <FormError error={email.error} />
            )}
          </DialogContent>
        </Dialog>

        {active && !b.stopping && (
          <Dialog open={stopOpen} onOpenChange={(next) => !cancel.isPending && setStopOpen(next)}>
            <DialogTrigger asChild>
              <Button type="button" variant="outline" className="w-fit">
                Stop sending
              </Button>
            </DialogTrigger>
            <DialogContent className="gap-6 rounded-xl bg-surface p-7 sm:max-w-md sm:p-8" showCloseButton={false}>
              <DialogHeader>
                <DialogTitle>Stop sending?</DialogTitle>
                <DialogDescription>Customers who have not been sent this announcement yet will not receive it.</DialogDescription>
              </DialogHeader>
              <p className="text-sm text-foreground-secondary">
                Emails already accepted by the provider cannot be recalled. An email being sent at this moment may still be accepted.
              </p>
              <FormError error={cancel.error} />
              <DialogFooter className="mx-0 mb-0 flex-col-reverse gap-3 rounded-none border-0 bg-transparent p-0 sm:flex-row">
                <Button type="button" variant="outline" disabled={cancel.isPending} onClick={() => setStopOpen(false)}>
                  Keep sending
                </Button>
                <Button type="button" variant="destructive" disabled={cancel.isPending} onClick={stop}>
                  {cancel.isPending && <Spinner />}
                  Stop sending
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
      </div>

      {retries.length > 0 && (
        <div className="grid gap-2 border-t border-border pt-4">
          <h3 className="text-sm font-medium">Retry requests</h3>
          <ul className="grid gap-1 text-sm text-foreground-secondary">
            {retries.map((r) => (
              <li key={r.id}>
                {formatTimestamp(r.createdAt)}: {n(r.recipientCount)} {r.recipientCount === 1 ? 'recipient' : 'recipients'} (
                {r.scope === 'ONE' ? 'single' : 'eligible failures'}) by {who(r.requestedBy)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

type Filter = 'ALL' | RecipientState;

function RecipientResults({ id, runId, b }: { id: string; runId: string; b: Broadcast }) {
  const [filter, setFilter] = useState<Filter>('ALL');
  const [typed, setTyped] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [retryFor, setRetryFor] = useState<{ recipient?: RecipientResult } | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const active = RUNNING.includes(b.status);
  const list = useRecipients(id, runId, { status: filter === 'ALL' ? undefined : filter, q: q || undefined, page }, active);
  const retry = b.retry;

  // Search as you type, after a short pause (one request, not one per key).
  useEffect(() => {
    const t = setTimeout(() => {
      setQ(typed.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [typed]);

  const filters: Filter[] = ['ALL', 'ACCEPTED', 'FAILED', 'UNKNOWN', 'QUEUED', 'PROCESSING', 'SKIPPED', 'CANCELLED'];
  const count = (f: Filter) => (f === 'ALL' ? b.prepared : b.counts[f]);
  const visible = filters.filter((f) => f === 'ALL' || f === filter || ['ACCEPTED', 'FAILED', 'UNKNOWN'].includes(f) || count(f) > 0);
  const data = list.data;

  return (
    <section aria-labelledby="recipients-heading" className="grid min-w-0 gap-5 rounded-xl border border-border bg-surface p-5 sm:p-7">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="recipients-heading" className="text-2xl">
          Recipient results
        </h2>
        {retry && retry.eligible > 0 && (
          <Button type="button" onClick={() => setRetryFor({})} disabled={!!retry.blockedReason} aria-describedby={retry.blockedReason ? 'retry-unavailable' : undefined}>
            <RefreshCw aria-hidden strokeWidth={1.5} className="size-4" />
            Retry eligible failures ({n(retry.eligible)})
          </Button>
        )}
      </div>
      {retry?.blockedReason && retry.eligible > 0 && (
        <p id="retry-unavailable" className="rounded-lg bg-warning/10 px-4 py-3 text-sm">
          Retry is unavailable: {RETRY_UNAVAILABLE[retry.blockedReason] ?? retryBlockText(retry.blockedReason)}.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <label className="relative w-full sm:w-72">
          <span className="sr-only">Search recipients</span>
          <Search aria-hidden strokeWidth={1.5} className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-foreground-muted" />
          <input
            type="search"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="Search recipients…"
            maxLength={100}
            className="h-10 w-full rounded-lg border border-border-strong bg-surface pr-3 pl-9 text-sm outline-none focus-visible:outline-2 focus-visible:outline-ring"
          />
        </label>
        <div role="group" aria-label="Filter by outcome" className="flex flex-wrap gap-2">
          {visible.map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={filter === f}
              onClick={() => {
                setFilter(f);
                setPage(1);
              }}
              className={cn(
                'inline-flex min-h-9 items-center gap-2 rounded-full border px-3.5 text-sm outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                filter === f ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-surface hover:border-border-strong',
              )}
            >
              {f === 'ALL' ? 'All' : STATE[f].short}
              <span className={cn('text-xs tabular-nums', filter === f ? 'opacity-80' : 'text-foreground-muted')}>{n(count(f))}</span>
            </button>
          ))}
        </div>
      </div>

      {list.isPending ? (
        <p className="flex items-center gap-2 text-sm text-foreground-muted">
          <Spinner /> Loading recipients…
        </p>
      ) : !data ? (
        <ErrorState title="Recipient results are unavailable" message="They could not be loaded. Nothing is shown until they can be." onRetry={() => void list.refetch()} />
      ) : data.items.length === 0 ? (
        <EmptyState icon={Users} title={q || filter !== 'ALL' ? 'No recipients match' : 'No recipients yet'} description={q || filter !== 'ALL' ? 'Try another search or filter.' : 'Recipients appear once the audience is prepared.'} />
      ) : (
        <div aria-busy={list.isPlaceholderData || undefined} className={cn('grid gap-3', list.isPlaceholderData && 'opacity-70')}>
          {list.isError && (
            <p role="alert" className="rounded-lg bg-warning/10 px-4 py-3 text-sm">
              Couldn’t refresh the recipient list. Showing the last loaded page.
            </p>
          )}
          <DataTable
            caption="Recipient results"
            rows={data.items}
            rowKey={(r) => r.id}
            columns={[
              {
                header: 'Recipient',
                cell: (r) =>
                  r.email ? (
                    <span className="grid">
                      <span className="break-all">{r.email}</span>
                      {r.name && <span className="text-xs text-foreground-muted">{r.name}</span>}
                    </span>
                  ) : (
                    <span className="grid">
                      <span className="italic text-foreground-secondary">Address changed since this email was prepared</span>
                      {r.name && <span className="text-xs text-foreground-muted">{r.name}</span>}
                    </span>
                  ),
              },
              { header: 'Outcome', cell: (r) => <OutcomeBadge state={r.status} /> },
              { header: 'Last attempt', cell: (r) => (r.lastAttemptAt ? formatTimestamp(r.lastAttemptAt) : '—') },
              { header: 'Attempts', cell: (r) => <span className="tabular-nums">{r.attemptCount}</span> },
              { header: 'Reason', cell: (r) => reasonText(r) },
              {
                header: 'Action',
                cell: (r) =>
                  r.retryable ? (
                    <Button type="button" size="sm" variant="outline" onClick={() => setRetryFor({ recipient: r })} aria-label={`Retry ${r.email ?? 'this recipient'}`}>
                      Retry
                    </Button>
                  ) : (
                    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      {r.status === 'FAILED' && r.retryBlockedReason && (
                        <span className="text-sm text-foreground-muted">{retryBlockText(r.retryBlockedReason)}</span>
                      )}
                      <button
                        type="button"
                        className={cn(linkClass, 'text-sm')}
                        onClick={() => setDetailId(r.id)}
                        aria-label={`${r.status === 'UNKNOWN' ? 'Review' : 'Details for'} ${r.email ?? 'this recipient'}`}
                      >
                        {r.status === 'UNKNOWN' ? 'Review' : 'Details'}
                      </button>
                    </span>
                  ),
              },
            ]}
          />
          {data.pagination.pages > 1 && (
            <nav aria-label="Recipient pages" className="flex flex-wrap items-center justify-between gap-3 text-sm">
              <p className="text-foreground-muted">
                Page {data.pagination.page} of {data.pagination.pages} · {n(data.pagination.total)} recipients
              </p>
              <div className="flex gap-2">
                <Button type="button" variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                  <ChevronLeft aria-hidden className="size-4" />
                  Previous
                </Button>
                <Button type="button" variant="outline" size="sm" disabled={page >= data.pagination.pages} onClick={() => setPage(page + 1)}>
                  Next
                  <ChevronRight aria-hidden className="size-4" />
                </Button>
              </div>
            </nav>
          )}
        </div>
      )}
      <p className="flex items-center gap-2 text-sm text-foreground-muted">
        <Info aria-hidden strokeWidth={1.5} className="size-4 shrink-0" />
        Retry is available only for confirmed, eligible failures. Unknown outcomes are never retried.
      </p>

      {retryFor && <RetryDialog id={id} runId={runId} recipient={retryFor.recipient} onClose={() => setRetryFor(null)} />}
      <RecipientDialog id={id} runId={runId} recipientId={detailId} onClose={() => setDetailId(null)} />
    </section>
  );
}

const RETRY_UNAVAILABLE: Record<string, string> = {
  broadcast_disabled: 'customer broadcasting is turned off on this server',
  pilot_only: 'this server only allows pilot sends',
  policy_blocked: 'the communication policy changed since this send was confirmed',
  run_stopped: 'this send was stopped',
  run_blocked: 'this send was stopped by the server',
  run_preparing: 'the audience is still being prepared',
};

function OutcomeBadge({ state }: { state: RecipientState }) {
  const s = STATE[state];
  const Icon = s.icon;
  return (
    <Badge tone={s.tone} className="gap-1.5">
      <Icon aria-hidden strokeWidth={2} className="size-3.5" />
      {s.short}
    </Badge>
  );
}

/**
 * Reviews on the server first (exact set + count), then confirms that set only.
 * One operation id per opened dialog, so a double click is the same request.
 */
function RetryDialog({ id, runId, recipient, onClose }: { id: string; runId: string; recipient?: RecipientResult; onClose: () => void }) {
  const review = useRetryReview(id, runId);
  const retry = useRetry(id, runId);
  const [op] = useState(() => crypto.randomUUID());
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    review.mutate(recipient?.id);
  }, [review, recipient?.id]);
  const r = review.data;
  const ready = !!r && r.blockers.length === 0 && r.count > 0;
  const confirm = () => {
    if (!r || retry.isPending) return;
    retry.mutate(
      { clientOperationId: op, setHash: r.setHash, ...(recipient ? { recipientId: recipient.id } : {}) },
      {
        onSuccess: (out) => {
          toast.success(`${n(out.count)} ${out.count === 1 ? 'email' : 'emails'} queued to try again.`);
          onClose();
        },
      },
    );
  };
  return (
    <Dialog open onOpenChange={(next) => !next && !retry.isPending && onClose()}>
      <DialogContent className="gap-6 rounded-xl bg-surface p-7 sm:max-w-lg sm:p-8" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{recipient ? 'Retry this email?' : 'Retry eligible failures?'}</DialogTitle>
          <DialogDescription>This queues real email attempts through the email provider.</DialogDescription>
        </DialogHeader>
        {review.isPending || (!r && !review.error) ? (
          <p className="flex items-center gap-2 text-sm text-foreground-muted">
            <Spinner /> Checking what can be retried…
          </p>
        ) : !r ? (
          <FormError error={review.error} />
        ) : (
          <div className="grid gap-4 text-sm">
            <dl className="grid gap-2">
              <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-3">
                <dt className="text-foreground-muted">Announcement</dt>
                <dd className="break-words">
                  {r.subject} (version {r.announcementVersion})
                </dd>
              </div>
              <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-3">
                <dt className="text-foreground-muted">Recipients</dt>
                <dd>
                  {n(r.count)} {r.count === 1 ? 'recipient' : 'recipients'}
                </dd>
              </div>
              <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-3">
                <dt className="text-foreground-muted">Scope</dt>
                <dd className="break-words">
                  {recipient ? (recipient.email ?? 'This recipient') : 'Every failed email that can be retried now'} ·{' '}
                  {AUDIENCE_LABEL[r.audience]}
                </dd>
              </div>
            </dl>
            {r.blockers.length > 0 ? (
              <p role="alert" className="rounded-lg bg-warning/10 px-4 py-3">
                {r.blockers[0]!.message}
              </p>
            ) : (
              <p className="text-foreground-secondary">
                {r.count === 1 ? 'Only this email' : `Only these ${n(r.count)} emails`} will be tried again, with the same content and to the same address. Each
                recipient is checked again just before sending; anyone no longer eligible is skipped. Emails accepted by the provider and uncertain
                outcomes are never resent.
              </p>
            )}
            <FormError error={retry.error} />
          </div>
        )}
        <DialogFooter className="mx-0 mb-0 flex-col-reverse gap-3 rounded-none border-0 bg-transparent p-0 sm:flex-row">
          <Button type="button" variant="outline" disabled={retry.isPending} onClick={onClose}>
            Cancel
          </Button>
          {ready && (
            <Button type="button" disabled={retry.isPending} onClick={confirm}>
              {retry.isPending && <Spinner />}
              Queue {n(r.count)} {r.count === 1 ? 'retry' : 'retries'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One recipient: outcome, safe reason, attempts and the retry history (each retry keeps the outcome it replaced). */
function RecipientDialog({ id, runId, recipientId, onClose }: { id: string; runId: string; recipientId: string | null; onClose: () => void }) {
  const detail = useRecipient(id, runId, recipientId);
  const d = detail.data;
  return (
    <Dialog open={!!recipientId} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[90vh] gap-5 overflow-y-auto rounded-xl bg-surface p-7 sm:max-w-lg sm:p-8">
        <DialogHeader>
          <DialogTitle>Recipient result</DialogTitle>
          <DialogDescription>Recorded outcome for this recipient. No email is sent from here.</DialogDescription>
        </DialogHeader>
        {detail.isPending ? (
          <p className="flex items-center gap-2 text-sm text-foreground-muted">
            <Spinner /> Loading…
          </p>
        ) : !d ? (
          <FormError error={detail.error} />
        ) : (
          <div className="grid gap-4 text-sm">
            <dl className="grid gap-2">
              {(
                [
                  ['Recipient', d.email ?? 'Address changed since this email was prepared'],
                  ['Outcome', <OutcomeBadge key="o" state={d.status} />],
                  ['Reason', reasonText(d)],
                  ['Attempts', String(d.attemptCount)],
                  ['Last attempt', d.lastAttemptAt ? formatTimestamp(d.lastAttemptAt) : '—'],
                  ['Finished', d.finishedAt ? formatTimestamp(d.finishedAt) : '—'],
                  ['Provider reference', d.providerReference ? 'Recorded' : 'None'],
                  ...(d.status === 'FAILED' ? [['Retry', d.retryable ? 'Can be retried' : retryBlockText(d.retryBlockedReason ?? '')] as [string, ReactNode]] : []),
                ] as [string, ReactNode][]
              ).map(([k, v]) => (
                <div key={k} className="grid grid-cols-[8rem_minmax(0,1fr)] gap-3">
                  <dt className="text-foreground-muted">{k}</dt>
                  <dd className="min-w-0 break-words">{v}</dd>
                </div>
              ))}
            </dl>
            {d.status === 'UNKNOWN' && (
              <p className="rounded-lg bg-warning/10 px-4 py-3">
                {UNKNOWN_TEXT} Microsoft may have accepted this email; the app cannot tell. It is never retried automatically or from this page.
              </p>
            )}
            {d.history.length > 0 && (
              <div className="grid gap-2">
                <h3 className="font-medium">Retry history</h3>
                <ul className="grid gap-1 text-foreground-secondary">
                  {d.history.map((h) => (
                    <li key={h.retriedAt}>
                      {formatTimestamp(h.retriedAt)}: retried by {who(h.requestedBy)} after {h.previousAttemptCount}{' '}
                      {h.previousAttemptCount === 1 ? 'attempt' : 'attempts'} ({h.previousReasonCode ? (REASON[h.previousReasonCode] ?? 'provider error') : 'failed'})
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
