import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { DeadLetter } from '@/lib/api/admin';
import { makeQueryClient } from '@/lib/query/query-client';
import { json, routeFetch, router } from '@/test/utils';
import { Queues, type QueueFilters } from './queues';

vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/admin' }));
const toast = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast }));

// Phase 17A: the Dead letters section of Admin → Queues.

const ID = '00000000-0000-4000-8000-0000000d1e77';
const MESSAGE_ID = '00000000-0000-4000-8000-00000000e55a';
const DL: DeadLetter = {
  id: ID,
  queueName: 'message-release',
  jobId: `message-release-${MESSAGE_ID}`,
  jobName: 'release',
  entityType: 'Message',
  entityId: MESSAGE_ID,
  attemptsMade: 5,
  errorCode: 'ECONNREFUSED',
  errorMessage: 'connect ECONNREFUSED [url]',
  failedAt: '2026-10-12T00:05:00.000Z',
  failureCount: 3,
  status: 'OPEN',
  resolution: null,
  requeuedAt: null,
  resolvedAt: null,
  alertStatus: 'FAILED',
  alertedAt: null,
  createdAt: '2026-10-12T00:05:00.000Z',
};
const QUEUES = [
  { name: 'message-release', waiting: 0, active: 0, delayed: 0, prioritized: 0, failed: 0, completed: 4 },
];
const page = <T,>(items: T[]) => ({ items, pagination: { page: 1, limit: 25, total: items.length, pages: 1 } });

function renderQueues(filters: QueueFilters = { page: 1 }): ReactElement {
  const queryClient = makeQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  const ui = (
    <QueryClientProvider client={queryClient}>
      <Queues filters={filters} />
    </QueryClientProvider>
  );
  render(ui);
  return ui;
}

const routes = (deadLetters: Response | ((body: unknown, url: URL) => Response), extra = {}) =>
  routeFetch({
    'GET /admin/system/queues': json(200, QUEUES),
    'GET /admin/system/queues/message-release/failed': json(200, page([])),
    'GET /admin/system/dead-letters': deadLetters,
    ...extra,
  });

const section = async () => {
  const heading = await screen.findByRole('heading', { name: 'Dead letters' });
  return within(heading.closest('section')!);
};

describe('Dead letters', () => {
  it('lists OPEN dead letters by default with ids, attempts and status, but no error text or payload', async () => {
    const urls: URL[] = [];
    routes((_, url) => (urls.push(url), json(200, page([DL]))));
    renderQueues();
    const dl = await section();
    expect(dl.getByText(/Loading dead letters/)).toBeInTheDocument();
    expect(await dl.findByText(DL.jobId)).toBeInTheDocument();
    expect(dl.getByText('Message 00000000…')).toHaveAttribute('title', MESSAGE_ID);
    expect(dl.getByText('3 times')).toBeInTheDocument();
    // The row's status badge (the status filter has an "Open" option too).
    expect(dl.getAllByText('Open').filter((el) => el.tagName !== 'OPTION')).toHaveLength(1);
    expect(dl.queryByText('connect ECONNREFUSED [url]')).not.toBeInTheDocument();
    expect(urls[0].searchParams.get('status')).toBe('OPEN');
    expect(urls[0].searchParams.has('queue')).toBe(false);
  });

  it('sends the queue filter; "All" statuses sends no status; Retry only on OPEN rows', async () => {
    const urls: URL[] = [];
    routes((_, url) => (urls.push(url), json(200, page([{ ...DL, status: 'RESOLVED', resolution: 'released' }]))));
    renderQueues({ page: 1, dlQueue: 'email-delivery', dlStatus: 'ALL' });
    const dl = await section();
    expect(await dl.findByText('Resolved')).toBeInTheDocument();
    expect(urls[0].searchParams.get('queue')).toBe('email-delivery');
    expect(urls[0].searchParams.has('status')).toBe(false);
    expect(dl.queryByRole('button', { name: /Retry/ })).not.toBeInTheDocument();
    expect(dl.getByLabelText('Queue')).toHaveValue('email-delivery');
  });

  it('changing a filter updates the URL and resets the page', async () => {
    routes(json(200, page([DL])));
    renderQueues({ page: 1, dlPage: 3 });
    const dl = await section();
    await userEvent.selectOptions(dl.getByLabelText('Status'), 'REQUEUED');
    expect(router.replace).toHaveBeenLastCalledWith(
      '/admin/system/queues?dlStatus=REQUEUED',
      expect.anything(),
    );
  });

  it('empty and error states', async () => {
    routes(json(200, page([])));
    renderQueues();
    expect(await (await section()).findByText('No dead letters')).toBeInTheDocument();
  });

  it('shows an API error instead of a fake empty list', async () => {
    routes(json(503, { message: 'Dead letters are unavailable.' }));
    renderQueues();
    const dl = await section();
    await waitFor(() => expect(dl.queryByText(/Loading dead letters/)).not.toBeInTheDocument());
    expect(dl.queryByText('No dead letters')).not.toBeInTheDocument();
    expect(dl.queryByText(DL.jobId)).not.toBeInTheDocument();
  });

  it('View loads the detail: sanitized error, code and alert status only', async () => {
    const api = routes(json(200, page([DL])), {
      [`GET /admin/system/dead-letters/${ID}`]: json(200, DL),
    });
    renderQueues();
    await userEvent.click(await screen.findByRole('button', { name: `View dead letter ${DL.jobId}` }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('connect ECONNREFUSED [url]')).toBeInTheDocument();
    expect(within(dialog).getByText('ECONNREFUSED')).toBeInTheDocument();
    expect(within(dialog).getByText('Failed')).toBeInTheDocument(); // operator alert
    expect(within(dialog).getByText('Job content is never shown.', { exact: false })).toBeInTheDocument();
    expect(api.called('GET', `/admin/system/dead-letters/${ID}`)).toHaveLength(1);
  });

  it('Retry asks first, posts once, refreshes and confirms', async () => {
    const api = routes(json(200, page([DL])), {
      [`POST /admin/system/dead-letters/${ID}/retry`]: json(200, { ...DL, status: 'REQUEUED' }),
    });
    renderQueues();
    await userEvent.click(await screen.findByRole('button', { name: `Retry dead letter ${DL.jobId}` }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Retry this dead letter?' })).toBeInTheDocument();
    expect(within(dialog).queryByText(/force/i)).not.toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Retry job' }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Job queued to run again'));
    expect(api.called('POST', `/admin/system/dead-letters/${ID}/retry`)).toHaveLength(1);
    await waitFor(() => expect(api.called('GET', '/admin/system/dead-letters')).toHaveLength(2));
  });

  it('a stale retry (entity gone) says nothing ran', async () => {
    routes(json(200, page([DL])), {
      [`POST /admin/system/dead-letters/${ID}/retry`]: json(200, { ...DL, status: 'RESOLVED', resolution: 'stale' }),
    });
    renderQueues();
    await userEvent.click(await screen.findByRole('button', { name: `Retry dead letter ${DL.jobId}` }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Retry job' }));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith('Nothing to run: the related record no longer exists'),
    );
  });

  it('a 409 (someone else retried it) is shown in the dialog', async () => {
    routes(json(200, page([DL])), {
      [`POST /admin/system/dead-letters/${ID}/retry`]: json(409, {
        message: 'Only open dead letters can be retried.',
      }),
    });
    renderQueues();
    await userEvent.click(await screen.findByRole('button', { name: `Retry dead letter ${DL.jobId}` }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Retry job' }));
    expect(await within(dialog).findByText('Only open dead letters can be retried.')).toBeInTheDocument();
  });
});
