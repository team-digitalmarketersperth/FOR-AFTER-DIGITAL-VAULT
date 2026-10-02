'use client';

import { CheckCircle2, RotateCcw } from 'lucide-react';
import Link from 'next/link';
import { toast } from 'sonner';
import { DataTable, linkClass, Pager, Panel, useFilterNav } from '@/components/admin/admin-ui';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { FilterChips } from '@/components/shared/form-field';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyState, QueryView } from '@/components/shared/states';
import { Button } from '@/components/ui/button';
import { useFailedJobs, useQueues, useRetryJob } from '@/hooks/use-admin';
import type { FailedJob, QueueSummary } from '@/lib/api/admin';
import { formatTimestamp } from '@/lib/format';
import { shortId } from '@/lib/admin';

const BASE = '/admin/system/queues';

const QUEUE_COPY: Record<string, string> = {
  'message-release': 'Releases scheduled and death-triggered messages.',
  'death-verification': 'Moves death verification cases on when the safeguard period ends.',
};

const COUNTS: (keyof Omit<QueueSummary, 'name'>)[] = ['waiting', 'active', 'delayed', 'prioritized', 'completed', 'failed'];

export type QueueFilters = { queue?: string; page: number };

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
