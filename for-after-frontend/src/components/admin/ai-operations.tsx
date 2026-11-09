'use client';

import { AlertTriangle, CheckCircle2, CircleSlash, Info } from 'lucide-react';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { DataTable, Facts, linkClass, Panel, SelectField, useFilterNav } from '@/components/admin/admin-ui';
import { Snapshot } from '@/components/admin/releases';
import { FilterChips } from '@/components/shared/form-field';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyState, QueryView } from '@/components/shared/states';
import { Button } from '@/components/ui/button';
import { useAiOperations } from '@/hooks/use-admin';
import {
  AI_ACTIONS,
  AI_ATTEMPT_RESULTS,
  AI_PAGES,
  AI_REQUEST_OUTCOMES,
  type AiAttemptResult,
  type AiFilters,
  type AiOperations,
  type AiRequestOutcome,
} from '@/lib/api/admin';
import { formatTimestamp, timeZoneLabel } from '@/lib/format';

const BASE = '/admin/system/ai';

export const OUTCOME_LABEL: Record<AiRequestOutcome, string> = {
  reply: 'Reply returned',
  reply_truncated: 'Reply returned, cut at the length limit',
  empty_reply: 'Provider reply had nothing usable',
  not_configured: 'Not configured',
  user_limit: 'Customer hourly limit reached',
  global_limit: 'App-wide attempt limit reached',
  concurrency_limit: 'Too many requests at once',
  limits_unavailable: 'Limits could not be checked (refused)',
  provider_rate_limited: 'Provider rate limited',
  provider_config: 'Provider refused the key or request',
  provider_failure: 'Provider unavailable or invalid response',
  timeout: 'Timed out',
  cancelled: 'Cancelled by the customer',
  unknown: 'Unknown',
};

export const ATTEMPT_LABEL: Record<AiAttemptResult, string> = {
  ok: 'Answered',
  provider_429: 'Provider rate limit',
  provider_auth: 'Authentication/configuration error',
  provider_request: 'Request refused by the provider',
  provider_5xx: 'Provider unavailable',
  network: 'Network failure',
  malformed: 'Invalid provider response',
  timeout: 'Timed out',
  cancelled: 'Cancelled by the customer',
};

const n = (v: number) => v.toLocaleString('en-AU');
const seconds = (ms: number | null, count: number) =>
  ms === null ? 'No samples' : `${(ms / 1000).toFixed(1)} s mean (${n(count)} ${count === 1 ? 'sample' : 'samples'})`;

/**
 * AI operations: configuration presence and observed traffic only. Read-only;
 * opening it never calls the AI provider, and no question, reply or customer
 * text is recorded anywhere.
 */
export function AiOperationsPage({ filters }: { filters: AiFilters }) {
  const query = useAiOperations(filters);
  const nav = useFilterNav(BASE, filters);
  const win = filters.window ?? '24h';
  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="AI operations"
        description="How the For After AI companion is configured and what its recent traffic looked like: counts, timings and token usage only. No questions, replies or customer text are recorded."
      />
      <FilterChips
        label="Period"
        chips={[
          { label: 'Last 24 hours', href: nav.href({ window: undefined }), active: win === '24h' },
          { label: 'Last 7 days', href: nav.href({ window: '7d' }), active: win === '7d' },
        ]}
      />
      <AiFilterForm key={JSON.stringify(filters)} filters={filters} onApply={nav.set} />
      {query.data ? (
        <div className="grid gap-6" aria-busy={query.isFetching || undefined}>
          <Snapshot
            evaluatedAt={query.data.evaluatedAt}
            fetching={query.isFetching}
            failed={query.isError}
            onRefresh={() => void query.refetch()}
            note="Read from stored counts only; refreshing sends nothing to the AI provider."
          />
          <Body d={query.data} />
        </div>
      ) : (
        <QueryView query={query} loadingLabel="Loading AI operations">
          {() => null}
        </QueryView>
      )}
    </>
  );
}

function Body({ d }: { d: AiOperations }) {
  const c = d.configuration;
  return (
    <>
      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="Configuration">
          <p className={`flex items-center gap-2 font-medium ${c.configured ? 'text-success' : 'text-warning'}`}>
            {c.configured ? <CheckCircle2 aria-hidden className="size-4" /> : <CircleSlash aria-hidden className="size-4" />}
            {c.configured ? 'API key configured' : 'Not configured'}
          </p>
          <Facts items={[['Provider', c.provider], ['Model', <span key="m" className="font-mono text-sm break-all">{c.model}</span>]]} />
          <p className="text-sm text-foreground-muted">
            A configured key does not show that the provider works right now; only observed traffic below does.
          </p>
        </Panel>
        <Panel title="Observed availability">
          {d.monitoring === 'unavailable' ? (
            <p className="text-sm text-warning">Unavailable: the recorded figures could not be read.</p>
          ) : (
            <Facts
              items={[
                ['Last reply returned', d.lastReplyAt ? formatTimestamp(d.lastReplyAt) : 'None recorded'],
                ['Last provider failure', d.lastProviderFailureAt ? formatTimestamp(d.lastProviderFailureAt) : 'None recorded'],
              ]}
            />
          )}
          <p className="text-sm text-foreground-muted">
            From real customer requests only (no test prompts are sent). No traffic does not mean the provider is down.
          </p>
        </Panel>
      </div>
      {d.monitoring === 'unavailable' ? (
        <p role="alert" className="flex items-start gap-2 rounded-lg bg-warning/10 px-4 py-3 text-sm text-warning">
          <AlertTriangle aria-hidden strokeWidth={1.5} className="mt-0.5 size-4 shrink-0" />
          Monitoring is unavailable: the counts could not be read from Redis. No figures are shown rather than zeros.
        </p>
      ) : (
        <Observed d={d} />
      )}
      <Panel title="Application limits">
        <Facts
          items={[
            ['Per customer', `${n(c.perUserHour)} requests per hour`],
            ['Provider attempts, whole app', `${n(c.globalAttemptsPerMinute)} per minute (retries count)`],
            ['In flight at once', n(c.maxConcurrent)],
            ['Time budget per request', `${c.budgetMs / 1000} s, retries included`],
            ['Provider attempts per request', `at most ${c.maxAttempts} (one retry, transient failures only)`],
            ['Reply length', `at most ${n(c.maxCompletionTokens)} completion tokens`],
          ]}
        />
        <p className="text-sm text-foreground-muted">
          For After’s own settings, not the provider account’s quota (check that in the provider’s console).
        </p>
      </Panel>
      <Panel title="Monitoring limits">
        <ul className="grid list-disc gap-1.5 pl-5 text-sm text-foreground-secondary">
          <li>Counts live in shared Redis in hourly UTC buckets, kept for 8 days. An outage or data loss leaves a gap; this is not a billing record.</li>
          <li>Requests are counted once validated; requests refused as invalid (400) are not counted.</li>
          <li>No percentiles: only means with their sample counts (no latency distribution is kept).</li>
          <li>Token usage is as reported by the provider, for answered attempts only; others are counted as unknown.</li>
          <li>Cost estimate unavailable: no verified pricing is configured, and provider billing is not monitored.</li>
          <li>Reply quality and customer satisfaction are not measured here.</li>
        </ul>
      </Panel>
    </>
  );
}

function Observed({ d }: { d: Extract<AiOperations, { monitoring: 'available' }> }) {
  const tz = timeZoneLabel(new Date(d.period.to));
  const partial = d.collectingSince && Date.parse(d.collectingSince) > Date.parse(d.period.from);
  const r = d.requests;
  const replies = r.byOutcome.reply + r.byOutcome.reply_truncated;
  const limited = r.byOutcome.user_limit + r.byOutcome.global_limit + r.byOutcome.concurrency_limit;
  return (
    <section aria-labelledby="observed" className="grid gap-4">
      <h2 id="observed" className="font-heading text-2xl">
        Observed traffic
      </h2>
      <p className="text-sm text-foreground-muted">
        {formatTimestamp(d.period.from)} to {formatTimestamp(d.period.to)} ({tz}). Whole hourly buckets; the latest hour is
        still in progress.
        {(d.filters.area || d.filters.action) && ` Filtered to ${[d.filters.area, d.filters.action].filter(Boolean).join(' · ')}.`}
      </p>
      {!d.collectingSince ? (
        <p className="flex items-start gap-2 rounded-lg bg-primary-soft px-4 py-3 text-sm text-foreground-secondary">
          <Info aria-hidden strokeWidth={1.5} className="mt-0.5 size-4 shrink-0 text-primary" />
          Recording has not observed any requests yet (or its records have expired).
        </p>
      ) : (
        partial && (
          <p className="flex items-start gap-2 rounded-lg bg-warning/10 px-4 py-3 text-sm text-warning">
            <AlertTriangle aria-hidden strokeWidth={1.5} className="mt-0.5 size-4 shrink-0" />
            Partial coverage: recording began {formatTimestamp(d.collectingSince)}, after the start of this period.
          </p>
        )
      )}
      {r.total === 0 ? (
        <EmptyState
          icon={Info}
          heading="h3"
          title="No observations in this period"
          description="No validated companion requests were recorded. This is not a sign that the provider is working or down."
        />
      ) : (
        <>
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {(
              [
                ['Requests', n(r.total)],
                ['Replies returned', n(replies)],
                ['Application limit reached', n(limited)],
                ['Provider attempts', `${n(d.attempts.total)} (${n(d.attempts.retries)} retries)`],
              ] as const
            ).map(([label, value]) => (
              <li key={label} className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4">
                <span className="font-heading text-2xl leading-none tabular-nums">{value}</span>
                <span className="text-sm text-foreground-muted">{label}</span>
              </li>
            ))}
          </ul>
          <div className="grid gap-6 lg:grid-cols-2">
            <Panel title="Latency">
              <Facts
                items={[
                  ['Replies, end to end', seconds(r.replyMeanMs, r.replySamples)],
                  ['All requests, end to end', seconds(r.meanMs, r.total)],
                  ['Provider attempts', seconds(d.attempts.meanMs, d.attempts.total)],
                ]}
              />
            </Panel>
            <Panel title="Token usage (as reported by the provider)">
              <Facts
                items={[
                  ['Input', n(d.tokens.input)],
                  ['Output', n(d.tokens.output)],
                  ['Total', n(d.tokens.total)],
                  ['Attempts with usage reported', n(d.tokens.reportedAttempts)],
                ]}
              />
              {d.tokens.unknownAttempts > 0 && (
                <p className="text-sm text-warning">
                  Usage unknown for {n(d.tokens.unknownAttempts)} provider {d.tokens.unknownAttempts === 1 ? 'attempt' : 'attempts'}: totals
                  above are incomplete.
                </p>
              )}
            </Panel>
          </div>
          <div className="grid gap-6 lg:grid-cols-2">
            <DataTable
              caption="Request outcomes"
              rows={AI_REQUEST_OUTCOMES.filter((o) => r.byOutcome[o] > 0)}
              rowKey={(o) => o}
              columns={[
                { header: 'Outcome', cell: (o) => OUTCOME_LABEL[o] },
                { header: 'Requests', cell: (o) => n(r.byOutcome[o]) },
              ]}
            />
            <DataTable
              caption="Provider attempts by result"
              rows={AI_ATTEMPT_RESULTS.filter((a) => d.attempts.byResult[a] > 0)}
              rowKey={(a) => a}
              columns={[
                { header: 'Result', cell: (a) => ATTEMPT_LABEL[a] },
                { header: 'Attempts', cell: (a) => n(d.attempts.byResult[a]) },
              ]}
            />
          </div>
        </>
      )}
    </section>
  );
}

/** Page and action only (allowlisted); applied on submit. */
function AiFilterForm({ filters, onApply }: { filters: AiFilters; onApply: (f: Partial<AiFilters>) => void }) {
  const [f, setF] = useState(filters);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onApply(f);
  };
  const hasFilters = !!(filters.area || filters.action);
  return (
    <form onSubmit={submit} aria-label="Filter AI operations" className="mb-8 grid gap-4 rounded-xl border border-border bg-surface p-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          id="area"
          label="Companion page"
          value={f.area ?? ''}
          onChange={(e) => setF({ ...f, area: (e.target.value || undefined) as AiFilters['area'] })}
          options={[{ value: '', label: 'All pages' }, ...AI_PAGES.map((p) => ({ value: p, label: p }))]}
        />
        <SelectField
          id="action"
          label="Action"
          value={f.action ?? ''}
          onChange={(e) => setF({ ...f, action: (e.target.value || undefined) as AiFilters['action'] })}
          options={[{ value: '', label: 'All actions' }, ...AI_ACTIONS.map((a) => ({ value: a, label: a }))]}
        />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit">Apply filters</Button>
        {hasFilters && (
          <Button asChild variant="ghost">
            <Link href={filters.window ? `${BASE}?window=${filters.window}` : BASE} className={linkClass}>
              Clear filters
            </Link>
          </Button>
        )}
      </div>
    </form>
  );
}
