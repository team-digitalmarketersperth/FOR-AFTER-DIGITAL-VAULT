'use client';

import { CheckCircle2, Eye, RotateCcw } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge, DataTable, Facts, linkClass, Pager, Panel, SelectField, useFilterNav } from '@/components/admin/admin-ui';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { FilterChips } from '@/components/shared/form-field';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyState, QueryView } from '@/components/shared/states';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import {
  useDeadLetter,
  useDeadLetters,
  useFailedJobs,
  useQueues,
  useRetryDeadLetter,
  useRetryJob,
} from '@/hooks/use-admin';
import {
  DEAD_LETTER_QUEUES,
  DEAD_LETTER_STATUSES,
  type DeadLetter,
  type DeadLetterStatus,
  type FailedJob,
  type OpsAlertStatus,
  type QueueSummary,
} from '@/lib/api/admin';
import { formatTimestamp } from '@/lib/format';
import { shortId } from '@/lib/admin';

const BASE = '/admin/system/queues';

const QUEUE_COPY: Record<string, string> = {
  'message-release': 'Releases scheduled and death-triggered messages.',
  'death-verification': 'Moves death verification cases on when the safeguard period ends.',
};

const COUNTS: (keyof Omit<QueueSummary, 'name'>)[] = ['waiting', 'active', 'delayed', 'prioritized', 'completed', 'failed'];

export type QueueFilters = {
  queue?: string;
  page: number;
  // Dead letters (Phase 17A): status defaults to OPEN; ALL = no status filter.
  dlQueue?: (typeof DEAD_LETTER_QUEUES)[number];
  dlStatus?: DeadLetterStatus | 'ALL';
  dlPage?: number;
};

/**
 * Queue names come only from the API's own summary (its allowlist): there is
 * no free-text queue name, and a ?queue= the API doesn't list is ignored.
 */
export function Queues({ filters }: { filters: QueueFilters }) {
  const summary = useQueues();
  const nav = useFilterNav(BASE, filters);
  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Queues"
        description="Background jobs. Retrying a failed job runs it again through the normal checks; it never forces a release."
      />
      <QueryView query={summary} loadingLabel="Loading queues">
        {(queues) => {
          const selected = queues.find((q) => q.name === filters.queue) ?? queues.find((q) => q.failed > 0) ?? queues[0];
          return (
            <div className="grid gap-8">
              <DataTable
                caption="Queue summary"
                rows={queues}
                rowKey={(q) => q.name}
                columns={[
                  {
                    header: 'Queue',
                    cell: (q) => (
                      <span className="grid gap-0.5">
                        <span className="font-medium">{q.name}</span>
                        {QUEUE_COPY[q.name] && <span className="text-xs text-foreground-muted">{QUEUE_COPY[q.name]}</span>}
                      </span>
                    ),
                  },
                  ...COUNTS.map((k) => ({
                    header: k.charAt(0).toUpperCase() + k.slice(1),
                    cell: (q: QueueSummary) => (
                      <span className={k === 'failed' && q.failed > 0 ? 'font-semibold text-danger tabular-nums' : 'tabular-nums'}>
                        {q[k].toLocaleString('en-AU')}
                      </span>
                    ),
                  })),
                ]}
              />
              {selected && (
                <Panel title="Failed jobs">
                  <FilterChips
                    label="Choose a queue"
                    chips={queues.map((q) => ({
                      label: `${q.name} (${q.failed})`,
                      href: nav.href({ queue: q.name, page: undefined }),
                      active: q.name === selected.name,
                    }))}
                  />
                  <FailedJobs queue={selected.name} page={selected.name === filters.queue ? filters.page : 1} hrefFor={(page) => nav.href({ queue: selected.name, page })} />
                </Panel>
              )}
              <DeadLetters filters={filters} nav={nav} />
            </div>
          );
        }}
      </QueryView>
    </>
  );
}

function FailedJobs({ queue, page, hrefFor }: { queue: string; page: number; hrefFor: (page: number) => string }) {
  const jobs = useFailedJobs(queue, page);
  return (
    <QueryView query={jobs} loadingLabel="Loading failed jobs">
      {({ items, pagination }) =>
        items.length === 0 ? (
          <EmptyState icon={CheckCircle2} title="No failed jobs" description={`Nothing has failed in ${queue}.`} />
        ) : (
          <div aria-busy={jobs.isPlaceholderData || undefined}>
            <DataTable
              caption={`Failed jobs in ${queue}`}
              rows={items}
              rowKey={(j) => j.jobId}
              columns={[
                {
                  header: 'Job',
                  cell: (j) => (
                    <span className="grid gap-0.5">
                      <span className="font-mono text-xs break-all">{j.jobId}</span>
                      <span className="text-xs text-foreground-muted">{j.name}</span>
                    </span>
                  ),
                },
                { header: 'Reason', cell: (j) => j.failedReasonSanitized ?? 'No reason recorded' },
                { header: 'Attempts', cell: (j) => `${j.attemptsMade} of ${j.maxAttempts}` },
                { header: 'Failed', cell: (j) => (j.failedAt ? formatTimestamp(j.failedAt) : '—') },
                { header: 'Related', cell: (j) => <Related job={j} /> },
                { header: 'Action', cell: (j) => <RetryButton job={j} /> },
              ]}
            />
            <Pager pagination={pagination} hrefFor={hrefFor} />
          </div>
        )
      }
    </QueryView>
  );
}

// Ids only (the API sends nothing else). A message has no admin page: content stays private.
const Related = ({ job }: { job: FailedJob }) =>
  job.payload.caseId ? (
    <Link href={`/admin/death-verifications/${job.payload.caseId}`} className={linkClass}>
      Case {shortId(job.payload.caseId)}
    </Link>
  ) : job.payload.messageId ? (
    <span className="font-mono text-xs" title={job.payload.messageId}>
      Message {shortId(job.payload.messageId)}
    </span>
  ) : job.payload.notificationId ? (
    // A Recipient email; its address and content are never sent to the admin UI.
    <span className="font-mono text-xs" title={job.payload.notificationId}>
      Email {shortId(job.payload.notificationId)}
    </span>
  ) : (
    '—'
  );

function RetryButton({ job }: { job: FailedJob }) {
  const retry = useRetryJob();
  return (
    <ConfirmDialog
      tone="default"
      trigger={
        <Button variant="outline" size="sm">
          <RotateCcw aria-hidden strokeWidth={1.5} className="size-4" />
          Retry
        </Button>
      }
      title="Retry this job?"
      description={
        <>
          Job <span className="font-mono break-all">{job.jobId}</span> will run again through the normal worker, which re-checks
          everything first. It doesn&apos;t force a release: anything no longer eligible is skipped.
        </>
      }
      confirmLabel="Retry job"
      pending={retry.isPending}
      error={retry.error}
      onOpenChange={(open) => !open && retry.reset()}
      onConfirm={() => retry.mutateAsync({ queue: job.queue, jobId: job.jobId }).then(() => toast('Job queued to run again'))}
    />
  );
}

// ─── Dead letters (Phase 17A) ───────────────────────────────────────────────

const DL_STATUS: Record<DeadLetterStatus, { label: string; tone: 'danger' | 'open' | 'done' }> = {
  OPEN: { label: 'Open', tone: 'danger' },
  REQUEUED: { label: 'Re-queued', tone: 'open' },
  RESOLVED: { label: 'Resolved', tone: 'done' },
};

const ALERT_LABEL: Record<OpsAlertStatus, string> = {
  PENDING: 'Pending',
  SENT: 'Sent',
  FAILED: 'Failed',
  NOT_CONFIGURED: 'Not configured',
};

const ENTITY_LABEL: Record<string, string> = {
  Message: 'Message',
  MessageRecipientRelease: 'Yearly release',
  DeathVerificationCase: 'Case',
  ReleaseNotification: 'Email',
};

/**
 * Jobs whose automatic retries ran out, from PostgreSQL (kept, unlike BullMQ's
 * 7-day failed list). Ids and safe categories only: the API never sends a
 * payload, content, address or stack.
 */
function DeadLetters({ filters, nav }: { filters: QueueFilters; nav: ReturnType<typeof useFilterNav<QueueFilters>> }) {
  const statusParam = filters.dlStatus ?? 'OPEN';
  const list = useDeadLetters({
    queue: filters.dlQueue,
    status: statusParam === 'ALL' ? undefined : statusParam,
    page: filters.dlPage,
  });
  return (
    <Panel title="Dead letters">
      <p className="-mt-2 text-sm text-foreground-muted">
        Jobs that used up their automatic retries. Retrying runs the job again through the normal checks; anything no
        longer eligible is skipped.
      </p>
      <div className="grid gap-4 sm:max-w-xl sm:grid-cols-2">
        <SelectField
          id="dl-status"
          label="Status"
          value={statusParam}
          onChange={(e) => nav.set({ dlStatus: e.target.value as QueueFilters['dlStatus'], dlPage: undefined })}
          options={[
            ...DEAD_LETTER_STATUSES.map((s) => ({ value: s, label: DL_STATUS[s].label })),
            { value: 'ALL', label: 'All' },
          ]}
        />
        <SelectField
          id="dl-queue"
          label="Queue"
          value={filters.dlQueue ?? ''}
          onChange={(e) =>
            nav.set({ dlQueue: (e.target.value || undefined) as QueueFilters['dlQueue'], dlPage: undefined })
          }
          options={[{ value: '', label: 'All queues' }, ...DEAD_LETTER_QUEUES.map((q) => ({ value: q, label: q }))]}
        />
      </div>
      <QueryView query={list} loadingLabel="Loading dead letters">
        {({ items, pagination }) =>
          items.length === 0 ? (
            <EmptyState icon={CheckCircle2} title="No dead letters" description="Nothing matches these filters." />
          ) : (
            <div aria-busy={list.isPlaceholderData || undefined}>
              <DataTable
                caption="Dead letters"
                rows={items}
                rowKey={(d) => d.id}
                columns={[
                  {
                    header: 'Job',
                    cell: (d) => (
                      <span className="grid gap-0.5">
                        <span className="font-medium">{d.queueName}</span>
                        <span className="font-mono text-xs break-all text-foreground-muted">{d.jobId}</span>
                      </span>
                    ),
                  },
                  { header: 'Related', cell: (d) => <Entity d={d} /> },
                  {
                    header: 'Failed',
                    cell: (d) => (
                      <span className="grid gap-0.5">
                        <span>{formatTimestamp(d.failedAt)}</span>
                        {d.failureCount > 1 && (
                          <span className="text-xs text-foreground-muted">{d.failureCount} times</span>
                        )}
                      </span>
                    ),
                  },
                  { header: 'Attempts', cell: (d) => d.attemptsMade },
                  {
                    header: 'Status',
                    cell: (d) => <Badge tone={DL_STATUS[d.status].tone}>{DL_STATUS[d.status].label}</Badge>,
                  },
                  {
                    header: 'Action',
                    cell: (d) => (
                      <span className="flex flex-wrap gap-2">
                        <DeadLetterDetails id={d.id} jobId={d.jobId} />
                        {d.status === 'OPEN' && <RetryDeadLetter d={d} />}
                      </span>
                    ),
                  },
                ]}
              />
              <Pager pagination={pagination} hrefFor={(page) => nav.href({ dlPage: page })} />
            </div>
          )
        }
      </QueryView>
    </Panel>
  );
}

// Ids only. A message has no admin page: content stays private.
const Entity = ({ d }: { d: DeadLetter }) => {
  const label = ENTITY_LABEL[d.entityType] ?? d.entityType;
  if (!d.entityId) return <>{label}</>;
  return d.entityType === 'DeathVerificationCase' ? (
    <Link href={`/admin/death-verifications/${d.entityId}`} className={linkClass}>
      Case {shortId(d.entityId)}
    </Link>
  ) : (
    <span className="font-mono text-xs" title={d.entityId}>
      {label} {shortId(d.entityId)}
    </span>
  );
};

function DeadLetterDetails({ id, jobId }: { id: string; jobId: string }) {
  const [open, setOpen] = useState(false);
  const detail = useDeadLetter(id, open);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" aria-label={`View dead letter ${jobId}`}>
          <Eye aria-hidden strokeWidth={1.5} className="size-4" />
          View
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-2rem)] gap-6 overflow-y-auto rounded-xl bg-surface p-7 sm:max-w-2xl sm:p-8">
        <DialogHeader className="gap-3">
          <DialogTitle className="text-[28px] leading-tight font-normal">Dead letter</DialogTitle>
          <DialogDescription className="text-[15px] text-foreground-muted">
            Ids and a sanitized error only. Job content is never shown.
          </DialogDescription>
        </DialogHeader>
        <QueryView query={detail} loadingLabel="Loading dead letter">
          {(d) => (
            <Facts
              items={[
                ['Queue', d.queueName],
                ['Job ID', <span key="j" className="font-mono text-sm break-all">{d.jobId}</span>],
                ['Job type', d.jobName],
                ['Related', <Entity key="e" d={d} />],
                ['Attempts', d.attemptsMade],
                ['Times failed', d.failureCount],
                ['Last failed', formatTimestamp(d.failedAt)],
                ['Error code', d.errorCode],
                ['Error', d.errorMessage],
                ['Status', <Badge key="s" tone={DL_STATUS[d.status].tone}>{DL_STATUS[d.status].label}</Badge>],
                ['Outcome', d.resolution],
                ['Re-queued', d.requeuedAt ? formatTimestamp(d.requeuedAt) : null],
                ['Resolved', d.resolvedAt ? formatTimestamp(d.resolvedAt) : null],
                ['Operator alert', ALERT_LABEL[d.alertStatus]],
              ]}
            />
          )}
        </QueryView>
      </DialogContent>
    </Dialog>
  );
}

function RetryDeadLetter({ d }: { d: DeadLetter }) {
  const retry = useRetryDeadLetter();
  return (
    <ConfirmDialog
      tone="default"
      trigger={
        <Button variant="outline" size="sm" aria-label={`Retry dead letter ${d.jobId}`}>
          <RotateCcw aria-hidden strokeWidth={1.5} className="size-4" />
          Retry
        </Button>
      }
      title="Retry this dead letter?"
      description={
        <>
          Job <span className="font-mono break-all">{d.jobId}</span> will be queued again. The worker re-checks
          everything first and skips anything no longer eligible; nothing is sent or released twice.
        </>
      }
      confirmLabel="Retry job"
      pending={retry.isPending}
      error={retry.error}
      onOpenChange={(open) => !open && retry.reset()}
      onConfirm={() =>
        retry
          .mutateAsync(d.id)
          .then((res) =>
            toast(
              res.status === 'RESOLVED'
                ? 'Nothing to run: the related record no longer exists'
                : 'Job queued to run again',
            ),
          )
      }
    />
  );
}
