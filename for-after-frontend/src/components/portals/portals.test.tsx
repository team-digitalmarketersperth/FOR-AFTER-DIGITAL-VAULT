import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SafetyBanner } from '@/components/layout/safety-banner';
import { CASE_STATUSES, type CaseStatus } from '@/lib/api/portals';
import { REPORTER_STATUS } from '@/lib/death-verification';
import { portalKeys, queryKeys } from '@/lib/query/query-client';
import { json, renderWithClient, routeFetch, router } from '@/test/utils';
import { PortalGate, PortalShell } from './portal-shell';
import { RecipientSignIn, ReleasedMessageList, ReleasedMessageView } from './recipient';
import { AccountList, AccountStatus, ReportForm, TrustedContactInvitation, TrustedContactSignIn } from './trusted-contact';

vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/recipient/messages' }));

const CHALLENGE = 'a'.repeat(43);
const RECIPIENT_MSG = 'If released content is available for this email, a verification code has been sent.';
const INVALID = { statusCode: 401, message: 'The code is invalid or has expired. Request a new code.' };

async function requestCode(email = 'sofia@example.com') {
  await userEvent.type(screen.getByLabelText('Email'), email);
  await userEvent.click(screen.getByRole('button', { name: 'Send me a code' }));
}

describe('Recipient sign-in (FE-21)', () => {
  it('shows the API’s generic message, then a single accessible code field', async () => {
    const api = routeFetch({
      'GET /recipient-auth/me': json(401, { statusCode: 401 }),
      'POST /recipient-auth/request-otp': json(202, { challengeId: CHALLENGE, message: RECIPIENT_MSG }),
    });
    renderWithClient(<RecipientSignIn />);
    await userEvent.click(screen.getByRole('button', { name: 'Send me a code' }));
    expect(await screen.findByText('Enter your email address.')).toBeInTheDocument();
    await requestCode();

    expect(await screen.findByText(RECIPIENT_MSG)).toBeInTheDocument();
    const code = screen.getByLabelText('6-digit code');
    expect(code).toHaveAttribute('inputmode', 'numeric');
    expect(code).toHaveAttribute('autocomplete', 'one-time-code');
    expect(code).toHaveValue(''); // never pre-filled
    expect(api.called('POST', '/recipient-auth/request-otp')[0]).toMatchObject({
      body: { email: 'sofia@example.com' },
      credentials: 'include',
    });
    // Never the Customer session.
    expect(api.calls.some((c) => c.path === '/auth/me')).toBe(false);
  });

  it('verifies the pasted code with the challenge id and opens the messages', async () => {
    const api = routeFetch({
      'POST /recipient-auth/request-otp': json(202, { challengeId: CHALLENGE, message: RECIPIENT_MSG }),
      'POST /recipient-auth/verify-otp': json(200, { authenticated: true, email: 'sofia@example.com' }),
    });
    renderWithClient(<RecipientSignIn />);
    await requestCode();
    await userEvent.click(await screen.findByLabelText('6-digit code'));
    await userEvent.paste('123 456');
    expect(screen.getByLabelText('6-digit code')).toHaveValue('123456');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/recipient/messages'));
    expect(api.called('POST', '/recipient-auth/verify-otp')[0].body).toEqual({ challengeId: CHALLENGE, code: '123456' });
  });

  it.each([
    ['wrong', INVALID, 'The code is invalid or has expired. Request a new code.'],
    ['expired', INVALID, 'The code is invalid or has expired. Request a new code.'],
    ['rate limited', { statusCode: 429, message: 'Too many requests.' }, 'Too many attempts. Please try again shortly.'],
  ])('shows a safe message for a %s code and clears it', async (_name, body, message) => {
    routeFetch({
      'POST /recipient-auth/request-otp': json(202, { challengeId: CHALLENGE, message: RECIPIENT_MSG }),
      'POST /recipient-auth/verify-otp': json(body.statusCode, body),
    });
    renderWithClient(<RecipientSignIn />);
    await requestCode();
    await userEvent.type(await screen.findByLabelText('6-digit code'), '000000');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getByLabelText('6-digit code')).toHaveValue('');
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('asks for all 6 digits before calling the API', async () => {
    const api = routeFetch({ 'POST /recipient-auth/request-otp': json(202, { challengeId: CHALLENGE, message: RECIPIENT_MSG }) });
    renderWithClient(<RecipientSignIn />);
    await requestCode();
    await userEvent.type(await screen.findByLabelText('6-digit code'), '12a3');
    expect(screen.getByLabelText('6-digit code')).toHaveValue('123');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(screen.getByText('Enter the 6 digits from the email.')).toBeInTheDocument();
    expect(api.called('POST', '/recipient-auth/verify-otp')).toHaveLength(0);
  });
});

describe('Portal sessions stay separate', () => {
  it('a signed-out recipient goes to the recipient sign-in, never the Customer /login', async () => {
    const api = routeFetch({ 'GET /recipient-auth/me': json(401, { statusCode: 401, message: 'Unauthorized' }) });
    renderWithClient(
      <PortalGate portal="recipient">
        <p>Released content</p>
      </PortalGate>,
    );
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/recipient/sign-in'));
    expect(screen.queryByText('Released content')).not.toBeInTheDocument();
    expect(api.calls.map((c) => c.path)).toEqual(['/recipient-auth/me']);
  });

  it('sign out ends only the recipient session and forgets recipient data', async () => {
    const api = routeFetch({ 'POST /recipient-auth/logout': new Response(null, { status: 204 }) });
    const { queryClient } = renderWithClient(
      <PortalShell portal="recipient" email="sofia@example.com">
        <p>Messages</p>
      </PortalShell>,
    );
    queryClient.setQueryData(queryKeys.me, { id: 'customer' });
    queryClient.setQueryData(portalKeys.releasedMessages, [{ id: 'm1' }]);
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/recipient/sign-in'));
    expect(api.called('POST', '/recipient-auth/logout')).toHaveLength(1);
    expect(queryClient.getQueryData(portalKeys.releasedMessages)).toBeUndefined();
    expect(queryClient.getQueryData(portalKeys.me('recipient'))).toBeNull();
    expect(queryClient.getQueryData(queryKeys.me)).toEqual({ id: 'customer' }); // Customer untouched
  });

  it('a 401 in a portal does not sign the Customer out (and vice versa)', async () => {
    routeFetch({ 'GET /recipient/messages': json(401, { statusCode: 401 }) });
    const { queryClient } = renderWithClient(<ReleasedMessageList />);
    queryClient.setQueryData(queryKeys.me, { id: 'customer' });
    queryClient.setQueryData(portalKeys.me('recipient'), { email: 'sofia@example.com' });
    await waitFor(() => expect(queryClient.getQueryData(portalKeys.me('recipient'))).toBeNull());
    expect(queryClient.getQueryData(queryKeys.me)).toEqual({ id: 'customer' });
  });
});

const released = { id: 'm1', title: 'For Sofia', contentType: 'MIXED', releasedAt: '2026-09-01T00:00:00Z', hasMedia: true };

describe('Released messages (FE-22, FE-23)', () => {
  it('lists released messages calmly, or an empty state', async () => {
    routeFetch({ 'GET /recipient/messages': json(200, [released]) });
    const { unmount } = renderWithClient(<ReleasedMessageList />);
    const link = await screen.findByRole('link', { name: /For Sofia/ });
    expect(link).toHaveAttribute('href', '/recipient/messages/m1');
    expect(link).toHaveTextContent(/Mixed · Shared 1 Sept? 2026/);
    unmount();

    routeFetch({ 'GET /recipient/messages': json(200, []) });
    renderWithClient(<ReleasedMessageList />);
    expect(await screen.findByText("There aren't any messages here right now")).toBeInTheDocument();
  });

  it('shows text as text with line breaks, and photo/audio through signed URLs', async () => {
    const api = routeFetch({
      'GET /recipient/messages/m1': json(200, { ...released, textContent: 'Dear Sofia,\n\n<b>Love</b>, Mum' }),
      'GET /recipient/messages/m1/media': json(200, [
        { id: 'p1', kind: 'PHOTO', originalFileName: 'beach.jpg', mimeType: 'image/jpeg', sizeBytes: 2048, uploadedAt: null },
        { id: 'a1', kind: 'AUDIO', originalFileName: 'song.m4a', mimeType: 'audio/mp4', sizeBytes: 4096, uploadedAt: null },
      ]),
      'GET /recipient/messages/m1/media/p1/access-url': json(200, { url: 'https://storage.test/photo', expiresAt: '2030-01-01T00:00:00Z' }),
      'GET /recipient/messages/m1/media/a1/access-url': json(200, { url: 'https://storage.test/audio', expiresAt: '2030-01-01T00:00:00Z' }),
    });
    renderWithClient(<ReleasedMessageView id="m1" />);
    const text = await screen.findByText(/Dear Sofia/);
    expect(text.textContent).toBe('Dear Sofia,\n\n<b>Love</b>, Mum'); // not parsed as HTML
    expect(text).toHaveClass('whitespace-pre-wrap');
    expect(await screen.findByRole('img', { name: 'beach.jpg' })).toHaveAttribute('src', 'https://storage.test/photo');
    // Audio URL only when asked for.
    expect(api.called('GET', '/recipient/messages/m1/media/a1/access-url')).toHaveLength(0);
    await userEvent.click(screen.getByRole('button', { name: 'Listen' }));
    expect(await screen.findByLabelText('Play song.m4a')).toHaveAttribute('src', 'https://storage.test/audio');
    // Recipients cannot change anything.
    expect(screen.queryByRole('button', { name: /Remove|Add a photo|Upload audio/ })).not.toBeInTheDocument();
    expect(api.calls.every((c) => c.path.startsWith('/recipient/'))).toBe(true);
  });

  it('VIDEO (Phase 12): plays from a signed URL fetched only when asked, view-only', async () => {
    const api = routeFetch({
      'GET /recipient/messages/m1': json(200, { ...released, contentType: 'VIDEO', textContent: null }),
      'GET /recipient/messages/m1/media': json(200, [
        { id: 'v1', kind: 'VIDEO', originalFileName: 'hello.mp4', mimeType: 'video/mp4', sizeBytes: 9000, uploadedAt: null },
      ]),
      'GET /recipient/messages/m1/media/v1/access-url': json(200, { url: 'https://media.test/v?ik-s=1', expiresAt: '2030-01-01T00:00:00Z' }),
    });
    renderWithClient(<ReleasedMessageView id="m1" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Watch' }));
    expect(await screen.findByLabelText('Play hello.mp4')).toHaveAttribute('src', 'https://media.test/v?ik-s=1');
    expect(api.called('GET', '/recipient/messages/m1/media/v1/access-url')).toHaveLength(1);
    expect(screen.queryByText(/can.t be shown here/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Remove|Add a video/ })).not.toBeInTheDocument();
  });

  it('keeps a failed media link local, with a retry that fetches a fresh URL', async () => {
    let attempts = 0;
    routeFetch({
      'GET /recipient/messages/m1': json(200, { ...released, contentType: 'PHOTO', textContent: null }),
      'GET /recipient/messages/m1/media': json(200, [
        { id: 'p1', kind: 'PHOTO', originalFileName: 'beach.jpg', mimeType: 'image/jpeg', sizeBytes: 2048, uploadedAt: null },
      ]),
      'GET /recipient/messages/m1/media/p1/access-url': () =>
        ++attempts === 1 ? json(500, {}) : json(200, { url: 'https://storage.test/fresh', expiresAt: '2030-01-01T00:00:00Z' }),
    });
    renderWithClient(<ReleasedMessageView id="m1" />);
    expect(await screen.findByText('This couldn’t be loaded.'.replace('’', "'"))).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'For Sofia' })).toBeInTheDocument(); // page still fine
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('img', { name: 'beach.jpg' })).toHaveAttribute('src', 'https://storage.test/fresh');
  });

  it('shows the same not-found for anything not shared with you', async () => {
    routeFetch({ 'GET /recipient/messages/zzz': json(404, { statusCode: 404, message: 'Message not found.' }) });
    renderWithClient(<ReleasedMessageView id="zzz" />);
    expect(await screen.findByText('We couldn’t find this message')).toBeInTheDocument();
  });
});

const account = (over: object = {}) => ({
  trustedContactId: 't1',
  accountHolder: { displayName: 'Sarah Mitchell' },
  relationship: 'Friend',
  hasPreservedContent: true,
  deathVerificationStatus: null,
  ...over,
});

describe('Trusted Contact portal (FE-24 to FE-27)', () => {
  it('sign-in shows its own generic message and handles 429', async () => {
    routeFetch({ 'POST /trusted-contact-auth/request-otp': json(429, { statusCode: 429, message: 'Too many requests.' }) });
    renderWithClient(<TrustedContactSignIn />);
    await requestCode('david@example.com');
    expect(await screen.findByText('Too many attempts. Please try again shortly.')).toBeInTheDocument();
  });

  it('lists accounts with only the returned facts: no counts, no content', async () => {
    routeFetch({
      'GET /trusted-contact/accounts': json(200, [
        account(),
        account({ trustedContactId: 't2', accountHolder: { displayName: 'Tom Lee' }, relationship: null, hasPreservedContent: false, deathVerificationStatus: 'SAFEGUARD_ACTIVE' }),
      ]),
    });
    renderWithClient(<AccountList />);
    const sarah = await screen.findByRole('link', { name: /Sarah Mitchell/ });
    expect(sarah).toHaveAttribute('href', '/trusted-contact/accounts/t1');
    expect(sarah).toHaveTextContent('Friend');
    expect(sarah).toHaveTextContent('Has preserved content');
    expect(sarah).toHaveTextContent('No report submitted');
    const tom = screen.getByRole('link', { name: /Tom Lee/ });
    expect(tom).toHaveTextContent('No preserved content yet');
    expect(tom).toHaveTextContent('Verification underway');
    expect(screen.getByText(/you don't confirm the death yourself, and a report never releases any messages/)).toBeInTheDocument();
  });

  it.each([...CASE_STATUSES, null] as (CaseStatus | null)[])('describes the %s status humanely', async (status) => {
    routeFetch({
      'GET /trusted-contact/accounts': json(200, [account({ deathVerificationStatus: status })]),
      // As the API answers: only a VERIFIED case can never be reported again.
      'GET /trusted-contact/accounts/t1/death-verification': json(200, {
        status,
        reportedByYou: false,
        openedAt: status ? '2026-09-20T00:00:00Z' : null,
        canReport: status !== 'VERIFIED',
      }),
    });
    renderWithClient(<AccountStatus id="t1" />);
    const copy = REPORTER_STATUS[status ?? 'NONE'];
    expect(await screen.findByRole('heading', { name: copy.label })).toBeInTheDocument();
    expect(screen.getByText(copy.description)).toBeInTheDocument();
    expect(screen.queryByText(status ?? 'NONE')).not.toBeInTheDocument(); // never the raw enum
    const closed = status === 'CANCELLED' || status === 'REJECTED';
    expect(screen.queryByRole('link', { name: 'Submit a death report' }) !== null).toBe(status !== 'VERIFIED' && !closed);
    // Phase 10: after a closed case a new report starts a new verification.
    expect(screen.queryByRole('link', { name: 'Submit a new death report' }) !== null).toBe(closed);
    if (status === 'VERIFIED') expect(screen.getByText("This account isn't accepting new reports.")).toBeInTheDocument();
  });

  it('a contact who reported into a closed case may report again (the API decides)', async () => {
    routeFetch({
      'GET /trusted-contact/accounts': json(200, [account({ deathVerificationStatus: 'CANCELLED' })]),
      'GET /trusted-contact/accounts/t1/death-verification': json(200, {
        status: 'CANCELLED',
        reportedByYou: true,
        openedAt: '2026-09-20T00:00:00Z',
        canReport: true,
      }),
    });
    renderWithClient(<ReportForm id="t1" />);
    expect(await screen.findByRole('button', { name: 'Submit report' })).toBeInTheDocument();
  });

  const reportRoutes = (reportResponse: Response) =>
    routeFetch({
      'GET /trusted-contact/accounts': json(200, [account()]),
      'GET /trusted-contact/accounts/t1/death-verification': json(200, { status: null, reportedByYou: false, openedAt: null, canReport: true }),
      'POST /trusted-contact/accounts/t1/death-reports': reportResponse,
    });

  it('requires the explicit confirmation, blocks future dates and long notes, and sends a date-only value', async () => {
    const api = reportRoutes(
      json(201, { caseId: 'c', reportId: 'r', status: 'PENDING_VERIFICATION', reportedAt: '2026-09-30T00:00:00Z', message: 'ok' }),
    );
    renderWithClient(<ReportForm id="t1" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Submit report' }));
    expect(await screen.findByText('Please confirm you understand before submitting.')).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText(/^Date of death/), '2999-01-01');
    await userEvent.click(screen.getByLabelText(/^Note for the For After team/));
    await userEvent.paste('x'.repeat(2001));
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: 'Submit report' }));
    expect(await screen.findByText('The date can’t be in the future.')).toBeInTheDocument();
    expect(screen.getByText('The note must be 2,000 characters or fewer.')).toBeInTheDocument();
    expect(api.called('POST', '/trusted-contact/accounts/t1/death-reports')).toHaveLength(0);

    await userEvent.clear(screen.getByLabelText(/^Date of death/));
    await userEvent.type(screen.getByLabelText(/^Date of death/), '2026-09-01');
    await userEvent.clear(screen.getByLabelText(/^Note for the For After team/));
    expect(screen.getByRole('region', { name: 'Summary' })).toHaveTextContent('Date of death: 1 September 2026');
    await userEvent.click(screen.getByRole('button', { name: 'Submit report' }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/trusted-contact/accounts/t1'));
    expect(api.called('POST', '/trusted-contact/accounts/t1/death-reports')[0].body).toEqual({
      reportedDateOfDeath: '2026-09-01',
      note: null,
      confirmReport: true,
    });
  });

  it('still confirms and opens the status page when the refetched status hides the form', async () => {
    // As the real API answers: after the report the case is open and reported by you,
    // so ReportForm swaps the form for "already submitted" once the status refetches.
    // The accounts refetch answers last, so the status update renders while the
    // mutation is still settling (the order seen in a real browser).
    let reported = false;
    const api = routeFetch({
      'GET /trusted-contact/accounts': (() =>
        reported
          ? new Promise((r) => setTimeout(() => r(json(200, [account()])), 100))
          : json(200, [account()])) as unknown as Response,
      'GET /trusted-contact/accounts/t1/death-verification': () =>
        json(200, reported
          ? { status: 'PENDING_VERIFICATION', reportedByYou: true, openedAt: '2026-09-30T00:00:00Z', canReport: false }
          : { status: null, reportedByYou: false, openedAt: null, canReport: true }),
      'POST /trusted-contact/accounts/t1/death-reports': () => {
        reported = true;
        return json(201, { caseId: 'c', reportId: 'r', status: 'PENDING_VERIFICATION', reportedAt: '2026-09-30T00:00:00Z', message: 'ok' });
      },
    });
    renderWithClient(<ReportForm id="t1" />);
    await userEvent.click(await screen.findByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: 'Submit report' }));
    await waitFor(() => expect(api.called('GET', '/trusted-contact/accounts/t1/death-verification')).toHaveLength(2));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/trusted-contact/accounts/t1'));
  });

  it('the date is optional', async () => {
    const api = reportRoutes(json(201, { caseId: 'c', reportId: 'r', status: 'PENDING_VERIFICATION', reportedAt: '2026-09-30T00:00:00Z', message: 'ok' }));
    renderWithClient(<ReportForm id="t1" />);
    expect(await screen.findByRole('region', { name: 'Summary' })).toHaveTextContent('Date of death: Not provided');
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: 'Submit report' }));
    await waitFor(() => expect(api.called('POST', '/trusted-contact/accounts/t1/death-reports')[0]?.body).toMatchObject({ reportedDateOfDeath: null }));
  });

  it('treats a duplicate report (409) as an expected state', async () => {
    reportRoutes(json(409, { statusCode: 409, message: 'A report has already been submitted for this account.' }));
    renderWithClient(<ReportForm id="t1" />);
    await userEvent.click(await screen.findByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: 'Submit report' }));
    expect(await screen.findByRole('heading', { name: 'You’ve already submitted a report' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'See the status' })).toHaveAttribute('href', '/trusted-contact/accounts/t1');
  });
});

describe('Trusted Contact invitation page (Phase 10)', () => {
  const TOKEN = 'k'.repeat(43);
  const pending = { status: 'PENDING', accountHolder: { displayName: 'Lisa Rossi' } };

  it('shows who invited them and the role, then accepts without signing anyone in', async () => {
    const api = routeFetch({
      'POST /trusted-contact/invitation/view': json(200, pending),
      'POST /trusted-contact/invitation/accept': json(200, { ...pending, status: 'ACCEPTED' }),
    });
    renderWithClient(<TrustedContactInvitation token={TOKEN} />);
    expect(await screen.findByRole('heading', { name: /trusted contact for Lisa Rossi/ })).toBeInTheDocument();
    expect(screen.getByText(/not be given access to their private preserved messages/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Accept invitation' }));
    expect(await screen.findByRole('heading', { name: 'You’ve accepted the invitation' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to trusted contact sign-in' })).toHaveAttribute('href', '/trusted-contact/sign-in');
    expect(api.called('POST', '/trusted-contact/invitation/accept')[0].body).toEqual({ token: TOKEN });
    // Accepting is not a sign-in: no session route is called.
    expect(api.calls.some((c) => c.path.includes('-auth/'))).toBe(false);
  });

  it('decline', async () => {
    routeFetch({
      'POST /trusted-contact/invitation/view': json(200, pending),
      'POST /trusted-contact/invitation/decline': json(200, { ...pending, status: 'DECLINED' }),
    });
    renderWithClient(<TrustedContactInvitation token={TOKEN} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Decline' }));
    expect(await screen.findByRole('heading', { name: 'You’ve declined the invitation' })).toBeInTheDocument();
  });

  it.each([
    ['ACCEPTED', 'You’ve accepted the invitation'],
    ['DECLINED', 'You’ve declined the invitation'],
    ['EXPIRED', 'This invitation has expired'],
    ['CANCELLED', 'This invitation is no longer valid'],
  ])('an already %s invitation offers no buttons', async (status, heading) => {
    routeFetch({ 'POST /trusted-contact/invitation/view': json(200, { status, accountHolder: null }) });
    renderWithClient(<TrustedContactInvitation token={TOKEN} />);
    expect(await screen.findByRole('heading', { name: heading })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept invitation' })).not.toBeInTheDocument();
  });

  it('an unknown or missing token is an invalid link, without calling the API for a missing one', async () => {
    routeFetch({ 'POST /trusted-contact/invitation/view': json(404, { statusCode: 404, message: 'This invitation link is invalid.' }) });
    const { unmount } = renderWithClient(<TrustedContactInvitation token={TOKEN} />);
    expect(await screen.findByRole('heading', { name: 'This invitation link isn’t valid' })).toBeInTheDocument();
    unmount();
    const api = routeFetch({});
    renderWithClient(<TrustedContactInvitation />);
    expect(screen.getByRole('heading', { name: 'This invitation link isn’t valid' })).toBeInTheDocument();
    expect(api.calls).toHaveLength(0);
  });
});

describe('Customer safety banner (Step 15)', () => {
  const status = (s: CaseStatus | null, canConfirmAlive: boolean, safeguardEndsAt: string | null = null) =>
    json(200, { status: s, safeguardEndsAt, canConfirmAlive });

  it.each([
    [null, false],
    ['VERIFIED', false],
    ['REJECTED', false],
    ['CANCELLED', false],
  ] as const)('is hidden when the case is %s', async (s, can) => {
    const api = routeFetch({ 'GET /death-verification/me': status(s, can) });
    renderWithClient(<SafetyBanner />);
    await waitFor(() => expect(api.calls).toHaveLength(1));
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });

  it.each(['PENDING_VERIFICATION', 'SAFEGUARD_ACTIVE', 'READY_FOR_REVIEW'] as const)('shows while %s', async (s) => {
    routeFetch({ 'GET /death-verification/me': status(s, true, s === 'SAFEGUARD_ACTIVE' ? '2030-10-14T02:00:00Z' : null) });
    renderWithClient(<SafetyBanner />);
    expect(await screen.findByRole('heading', { name: 'We’ve received a report about your account'.replace('’', "'") })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'I’m still alive'.replace('’', "'") })).toBeInTheDocument();
    expect(screen.queryByText(/If we don't hear from you by/) !== null).toBe(s === 'SAFEGUARD_ACTIVE');
  });

  it('confirm-alive needs an explicit confirmation, then the banner goes', async () => {
    const api = routeFetch({
      'GET /death-verification/me': status('SAFEGUARD_ACTIVE', true),
      'POST /death-verification/me/confirm-alive': status('CANCELLED', false),
    });
    renderWithClient(<SafetyBanner />);
    await userEvent.click(await screen.findByRole('button', { name: "I'm still alive" }));
    const dialog = await screen.findByRole('dialog', { name: "Confirm that you're still alive?" });
    expect(api.called('POST', '/death-verification/me/confirm-alive')).toHaveLength(0);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Yes, close the report' }));
    await waitFor(() => expect(screen.queryByRole('region')).not.toBeInTheDocument());
    expect(api.called('POST', '/death-verification/me/confirm-alive')[0].body).toEqual({ confirmAlive: true });
  });

  it('shows the 409 when the case was already decided', async () => {
    routeFetch({
      'GET /death-verification/me': status('READY_FOR_REVIEW', true),
      'POST /death-verification/me/confirm-alive': json(409, { statusCode: 409, message: 'This death verification case is already closed.' }),
    });
    renderWithClient(<SafetyBanner />);
    await userEvent.click(await screen.findByRole('button', { name: "I'm still alive" }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Yes, close the report' }));
    expect(await screen.findByText('This death verification case is already closed.')).toBeInTheDocument();
  });

  it('a PASSED account (401) ends the Customer session', async () => {
    routeFetch({ 'GET /death-verification/me': json(401, { statusCode: 401 }) });
    const { queryClient } = renderWithClient(<SafetyBanner />);
    queryClient.setQueryData(queryKeys.me, { id: 'customer' });
    await waitFor(() => expect(queryClient.getQueryData(queryKeys.me)).toBeNull());
  });
});
