import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { SystemHealth } from '@/lib/api/admin';
import { json, renderWithClient, routeFetch, router } from '@/test/utils';
import { SystemHealthPage } from './system-health';

vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/admin/system/health' }));

const T = '2026-10-30T02:00:00.000Z';
const health = (over: Partial<SystemHealth> = {}): SystemHealth => ({
  checkedAt: T,
  api: { status: 'ok', checkedAt: T },
  database: { status: 'ok', checkedAt: T, durationMs: 4 },
  redis: { status: 'ok', checkedAt: T, durationMs: 1 },
  worker: { status: 'ok', checkedAt: T, reportingWorkers: 2, lastSeenAt: T, staleAfterSeconds: 45 },
  malwareScanner: { status: 'ok', checkedAt: T, durationMs: 7 },
  ...over,
});
const row = (name: string) => screen.getByText(name, { selector: 'span.font-medium' }).closest('li')!;

describe('System health page', () => {
  it('each service with its own success wording, times, durations and limits; scoped summary', async () => {
    routeFetch({ 'GET /admin/system/health': json(200, health()) });
    renderWithClient(<SystemHealthPage />);
    expect(await screen.findByText('No issues in these checks')).toBeInTheDocument();
    expect(screen.getByText(/covers this API instance and the workers that report a heartbeat/)).toBeInTheDocument();
    expect(within(row('API')).getByText('Responding')).toBeInTheDocument();
    expect(within(row('PostgreSQL')).getByText('Reachable')).toBeInTheDocument();
    expect(within(row('PostgreSQL')).getByText(/4 ms/)).toBeInTheDocument();
    expect(within(row('Background worker')).getByText('Heartbeat recent')).toBeInTheDocument();
    expect(within(row('Background worker')).getByText(/Reporting workers: 2/)).toBeInTheDocument();
    expect(within(row('Background worker')).getByText(/not that every queue is being processed/)).toBeInTheDocument();
    expect(within(row('Malware scanner')).getByText(/does not show that signatures are current/)).toBeInTheDocument();
    // Reachability stays separate from file outcomes, which live on Storage & scans.
    expect(within(row('Malware scanner')).getByRole('link', { name: 'Upload check outcomes on Storage & scans' })).toHaveAttribute(
      'href',
      '/admin/storage?uploadState=failed',
    );
    expect(screen.getByText(/^Checked by the server/)).toHaveTextContent(/UTC/);
    expect(screen.getByText(/^Received by this browser/)).toBeInTheDocument();
    expect(screen.queryByText(/All systems operational|Healthy/)).not.toBeInTheDocument();
    // Read-only: the only control is Refresh.
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Refresh']);
  });

  it('partial results: failures, timeouts, unknown and not configured are named, never blended', async () => {
    routeFetch({
      'GET /admin/system/health': json(
        200,
        health({
          redis: { status: 'timed_out', checkedAt: T, durationMs: 2000 },
          worker: { status: 'unknown', checkedAt: T, reportingWorkers: null, lastSeenAt: null, staleAfterSeconds: 45 },
          malwareScanner: { status: 'not_configured', checkedAt: T, durationMs: null },
        }),
      ),
    });
    renderWithClient(<SystemHealthPage />);
    expect(await screen.findByText('Issues detected')).toBeInTheDocument();
    expect(within(row('Redis')).getByText('Timed out')).toBeInTheDocument();
    expect(within(row('PostgreSQL')).getByText('Reachable')).toBeInTheDocument();
    expect(within(row('Background worker')).getByText('Unknown')).toBeInTheDocument();
    expect(within(row('Background worker')).getByText(/Reporting workers: unknown/)).toBeInTheDocument();
    expect(within(row('Malware scanner')).getByText('Not configured')).toBeInTheDocument();
  });

  it('stale or missing evidence is "Monitoring incomplete", not a failure', async () => {
    routeFetch({
      'GET /admin/system/health': json(
        200,
        health({ worker: { status: 'stale', checkedAt: T, reportingWorkers: 0, lastSeenAt: T, staleAfterSeconds: 45 } }),
      ),
    });
    renderWithClient(<SystemHealthPage />);
    expect(await screen.findByText('Monitoring incomplete')).toBeInTheDocument();
    expect(within(row('Background worker')).getByText('Heartbeat stale')).toBeInTheDocument();
  });

  it('loading, then a failed refresh keeps the last check and says it may be stale', async () => {
    let n = 0;
    routeFetch({
      'GET /admin/system/health': () => (n++ === 0 ? json(200, health()) : json(503, { message: 'x' })),
    });
    renderWithClient(<SystemHealthPage />);
    expect(screen.getByRole('status')).toHaveTextContent(/Running health checks/);
    await screen.findByText('No issues in these checks');
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Couldn’t refresh\. These results are from the check at/);
    // The previous observation (and its server time) is still shown, unchanged.
    expect(within(row('PostgreSQL')).getByText('Reachable')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled());
  });
});
