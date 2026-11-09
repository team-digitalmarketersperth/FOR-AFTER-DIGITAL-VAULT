import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReleaseDetail as Detail, ReleaseItem, ReleasePage } from '@/lib/api/admin';
import { json, renderWithClient, routeFetch, router } from '@/test/utils';
import { ReleaseDetail, ReleaseList } from './releases';

vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/admin/releases' }));

const REF = '7d6f1d8e-3c55-4a3a-9f1e-2b9a8f0e4c11';
const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const CASE = '22222222-2222-4222-8222-222222222222';
const item = (over: Partial<ReleaseItem> = {}): ReleaseItem => ({
  reference: REF,
  accountId: ACCOUNT,
  status: 'SCHEDULED',
  triggerType: 'ON_DEATH',
  scheduledFor: null,
  releasedAt: null,
  assessment: 'awaiting_death_verification',
  deathCaseStatus: 'SAFEGUARD_ACTIVE',
  safeguardEndsAt: '2026-11-05T00:00:00.000Z',
  lastRecordedAt: '2026-10-01T00:00:00.000Z',
  ...over,
});
const page = (items: ReleaseItem[], evaluatedAt = '2026-10-30T02:00:00.000Z'): ReleasePage => ({
  evaluatedAt,
  items,
  pagination: { page: 1, limit: 25, total: items.length, pages: 1 },
});
const MUTATION = /release now|retry|cancel|reschedule|verify|reject|suspend|override|delete/i;

beforeEach(() => router.replace.mockClear());

describe('Releases list', () => {
  it('rows show references, labels and stored times only; links to the detail and the account; no mutation controls', async () => {
    const api = routeFetch({
      'GET /admin/releases': json(
        200,
        page([
          item(),
          item({
            reference: '33333333-3333-4333-8333-333333333333',
            triggerType: 'FIXED_DATE',
            scheduledFor: '2026-10-29T00:00:00.000Z',
            assessment: 'past_due',
            deathCaseStatus: null,
            safeguardEndsAt: null,
          }),
        ]),
      ),
    });
    renderWithClient(<ReleaseList filters={{ page: 1 }} />);
    const table = await screen.findByRole('table', { name: 'Releases' });
    expect(within(table).getByRole('link', { name: /Release\s*7d6f1d8e/ })).toHaveAttribute('href', `/admin/releases/${REF}`);
    expect(within(table).getAllByRole('link', { name: /Account\s*11111111/ })[0]).toHaveAttribute(
      'href',
      `/admin/users/${ACCOUNT}`,
    );
    expect(within(table).getByText('Waiting for a verified death')).toBeInTheDocument();
    expect(within(table).getByText('Past due, not yet released')).toBeInTheDocument();
    // The worker's refusal reasons are not stored: said, never guessed.
    expect(within(table).getByText('Reason not recorded')).toBeInTheDocument();
    expect(within(table).getByText('On verified death')).toBeInTheDocument();
    expect(within(table).getByText(/safeguard ends/)).toBeInTheDocument();
    expect(screen.getByText(/^Assessed .*A snapshot only/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: MUTATION })).not.toBeInTheDocument();
    // First load asks for page 1 only.
    expect(api.called('GET', '/admin/releases')).toHaveLength(1);
  });

  it('empty and filtered-empty states', async () => {
    routeFetch({ 'GET /admin/releases': json(200, page([])) });
    const { unmount } = renderWithClient(<ReleaseList filters={{ page: 1 }} />);
    expect(await screen.findByText('No scheduled or released messages yet')).toBeInTheDocument();
    unmount();
    routeFetch({ 'GET /admin/releases': json(200, page([])) });
    renderWithClient(<ReleaseList filters={{ page: 1, pastDue: 'true' }} />);
    expect(await screen.findByText('No releases match these filters')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Clear filters' })).toHaveAttribute('href', '/admin/releases');
  });

  it('loading, then the error state when the first load fails', async () => {
    routeFetch({ 'GET /admin/releases': json(503, { message: 'Service unavailable.' }) });
    renderWithClient(<ReleaseList filters={{ page: 1 }} />);
    expect(screen.getByRole('status')).toHaveTextContent(/Loading releases/);
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('a failed refresh keeps the last results and says they may be stale', async () => {
    let n = 0;
    routeFetch({
      'GET /admin/releases': () => (n++ === 0 ? json(200, page([item()])) : json(503, { message: 'Service unavailable.' })),
    });
    renderWithClient(<ReleaseList filters={{ page: 1 }} />);
    await screen.findByRole('table', { name: 'Releases' });
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Couldn’t refresh\. These results are from .* may be out of date/);
    expect(screen.getByRole('table', { name: 'Releases' })).toBeInTheDocument();
  });

  it('filters go to the URL on Apply (page reset) and reach the API as validated values', async () => {
    const api = routeFetch({ 'GET /admin/releases': json(200, page([item()])) });
    renderWithClient(
      <ReleaseList filters={{ page: 3, status: 'SCHEDULED', from: '2026-10-01', to: '2026-10-31', pastDue: 'true' }} />,
    );
    await screen.findByRole('table');
    expect(api.calls[0].path).toBe('/admin/releases');
    // The query string carries calendar days as ISO instants with an offset.
    const sent = new URL((vi.mocked(fetch).mock.calls[0][0] as string).toString());
    expect(sent.searchParams.get('status')).toBe('SCHEDULED');
    expect(sent.searchParams.get('pastDue')).toBe('true');
    expect(sent.searchParams.get('page')).toBe('3');
    expect(sent.searchParams.get('scheduledFrom')).toMatch(/^2026-10-01T00:00:00[+-]\d{2}:\d{2}$/);
    expect(sent.searchParams.get('scheduledTo')).toMatch(/^2026-10-31T23:59:59\.999[+-]\d{2}:\d{2}$/);

    const form = screen.getByRole('form', { name: 'Filter releases' });
    await userEvent.type(within(form).getByLabelText(/Release reference/), 'not-a-uuid');
    await userEvent.click(within(form).getByRole('button', { name: 'Apply filters' }));
    expect(await within(form).findByText('Enter a full release reference.')).toBeInTheDocument();
    expect(router.replace).not.toHaveBeenCalled();

    await userEvent.clear(within(form).getByLabelText(/Release reference/));
    await userEvent.selectOptions(within(form).getByLabelText('Trigger'), 'FIXED_DATE');
    await userEvent.click(within(form).getByRole('button', { name: 'Apply filters' }));
    expect(router.replace).toHaveBeenCalledTimes(1);
    const target = router.replace.mock.calls[0][0] as string;
    expect(target).toMatch(/^\/admin\/releases\?/);
    expect(target).toContain('triggerType=FIXED_DATE');
    expect(target).toContain('pastDue=true');
    expect(target).not.toMatch(/page=/);
  });
});

const detail = (over: Partial<Detail> = {}): Detail => ({
  evaluatedAt: '2026-10-30T02:00:00.000Z',
  reference: REF,
  accountId: ACCOUNT,
  status: 'RELEASED',
  assessment: 'released',
  liveRecipients: 1,
  schedule: {
    triggerType: 'ON_DEATH',
    scheduledFor: null,
    afterDeathDays: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  },
  release: {
    id: '44444444-4444-4444-8444-444444444444',
    triggerType: 'ON_DEATH',
    scheduledFor: null,
    releasedAt: '2026-10-02T00:00:00.000Z',
    accessGrants: 1,
  },
  deathActivation: {
    id: '55555555-5555-4555-8555-555555555555',
    triggerType: 'ON_DEATH',
    activatedAt: '2026-10-02T00:00:00.000Z',
    dueAt: '2026-10-02T00:00:00.000Z',
    deathVerificationCaseId: CASE,
  },
  deathCase: {
    id: CASE,
    status: 'VERIFIED',
    openedAt: '2026-09-20T00:00:00.000Z',
    safeguardEndsAt: '2026-09-27T00:00:00.000Z',
    verifiedAt: '2026-10-02T00:00:00.000Z',
  },
  occurrences: { released: 0, pending: 0, pastDue: 0, nextDueAt: null },
  releaseEmails: { pending: 1, retrying: 1, accepted: 2, failed: 0 },
  deadLetters: [
    {
      id: 'd1',
      queueName: 'email-delivery',
      errorCode: 'rate_limited',
      failedAt: '2026-10-02T00:05:00.000Z',
      failureCount: 3,
      status: 'OPEN',
    },
  ],
  history: [
    { at: '2026-10-02T00:05:00.000Z', event: 'job_dead_lettered' },
    { at: '2026-10-02T00:00:00.000Z', event: 'released' },
    { at: '2026-09-01T00:00:00.000Z', event: 'schedule_saved' },
  ],
  ...over,
});

describe('Release detail', () => {
  it('stored facts, recorded history and links to existing pages only; read-only', async () => {
    routeFetch({ [`GET /admin/releases/${REF}`]: json(200, detail()) });
    renderWithClient(<ReleaseDetail reference={REF} />);
    expect(await screen.findByRole('heading', { name: 'Release 7d6f1d8e…' })).toBeInTheDocument();
    expect(screen.getByText('A release is recorded for this message.')).toBeInTheDocument();
    const history = screen.getByRole('heading', { name: 'Recorded history' }).closest('section')!;
    expect(within(history).getAllByRole('listitem').map((li) => li.firstChild?.textContent)).toEqual([
      'Background job failed for good (dead letter)',
      'Release recorded',
      'Current schedule saved',
    ]);
    expect(screen.getByRole('link', { name: 'Open case' })).toHaveAttribute('href', `/admin/death-verifications/${CASE}`);
    expect(screen.getByRole('link', { name: 'Case audit events' })).toHaveAttribute(
      'href',
      `/admin/audit-logs?subjectType=DeathVerificationCase&subjectId=${CASE}`,
    );
    expect(screen.getByRole('link', { name: ACCOUNT })).toHaveAttribute('href', `/admin/users/${ACCOUNT}`);
    expect(screen.getByRole('link', { name: 'Open in Queues' })).toHaveAttribute(
      'href',
      '/admin/system/queues?dlQueue=email-delivery',
    );
    // Email counts: waiting excludes retrying; accepted is not called delivered.
    const emails = screen.getByRole('heading', { name: 'Release emails' }).closest('section')!;
    expect(within(emails).getByText('Waiting to send').nextSibling).toHaveTextContent('0');
    expect(within(emails).getByText('Accepted by the email provider')).toBeInTheDocument();
    expect(within(emails).getByText(/Accepted is not confirmed delivery/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('an honest empty history and no death panel when none applies', async () => {
    routeFetch({
      [`GET /admin/releases/${REF}`]: json(
        200,
        detail({
          status: 'SCHEDULED',
          assessment: 'scheduled',
          release: null,
          deathActivation: null,
          deathCase: null,
          deadLetters: [],
          history: [],
          schedule: { ...detail().schedule!, triggerType: 'FIXED_DATE', scheduledFor: '2027-01-01T00:00:00.000Z' },
        }),
      ),
    });
    renderWithClient(<ReleaseDetail reference={REF} />);
    expect(await screen.findByText('No events are recorded for this message.')).toBeInTheDocument();
    expect(screen.getByText('No whole-message release is recorded.')).toBeInTheDocument();
    expect(screen.getByText('No dead letters are recorded for this message.')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Death verification' })).not.toBeInTheDocument();
  });

  it('404 shows not found with a way back', async () => {
    routeFetch({ [`GET /admin/releases/${REF}`]: json(404, { message: 'Release not found.' }) });
    renderWithClient(<ReleaseDetail reference={REF} />);
    expect(await screen.findByText('We couldn’t find this release')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to releases' })).toHaveAttribute('href', '/admin/releases');
  });
});
