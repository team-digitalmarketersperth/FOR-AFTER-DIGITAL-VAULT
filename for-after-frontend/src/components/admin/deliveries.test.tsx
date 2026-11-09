import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DeliveryPage,
  ReleaseEmailDetail as EmailDetail,
  ReleaseEmailItem,
  SafetyNoticeDetail as NoticeDetail,
  SafetyNoticeItem,
} from '@/lib/api/admin';
import { json, renderWithClient, routeFetch, router } from '@/test/utils';
import { DeliveryList, ReleaseEmailDetail, SafetyNoticeDetail } from './deliveries';

vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/admin/deliveries' }));

const REF = '7d6f1d8e-3c55-4a3a-9f1e-2b9a8f0e4c11';
const MSG = '11111111-1111-4111-8111-111111111111';
const CASE = '22222222-2222-4222-8222-222222222222';
const T = '2026-10-30T02:00:00.000Z';
const email = (over: Partial<ReleaseEmailItem> = {}): ReleaseEmailItem => ({
  reference: REF,
  channel: 'EMAIL',
  releaseReference: MSG,
  recipientReference: '66666666-6666-4666-8666-666666666666',
  destination: 'r***@g***.com',
  yearlyOccurrence: false,
  status: 'retrying',
  lastAttemptUncertain: true,
  attemptCount: 2,
  errorCategory: 'timeout',
  acceptedAt: null,
  failedAt: null,
  createdAt: T,
  updatedAt: T,
  ...over,
});
const emailsPage = (items: ReleaseEmailItem[], evaluatedAt = T): DeliveryPage => ({
  evaluatedAt,
  category: 'release_email',
  items,
  pagination: { page: 1, limit: 25, total: items.length, pages: 1 },
});
const MUTATION = /resend|retry now|retry|mark delivered|force|release now|change destination/i;

beforeEach(() => router.replace.mockClear());

describe('Deliveries list', () => {
  it('says what is and is not covered; labels never claim delivery; links to the release and detail', async () => {
    routeFetch({
      'GET /admin/deliveries': json(
        200,
        emailsPage([
          email(),
          email({
            reference: '33333333-3333-4333-8333-333333333333',
            status: 'provider_accepted',
            lastAttemptUncertain: false,
            errorCategory: null,
            acceptedAt: T,
          }),
          email({
            reference: '44444444-4444-4444-8444-444444444444',
            status: 'failed',
            lastAttemptUncertain: false,
            errorCategory: 'provider_error',
            failedAt: T,
          }),
        ]),
      ),
    });
    renderWithClient(<DeliveryList filters={{ page: 1 }} />);
    const coverage = screen.getByRole('complementary', { name: 'Coverage' });
    expect(coverage).toHaveTextContent(/Not covered: Trusted Contact invitations, one-time codes, account emails and any SMS/);
    const table = await screen.findByRole('table', { name: 'Release emails' });
    expect(within(table).getByText('Retrying after a failed attempt')).toBeInTheDocument();
    expect(within(table).getByText('Last attempt: outcome uncertain')).toBeInTheDocument();
    expect(within(table).getByText('Accepted by the email provider')).toBeInTheDocument();
    expect(within(table).getByText('Failed for good')).toBeInTheDocument();
    expect(within(table).getByText('Timed out (outcome uncertain)')).toBeInTheDocument();
    expect(within(table).getByText('Other provider error')).toBeInTheDocument();
    expect(within(table).queryByText(/^Delivered$/)).not.toBeInTheDocument();
    // Shown exactly as the API masked it, with the opaque recipient reference.
    expect(within(table).getAllByText('r***@g***.com')).toHaveLength(3);
    expect(within(table).getAllByText('66666666…')).toHaveLength(3);
    expect(within(table).getAllByRole('link', { name: /Release\s*11111111/ })[0]).toHaveAttribute('href', `/admin/releases/${MSG}`);
    expect(within(table).getByRole('link', { name: /Delivery\s*7d6f1d8e/ })).toHaveAttribute(
      'href',
      `/admin/deliveries/release-emails/${REF}`,
    );
    expect(screen.queryByRole('button', { name: MUTATION })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/https?:|[a-z]{2,}@[a-z]{2,}\./i);
  });

  it('safety notices: their own statuses and columns; release-only filters are not offered', async () => {
    const notice: SafetyNoticeItem = {
      reference: CASE,
      channel: 'EMAIL',
      accountId: MSG,
      caseStatus: 'PENDING_VERIFICATION',
      status: 'attempted',
      attemptCount: 3,
      lastAttemptAt: T,
      acceptedAt: null,
      createdAt: T,
      updatedAt: T,
    };
    routeFetch({
      'GET /admin/deliveries': json(200, {
        evaluatedAt: T,
        category: 'safety_notice',
        items: [notice],
        pagination: { page: 1, limit: 25, total: 1, pages: 1 },
      }),
    });
    renderWithClient(<DeliveryList filters={{ page: 1, category: 'safety_notice' }} />);
    const table = await screen.findByRole('table', { name: 'Safety notices' });
    expect(within(table).getByText('Attempted, not accepted yet')).toBeInTheDocument();
    expect(within(table).getByRole('link', { name: /Delivery\s*22222222/ })).toHaveAttribute(
      'href',
      `/admin/deliveries/safety-notices/${CASE}`,
    );
    const form = screen.getByRole('form', { name: 'Filter deliveries' });
    expect(within(form).queryByLabelText(/Release reference/)).not.toBeInTheDocument();
    expect(within(form).queryByLabelText('Last error')).not.toBeInTheDocument();
    expect(within(form).getByLabelText(/Case reference/)).toBeInTheDocument();
  });

  it('empty, filtered-empty and first-load error states', async () => {
    routeFetch({ 'GET /admin/deliveries': json(200, emailsPage([])) });
    const first = renderWithClient(<DeliveryList filters={{ page: 1 }} />);
    expect(await screen.findByText('No release emails recorded yet')).toBeInTheDocument();
    first.unmount();
    routeFetch({ 'GET /admin/deliveries': json(200, emailsPage([])) });
    const second = renderWithClient(<DeliveryList filters={{ page: 1, status: 'failed' }} />);
    expect(await screen.findByText('No deliveries match these filters')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Clear filters' })).toHaveAttribute('href', '/admin/deliveries');
    second.unmount();
    routeFetch({ 'GET /admin/deliveries': json(503, { message: 'Service unavailable.' }) });
    renderWithClient(<DeliveryList filters={{ page: 1 }} />);
    expect(screen.getByRole('status')).toHaveTextContent(/Loading deliveries/);
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('a failed refresh keeps the last results and says they may be stale', async () => {
    let n = 0;
    routeFetch({
      'GET /admin/deliveries': () => (n++ === 0 ? json(200, emailsPage([email()])) : json(503, { message: 'x' })),
    });
    renderWithClient(<DeliveryList filters={{ page: 1 }} />);
    await screen.findByRole('table', { name: 'Release emails' });
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Couldn’t refresh/);
    expect(screen.getByRole('table', { name: 'Release emails' })).toBeInTheDocument();
  });

  it('filters reach the API validated, and Apply resets the page', async () => {
    const api = routeFetch({ 'GET /admin/deliveries': json(200, emailsPage([email()])) });
    renderWithClient(<DeliveryList filters={{ page: 2, status: 'retrying', outcomeUncertain: 'true', from: '2026-10-01' }} />);
    await screen.findByRole('table');
    const sent = new URL(String(vi.mocked(fetch).mock.calls[0][0]));
    expect(api.calls[0].path).toBe('/admin/deliveries');
    expect(Object.fromEntries(sent.searchParams)).toMatchObject({
      page: '2',
      category: 'release_email',
      status: 'retrying',
      outcomeUncertain: 'true',
    });
    expect(sent.searchParams.get('createdFrom')).toMatch(/^2026-10-01T00:00:00[+-]\d{2}:\d{2}$/);

    const form = screen.getByRole('form', { name: 'Filter deliveries' });
    await userEvent.type(within(form).getByLabelText(/Release reference/), 'nope');
    await userEvent.click(within(form).getByRole('button', { name: 'Apply filters' }));
    expect(await within(form).findByText('Enter a full release reference.')).toBeInTheDocument();
    expect(router.replace).not.toHaveBeenCalled();
    await userEvent.clear(within(form).getByLabelText(/Release reference/));
    await userEvent.selectOptions(within(form).getByLabelText('Last error'), 'rate_limit_exceeded');
    await userEvent.click(within(form).getByRole('button', { name: 'Apply filters' }));
    const target = router.replace.mock.calls[0][0] as string;
    expect(target).toContain('errorCategory=rate_limit_exceeded');
    expect(target).not.toMatch(/page=/);
  });
});

const emailDetail = (over: Partial<EmailDetail> = {}): EmailDetail => ({
  ...email(),
  evaluatedAt: T,
  category: 'release_email',
  providerMessageId: null,
  messageReleaseId: '55555555-5555-4555-8555-555555555555',
  occurrence: null,
  queueJob: { state: 'delayed', attemptsMade: 2, maxAttempts: 5 },
  deadLetters: [],
  history: [{ at: T, event: 'intent_created' }],
  ...over,
});

describe('Delivery details', () => {
  it('release email: uncertain outcome warned as unsafe to resend; queue state; honest history note; read-only', async () => {
    routeFetch({ [`GET /admin/deliveries/release-emails/${REF}`]: json(200, emailDetail()) });
    renderWithClient(<ReleaseEmailDetail reference={REF} />);
    expect(await screen.findByRole('heading', { name: 'Delivery 7d6f1d8e…' })).toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent(/may already have sent it.*do not treat it as safe to resend/i);
    expect(screen.getByText('Retry scheduled (time not shown)')).toBeInTheDocument();
    expect(screen.getByText('Recipient (masked)').nextSibling).toHaveTextContent('r***@g***.com');
    expect(screen.getByText('2 of 5')).toBeInTheDocument();
    expect(screen.getByText(/Only the attempt count and the last error are stored/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: MSG })).toHaveAttribute('href', `/admin/releases/${MSG}`);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('release email: queue unavailable is said, with the stored record still shown; accepted shows the provider id as such', async () => {
    routeFetch({ [`GET /admin/deliveries/release-emails/${REF}`]: json(200, emailDetail({ queueJob: null })) });
    const first = renderWithClient(<ReleaseEmailDetail reference={REF} />);
    expect(await screen.findByText(/Queue data is unavailable right now/)).toBeInTheDocument();
    expect(screen.getByText('Attempts recorded').nextSibling).toHaveTextContent('2');
    first.unmount();
    routeFetch({
      [`GET /admin/deliveries/release-emails/${REF}`]: json(
        200,
        emailDetail({
          status: 'provider_accepted',
          lastAttemptUncertain: false,
          acceptedAt: T,
          providerMessageId: 'provider-msg-1',
          queueJob: undefined,
        }),
      ),
    });
    renderWithClient(<ReleaseEmailDetail reference={REF} />);
    expect(await screen.findByText('provider-msg-1')).toBeInTheDocument();
    expect(screen.getByText(/not a delivery receipt/)).toBeInTheDocument();
    expect(screen.getByText(/Not looked up: the email was already accepted/)).toBeInTheDocument();
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });

  it('safety notice: case fields, links to the case and its audit events; 404 shows not found', async () => {
    const notice: NoticeDetail = {
      reference: CASE,
      channel: 'EMAIL',
      accountId: MSG,
      caseStatus: 'SAFEGUARD_ACTIVE',
      status: 'provider_accepted',
      attemptCount: 1,
      lastAttemptAt: T,
      acceptedAt: T,
      createdAt: T,
      updatedAt: T,
      evaluatedAt: T,
      category: 'safety_notice',
      caseEvents: [{ id: 'e1', createdAt: T }],
      history: [{ at: T, event: 'provider_accepted' }],
    };
    routeFetch({ [`GET /admin/deliveries/safety-notices/${CASE}`]: json(200, notice) });
    const first = renderWithClient(<SafetyNoticeDetail reference={CASE} />);
    expect(await screen.findByText(/failure reasons are only in server logs/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open case' })).toHaveAttribute('href', `/admin/death-verifications/${CASE}`);
    expect(screen.getByRole('link', { name: 'Case audit events' })).toHaveAttribute(
      'href',
      `/admin/audit-logs?subjectType=DeathVerificationCase&subjectId=${CASE}`,
    );
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    first.unmount();
    routeFetch({ [`GET /admin/deliveries/safety-notices/${CASE}`]: json(404, { message: 'Delivery not found.' }) });
    renderWithClient(<SafetyNoticeDetail reference={CASE} />);
    expect(await screen.findByText('We couldn’t find this delivery')).toBeInTheDocument();
  });
});
