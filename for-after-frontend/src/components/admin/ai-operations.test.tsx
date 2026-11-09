import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AiOperations } from '@/lib/api/admin';
import { json, renderWithClient, routeFetch, router } from '@/test/utils';
import { AiOperationsPage } from './ai-operations';

vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/admin/system/ai' }));

const T = '2026-10-31T02:00:00.000Z';
const zeroOutcomes = Object.fromEntries(
  ['reply', 'reply_truncated', 'empty_reply', 'not_configured', 'user_limit', 'global_limit', 'concurrency_limit', 'limits_unavailable', 'provider_rate_limited', 'provider_config', 'provider_failure', 'timeout', 'cancelled', 'unknown'].map((k) => [k, 0]),
) as Extract<AiOperations, { monitoring: 'available' }>['requests']['byOutcome'];
const zeroAttempts = Object.fromEntries(
  ['ok', 'provider_429', 'provider_auth', 'provider_request', 'provider_5xx', 'network', 'malformed', 'timeout', 'cancelled'].map((k) => [k, 0]),
) as Extract<AiOperations, { monitoring: 'available' }>['attempts']['byResult'];
const configuration = {
  configured: true,
  provider: 'Groq',
  model: 'llama-3.3-70b-versatile',
  perUserHour: 30,
  globalAttemptsPerMinute: 20,
  maxConcurrent: 3,
  budgetMs: 25_000,
  maxAttempts: 2,
  maxCompletionTokens: 700,
};
const data = (over: Partial<Extract<AiOperations, { monitoring: 'available' }>> = {}): AiOperations => ({
  evaluatedAt: T,
  window: '24h',
  filters: { area: null, action: null },
  configuration,
  monitoring: 'available',
  period: { from: '2026-10-30T03:00:00.000Z', to: T },
  collectingSince: '2026-10-29T00:00:00.000Z',
  lastReplyAt: T,
  lastProviderFailureAt: null,
  requests: { total: 5, byOutcome: { ...zeroOutcomes, reply: 3, user_limit: 1, timeout: 1 }, meanMs: 6000, replyMeanMs: 2500, replySamples: 3 },
  attempts: { total: 5, retries: 1, byResult: { ...zeroAttempts, ok: 3, provider_5xx: 1, timeout: 1 }, meanMs: 2000 },
  tokens: { reportedAttempts: 3, unknownAttempts: 2, input: 900, output: 300, total: 1200 },
  ...over,
});

describe('AI operations', () => {
  it('configuration is presence only and kept apart from observed traffic; counts, samples, unknown usage, limits', async () => {
    routeFetch({ 'GET /admin/system/ai': json(200, data()) });
    renderWithClient(<AiOperationsPage filters={{}} />);
    expect(await screen.findByText('API key configured')).toBeInTheDocument();
    expect(screen.getByText(/does not show that the provider works right now/)).toBeInTheDocument();
    expect(screen.getByText('None recorded')).toBeInTheDocument(); // no provider failure recorded
    expect(screen.getByText('2.5 s mean (3 samples)')).toBeInTheDocument();
    expect(screen.getByText('5 (1 retries)')).toBeInTheDocument();
    expect(screen.getByText(/Usage unknown for 2 provider attempts: totals above are incomplete/)).toBeInTheDocument();
    const outcomes = screen.getByRole('table', { name: 'Request outcomes' });
    expect(within(outcomes).getByText('Customer hourly limit reached')).toBeInTheDocument();
    expect(within(outcomes).queryByText('Not configured')).not.toBeInTheDocument(); // zero rows omitted
    expect(screen.getByText('30 requests per hour')).toBeInTheDocument();
    expect(screen.getByText(/Cost estimate unavailable/)).toBeInTheDocument();
    // No percentile, no "healthy", no conversation or mutation controls.
    expect(document.body.textContent).not.toMatch(/p95|healthy|view conversation|send a test/i);
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Apply filters', 'Refresh']);
  });

  it('not configured, no observations and partial coverage are each said plainly', async () => {
    routeFetch({
      'GET /admin/system/ai': json(
        200,
        data({
          configuration: { ...configuration, configured: false },
          collectingSince: '2026-10-30T20:00:00.000Z',
          lastReplyAt: null,
          requests: { total: 0, byOutcome: zeroOutcomes, meanMs: null, replyMeanMs: null, replySamples: 0 },
          attempts: { total: 0, retries: 0, byResult: zeroAttempts, meanMs: null },
          tokens: { reportedAttempts: 0, unknownAttempts: 0, input: 0, output: 0, total: 0 },
        }),
      ),
    });
    renderWithClient(<AiOperationsPage filters={{}} />);
    expect(await screen.findByText('Not configured')).toBeInTheDocument();
    expect(screen.getByText('No observations in this period')).toBeInTheDocument();
    expect(screen.getByText(/not a sign that the provider is working or down/)).toBeInTheDocument();
    expect(screen.getByText(/Partial coverage: recording began/)).toBeInTheDocument();
  });

  it('monitoring unavailable shows no figures (never zeros); a failed refresh keeps the last result as stale', async () => {
    let n = 0;
    routeFetch({
      'GET /admin/system/ai': () =>
        n++ === 0
          ? json(200, { evaluatedAt: T, window: '24h', filters: { area: null, action: null }, configuration, monitoring: 'unavailable' })
          : json(503, { message: 'x' }),
    });
    renderWithClient(<AiOperationsPage filters={{}} />);
    expect(await screen.findByText(/Monitoring is unavailable/)).toBeInTheDocument();
    expect(screen.queryByText('Requests')).not.toBeInTheDocument();
    expect(screen.queryByText('No observations in this period')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText(/Couldn’t refresh.*may be out of date/)).toBeInTheDocument();
    expect(screen.getByText('API key configured')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled());
  });

  it('period chips and allowlisted filters go through the URL', async () => {
    routeFetch({ 'GET /admin/system/ai': json(200, data()) });
    renderWithClient(<AiOperationsPage filters={{ area: 'messages' }} />);
    await screen.findByText('API key configured');
    const week = new URL(screen.getByRole('link', { name: 'Last 7 days' }).getAttribute('href')!, 'http://x');
    expect([week.pathname, week.searchParams.get('window'), week.searchParams.get('area')]).toEqual(['/admin/system/ai', '7d', 'messages']);
    router.replace.mockClear();
    await userEvent.selectOptions(screen.getByLabelText('Action'), 'draft');
    await userEvent.click(screen.getByRole('button', { name: 'Apply filters' }));
    expect(router.replace).toHaveBeenCalledWith(expect.stringMatching(/area=messages.*action=draft|action=draft.*area=messages/), expect.anything());
  });
});
