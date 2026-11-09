import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Broadcast, RecipientResult } from '@/lib/api/announcements';
import { json, renderWithClient, routeFetch } from '@/test/utils';
import { AnnouncementResults } from './announcement-results';

// Fictional runs and recipients; fetch is mocked, nothing is sent anywhere.
const T = '2026-11-04T06:59:37.000Z';
const ID = '11111111-1111-4111-8111-111111111111';
const RUN = '22222222-2222-4222-8222-222222222222';
const BASE = `/admin/announcements/${ID}/broadcasts/${RUN}`;
const ref = { id: 'r1', firstName: 'Rae', lastName: 'Root', email: 'root@example.test' };
const zero = { QUEUED: 0, PROCESSING: 0, ACCEPTED: 0, FAILED: 0, UNKNOWN: 0, SKIPPED: 0, CANCELLED: 0 };

const run = (over: Partial<Broadcast> = {}): Broadcast => ({
  id: RUN,
  announcementId: ID,
  announcementVersion: 1,
  subject: 'A warm welcome',
  status: 'COMPLETED',
  audience: 'PILOT',
  stopping: false,
  finishReason: null,
  reviewedCount: 1,
  createdAt: T,
  preparedAt: T,
  completedAt: T,
  cancelRequestedAt: null,
  requestedBy: ref,
  cancelledBy: null,
  prepared: 1,
  audiencePrepared: true,
  counts: { ...zero, ACCEPTED: 1 },
  reasons: { QUEUED: {}, SKIPPED: {}, FAILED: {}, UNKNOWN: {} },
  lastUpdatedAt: T,
  pausedUntil: null,
  retry: { eligible: 0, blockedReason: 'broadcast_disabled', limit: 500, activity: [] },
  ...over,
});
const row = (over: Partial<RecipientResult> = {}): RecipientResult => ({
  id: 'rec-1',
  email: 'pia@example.test',
  name: 'Pia Pilot',
  status: 'ACCEPTED',
  reasonCode: null,
  attemptCount: 1,
  lastAttemptAt: T,
  finishedAt: T,
  retryable: false,
  retryBlockedReason: null,
  ...over,
});
const page = (items: RecipientResult[], over: { page?: number; pages?: number; total?: number } = {}) => ({
  items,
  pagination: { page: over.page ?? 1, limit: 25, total: over.total ?? items.length, pages: over.pages ?? 1 },
});

type Handler = Parameters<typeof routeFetch>[0][string];
const setup = (over: Record<string, Handler> = {}) => {
  const urls: URL[] = [];
  const api = routeFetch({
    [`GET ${BASE}`]: json(200, run()),
    [`GET ${BASE}/recipients`]: (_b: unknown, url: URL) => (urls.push(url), json(200, page([row()]))),
    ...over,
  });
  renderWithClient(<AnnouncementResults id={ID} runId={RUN} />);
  return { ...api, urls };
};
const card = (label: string) => within(screen.getByRole('region', { name: 'Summary' })).getByText(label, { selector: 'span' }).nextSibling;

afterEach(() => vi.useRealTimers());

describe('Announcement results', () => {
  it('one accepted recipient: real counts, accurate wording, chart text equivalent, run details, no retry action', async () => {
    const api = setup();
    expect(await screen.findByRole('heading', { level: 1, name: 'Announcement results' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Notification centre' })).toHaveAttribute('href', '/admin/announcements');
    expect(await screen.findByText('A warm welcome')).toBeInTheDocument();
    expect(card('Total recipients')).toHaveTextContent('1');
    expect(card('Accepted by provider')).toHaveTextContent('1');
    expect(card('Failed')).toHaveTextContent('0');
    expect(card('Unknown outcome')).toHaveTextContent('0');
    expect(screen.getByRole('img', { name: 'Email outcomes for 1 recipient: Accepted by provider 1 (100%)' })).toBeInTheDocument();
    const legend = screen.getByRole('list', { name: 'Outcome legend' });
    expect(within(legend).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Accepted by provider1 · 100%',
      'Failed0 · 0%',
      'Unknown outcome0 · 0%',
    ]);
    expect(screen.getByText('Provider acceptance does not confirm inbox delivery.')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/delivered|opened|clicked/i);
    const details = screen.getByRole('region', { name: 'Run details' });
    expect(within(details).getByText('Pilot group')).toBeInTheDocument();
    expect(within(details).getByText(RUN)).toBeInTheDocument();
    expect(within(details).getByRole('button', { name: 'Copy reference' })).toBeInTheDocument();
    expect(within(details).getByText(/^Times in /)).toBeInTheDocument();
    const table = await screen.findByRole('table', { name: 'Recipient results' });
    expect(within(table).getByText('pia@example.test')).toBeInTheDocument();
    expect(within(table).getByText('Accepted by Microsoft')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull();
    expect(api.calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('mixed outcomes: "Completed with issues", every recipient counted once, legend reconciles with the total', async () => {
    setup({ [`GET ${BASE}`]: json(200, run({ prepared: 100, counts: { ...zero, ACCEPTED: 90, FAILED: 4, UNKNOWN: 3, SKIPPED: 2, CANCELLED: 1 } })) });
    expect(await screen.findAllByText('Completed with issues')).not.toHaveLength(0);
    const legend = screen.getByRole('list', { name: 'Outcome legend' });
    const counts = within(legend)
      .getAllByRole('listitem')
      .map((li) => Number(li.textContent!.match(/(\d+) ·/)![1]));
    expect(counts.reduce((a, b) => a + b, 0)).toBe(100);
    expect(screen.getByRole('img', { name: /Email outcomes for 100 recipients: Accepted by provider 90 \(90%\), Failed 4 \(4%\), Unknown outcome 3 \(3%\), Skipped 2 \(2%\), Cancelled before sending 1 \(1%\)/ })).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Other outcomes' })).toHaveTextContent('Skipped: 2Cancelled before sending: 1');
    expect(screen.getByText(/may still have been accepted/)).toBeInTheDocument();
  });

  it('failed loads never look like verified zeros', async () => {
    setup({ [`GET ${BASE}`]: json(503, { message: 'down' }) });
    expect(await screen.findByText('Results are unavailable')).toBeInTheDocument();
    expect(screen.queryByText('Accepted by provider')).toBeNull();
  });

  it('a failed recipient list shows an error, not an empty table', async () => {
    setup({ [`GET ${BASE}/recipients`]: json(503, { message: 'down' }) });
    expect(await screen.findByText('Recipient results are unavailable')).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'Recipient results' })).toBeNull();
    expect(screen.queryByText('No recipients yet')).toBeNull();
  });

  it('filters, search and pages are server-side; filters work from the keyboard; failure reasons are safe text', async () => {
    const { urls } = setup({
      [`GET ${BASE}`]: json(200, run({ prepared: 60, counts: { ...zero, ACCEPTED: 55, FAILED: 5 } })),
      [`GET ${BASE}/recipients`]: (_b: unknown, url: URL) => {
        urls.push(url);
        return json(
          200,
          page([row({ status: 'FAILED', reasonCode: 'ErrorMessageRejected', retryBlockedReason: 'permanent_failure' })], { page: Number(url.searchParams.get('page')), pages: 3, total: 60 }),
        );
      },
    });
    const urls_ = urls;
    await screen.findByRole('table', { name: 'Recipient results' });
    expect(screen.getByText('Provider rejected the email')).toBeInTheDocument();
    expect(screen.getByText('Permanent failure')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('ErrorMessageRejected');
    const failed = screen.getByRole('button', { name: /^Failed/ });
    failed.focus();
    await userEvent.keyboard('{Enter}');
    expect(failed).toHaveAttribute('aria-pressed', 'true');
    await vi.waitFor(() => expect(urls_.at(-1)!.searchParams.get('status')).toBe('FAILED'));
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search recipients' }), 'pia');
    await vi.waitFor(() => expect(urls_.at(-1)!.searchParams.get('q')).toBe('pia'));
    await userEvent.click(await screen.findByRole('button', { name: 'Next' }));
    await vi.waitFor(() => expect(urls_.at(-1)!.searchParams.get('page')).toBe('2'));
    expect(urls_.at(-1)!.searchParams.get('status')).toBe('FAILED');
    expect(urls_.every((u) => u.searchParams.get('limit') === '25')).toBe(true);
  });

  it('an unknown outcome is never retried: "Review" opens its real details with the reconciliation warning', async () => {
    const api = setup({
      [`GET ${BASE}`]: json(200, run({ counts: { ...zero, UNKNOWN: 1 } })),
      [`GET ${BASE}/recipients`]: json(200, page([row({ status: 'UNKNOWN', reasonCode: 'timeout' })])),
      [`GET ${BASE}/recipients/rec-1`]: json(200, { ...row({ status: 'UNKNOWN', reasonCode: 'timeout' }), providerReference: false, history: [] }),
    });
    const table = await screen.findByRole('table', { name: 'Recipient results' });
    expect(within(table).getByText('Provider outcome is uncertain. Do not resend until reconciled.')).toBeInTheDocument();
    expect(within(table).queryByRole('button', { name: /^Retry/ })).toBeNull();
    await userEvent.click(within(table).getByRole('button', { name: 'Review pia@example.test' }));
    const dialog = await screen.findByRole('dialog', { name: 'Recipient result' });
    expect(within(dialog).getByText(/never retried automatically or from this page/)).toBeInTheDocument();
    expect(api.calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('single retry: reviews on the server, shows exactly what will be queued, and confirms that set once', async () => {
    const api = setup({
      [`GET ${BASE}`]: json(200, run({ counts: { ...zero, FAILED: 1 }, retry: { eligible: 1, blockedReason: null, limit: 500, activity: [] } })),
      [`GET ${BASE}/recipients`]: json(200, page([row({ status: 'FAILED', reasonCode: 'unauthorized', attemptCount: 3, retryable: true })])),
      [`POST ${BASE}/retry-review`]: json(200, {
        subject: 'A warm welcome',
        announcementVersion: 1,
        audience: 'PILOT',
        scope: 'ONE',
        count: 1,
        setHash: 'f'.repeat(64),
        blockers: [],
      }),
      [`POST ${BASE}/retries`]: json(202, { retryId: 'rt-1', count: 1 }),
    });
    const table = await screen.findByRole('table', { name: 'Recipient results' });
    expect(within(table).getByText('Email provider sign-in refused')).toBeInTheDocument();
    await userEvent.click(within(table).getByRole('button', { name: 'Retry pia@example.test' }));
    const dialog = await screen.findByRole('dialog', { name: 'Retry this email?' });
    expect(within(dialog).getByText('This queues real email attempts through the email provider.')).toBeInTheDocument();
    expect(await within(dialog).findByText('A warm welcome (version 1)')).toBeInTheDocument();
    expect(within(dialog).getByText('1 recipient')).toBeInTheDocument();
    expect(api.called('POST', `${BASE}/retry-review`)[0]!.body).toEqual({ recipientId: 'rec-1' });
    await userEvent.dblClick(within(dialog).getByRole('button', { name: 'Queue 1 retry' }));
    await vi.waitFor(() => expect(api.called('POST', `${BASE}/retries`)).toHaveLength(1));
    const body = api.called('POST', `${BASE}/retries`)[0]!.body as Record<string, string>;
    expect(Object.keys(body).sort()).toEqual(['clientOperationId', 'recipientId', 'setHash']);
    expect(body).toMatchObject({ recipientId: 'rec-1', setHash: 'f'.repeat(64) });
  });

  it('bulk retry: names the exact count; a server blocker (set changed, gate) shows the reason and offers no confirm', async () => {
    const api = setup({
      [`GET ${BASE}`]: json(200, run({ prepared: 3, counts: { ...zero, ACCEPTED: 1, FAILED: 2 }, retry: { eligible: 2, blockedReason: null, limit: 500, activity: [] } })),
      [`POST ${BASE}/retry-review`]: json(200, {
        subject: 'A warm welcome',
        announcementVersion: 1,
        audience: 'PILOT',
        scope: 'ALL',
        count: 0,
        setHash: 'e'.repeat(64),
        blockers: [{ code: 'broadcast_disabled', message: 'Customer broadcasting is turned off on this server, so retry is unavailable.' }],
      }),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Retry eligible failures (2)' }));
    const dialog = await screen.findByRole('dialog', { name: 'Retry eligible failures?' });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/turned off on this server/);
    expect(within(dialog).queryByRole('button', { name: /^Queue/ })).toBeNull();
    expect(api.called('POST', `${BASE}/retry-review`)[0]!.body).toEqual({});
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(api.called('POST', `${BASE}/retries`)).toHaveLength(0);
  });

  it('broadcasting off: results stay readable, the retry button is disabled with the reason', async () => {
    setup({ [`GET ${BASE}`]: json(200, run({ prepared: 2, counts: { ...zero, ACCEPTED: 1, FAILED: 1 }, retry: { eligible: 1, blockedReason: 'broadcast_disabled', limit: 500, activity: [] } })) });
    const button = await screen.findByRole('button', { name: 'Retry eligible failures (1)' });
    expect(button).toBeDisabled();
    expect(screen.getByText(/Retry is unavailable: customer broadcasting is turned off on this server/)).toBeInTheDocument();
  });

  it('the email as queued: read-only snapshot from the run, not the draft', async () => {
    const api = setup({ [`GET ${BASE}/email`]: json(200, { subject: 'A warm welcome', announcementVersion: 1, html: '<p>Queued email</p>', text: 'Queued email' }) });
    await userEvent.click(await screen.findByRole('button', { name: 'View email' }));
    const dialog = await screen.findByRole('dialog', { name: 'Email as queued' });
    expect(await within(dialog).findByTitle('Email preview')).toHaveAttribute('srcdoc', '<p>Queued email</p>');
    expect(api.called('GET', `/admin/announcements/${ID}`)).toHaveLength(0);
  });

  it('polling: run and recipients refresh while sending, and stop at a terminal state', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let current = run({ status: 'SENDING', completedAt: null, counts: { ...zero, QUEUED: 1 }, lastUpdatedAt: new Date().toISOString() });
    const api = setup({ [`GET ${BASE}`]: () => json(200, current) });
    expect((await screen.findAllByText('Sending', { selector: 'span' })).length).toBeGreaterThan(0);
    await screen.findByRole('table', { name: 'Recipient results' });
    const lists = () => api.called('GET', `${BASE}/recipients`).length;
    const before = lists();
    await vi.advanceTimersByTimeAsync(5_100);
    expect(lists()).toBeGreaterThan(before);
    current = run();
    await vi.advanceTimersByTimeAsync(5_100);
    expect((await screen.findAllByText('Completed')).length).toBeGreaterThan(0);
    const polls = api.called('GET', BASE).length;
    const listed = lists();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.called('GET', BASE)).toHaveLength(polls);
    expect(lists()).toBe(listed);
  });

  it('leaving the page stops polling (no timers left behind)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const urls: URL[] = [];
    const api = routeFetch({
      [`GET ${BASE}`]: json(200, run({ status: 'SENDING', completedAt: null, lastUpdatedAt: new Date().toISOString() })),
      [`GET ${BASE}/recipients`]: (_b: unknown, url: URL) => (urls.push(url), json(200, page([row()]))),
    });
    const { unmount } = renderWithClient(<AnnouncementResults id={ID} runId={RUN} />);
    await screen.findByRole('table', { name: 'Recipient results' });
    unmount();
    const calls = api.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.calls).toHaveLength(calls);
  });

  it('a failed refresh keeps the last known state and says so', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let fail = false;
    setup({ [`GET ${BASE}`]: () => (fail ? json(503, { message: 'down' }) : json(200, run({ status: 'SENDING', completedAt: null, lastUpdatedAt: new Date().toISOString() }))) });
    await screen.findAllByText('Sending', { selector: 'span' });
    fail = true;
    await vi.advanceTimersByTimeAsync(5_100);
    expect(await screen.findByText(/Couldn.t refresh the results. Showing the last known state/)).toBeInTheDocument();
  });
});
