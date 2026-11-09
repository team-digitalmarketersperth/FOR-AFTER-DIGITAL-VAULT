import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SafetyBanner } from '@/components/layout/safety-banner';
import { CASE_STATUSES, type CaseStatus } from '@/lib/api/portals';
import { REPORTER_STATUS } from '@/lib/death-verification';
import { portalKeys, queryKeys } from '@/lib/query/query-client';
import { FAKE_PROVIDER_FILE_ID, fakeStorage, json, renderWithClient, routeFetch, router } from '@/test/utils';
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

describe('Recipient SMS sign-in (Twilio Verify via the API)', () => {
  const SMS_MSG = 'If released content is available for this mobile number, a verification code has been sent.';

  async function requestSmsCode(number = '0412 345 678') {
    await userEvent.click(screen.getByRole('button', { name: 'Mobile' }));
    await userEvent.type(screen.getByLabelText('Mobile number'), number);
    await userEvent.click(screen.getByRole('button', { name: 'Text me a code' }));
  }

  it('email stays the default; Mobile shows a country code, number field and SMS consent', async () => {
    routeFetch({});
    renderWithClient(<RecipientSignIn />);
    expect(screen.getByRole('button', { name: 'Email' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Mobile' }));
    expect(screen.getByRole('button', { name: 'Mobile' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('Country code')).toHaveValue('+61');
    expect(screen.getByLabelText('Mobile number')).toHaveAttribute('type', 'tel');
    expect(screen.getByText(/agree to receive a verification code by SMS/)).toBeInTheDocument();
    expect(screen.getByText(/We’ll text you a 6-digit code/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();
  });

  it('validates the number before calling the API', async () => {
    const api = routeFetch({});
    renderWithClient(<RecipientSignIn />);
    await userEvent.click(screen.getByRole('button', { name: 'Mobile' }));
    await userEvent.click(screen.getByRole('button', { name: 'Text me a code' }));
    expect(await screen.findByText('Enter your mobile number.')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Mobile number'), '12ab');
    await userEvent.click(screen.getByRole('button', { name: 'Text me a code' }));
    expect(await screen.findByText('Enter a valid mobile number.')).toBeInTheDocument();
    expect(screen.getByLabelText('Mobile number')).toHaveAttribute('aria-invalid', 'true');
    expect(api.called('POST', '/recipient-auth/request-sms-otp')).toHaveLength(0);
  });

  it('sends E.164, shows the generic message and only a masked number', async () => {
    const api = routeFetch({ 'POST /recipient-auth/request-sms-otp': json(202, { message: SMS_MSG }) });
    renderWithClient(<RecipientSignIn />);
    await requestSmsCode('0412 345 678');
    expect(await screen.findByText(SMS_MSG)).toBeInTheDocument();
    expect(screen.getByText('Check your phone')).toBeInTheDocument();
    expect(screen.getByText('+61 ••• ••• 678')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/412\s?345/);
    expect(api.called('POST', '/recipient-auth/request-sms-otp')[0]).toMatchObject({
      body: { mobile: '+61412345678' },
      credentials: 'include',
    });
    const code = screen.getByLabelText('6-digit code');
    expect(code).toHaveAttribute('autocomplete', 'one-time-code');
    expect(code).toHaveAttribute('inputmode', 'numeric');
  });

  it('a number typed with its own +country code wins over the selector', async () => {
    const api = routeFetch({ 'POST /recipient-auth/request-sms-otp': json(202, { message: SMS_MSG }) });
    renderWithClient(<RecipientSignIn />);
    await requestSmsCode('+91 98765 43210');
    await screen.findByText(SMS_MSG);
    expect(api.called('POST', '/recipient-auth/request-sms-otp')[0].body).toEqual({ mobile: '+919876543210' });
    expect(screen.getByText('+91 ••• ••• 210')).toBeInTheDocument();
  });

  it('a pasted code signs in to the same place as email sign-in', async () => {
    const api = routeFetch({
      'POST /recipient-auth/request-sms-otp': json(202, { message: SMS_MSG }),
      'POST /recipient-auth/verify-sms-otp': json(200, { authenticated: true, mobile: '+61******678' }),
    });
    renderWithClient(<RecipientSignIn />);
    await requestSmsCode();
    await userEvent.click(await screen.findByLabelText('6-digit code'));
    await userEvent.paste('123-456');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/recipient/messages'));
    expect(api.called('POST', '/recipient-auth/verify-sms-otp')[0].body).toEqual({
      mobile: '+61412345678',
      code: '123456',
    });
  });

  it('an invalid code shows the safe message and clears the field', async () => {
    routeFetch({
      'POST /recipient-auth/request-sms-otp': json(202, { message: SMS_MSG }),
      'POST /recipient-auth/verify-sms-otp': json(401, INVALID),
    });
    renderWithClient(<RecipientSignIn />);
    await requestSmsCode();
    await userEvent.type(await screen.findByLabelText('6-digit code'), '000000');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText(INVALID.message)).toBeInTheDocument();
    expect(screen.getByLabelText('6-digit code')).toHaveValue('');
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('asks for 6 digits from the text message', async () => {
    routeFetch({ 'POST /recipient-auth/request-sms-otp': json(202, { message: SMS_MSG }) });
    renderWithClient(<RecipientSignIn />);
    await requestSmsCode();
    await userEvent.type(await screen.findByLabelText('6-digit code'), '12');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(screen.getByText('Enter the 6 digits from the text message.')).toBeInTheDocument();
  });

  it('resend waits for the countdown, then reuses the request route', async () => {
    const api = routeFetch({ 'POST /recipient-auth/request-sms-otp': json(202, { message: SMS_MSG }) });
    renderWithClient(<RecipientSignIn />);
    await requestSmsCode();
    expect(await screen.findByText(/You can ask for a new code in \d+s/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resend code' })).not.toBeInTheDocument();
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 31_000);
    await userEvent.click(await screen.findByRole('button', { name: 'Resend code' }, { timeout: 2000 }));
    clock.mockRestore();
    await waitFor(() => expect(api.called('POST', '/recipient-auth/request-sms-otp')).toHaveLength(2));
    expect(api.called('POST', '/recipient-auth/request-sms-otp')[1].body).toEqual({ mobile: '+61412345678' });
  });

  it('"Use a different mobile number" goes back to the mobile form', async () => {
    routeFetch({ 'POST /recipient-auth/request-sms-otp': json(202, { message: SMS_MSG }) });
    renderWithClient(<RecipientSignIn />);
    await requestSmsCode();
    await userEvent.click(await screen.findByRole('button', { name: 'Use a different mobile number' }));
    expect(screen.getByLabelText('Mobile number')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Mobile' })).toHaveAttribute('aria-pressed', 'true');
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
  const msg = (id: string, title: string, contentType: string, releasedAt: string) => ({ id, title, contentType, releasedAt, hasMedia: contentType !== 'TEXT' });

  it('a space shared with you: real count, newest featured with its type art, earlier ones as rows', async () => {
    routeFetch({
      'GET /recipient/messages': json(200, [
        msg('m3', 'Happy birthday', 'PHOTO', '2026-10-14T00:00:00Z'),
        msg('m2', 'A letter for you', 'TEXT', '2026-10-10T00:00:00Z'),
        msg('m1', 'Your song', 'AUDIO', '2026-09-01T00:00:00Z'),
      ]),
    });
    const { container } = renderWithClient(<ReleasedMessageList />);
    expect(screen.getByRole('heading', { level: 1, name: 'A space shared with you' })).toBeInTheDocument();
    expect(await screen.findByText('3 messages shared with you')).toBeInTheDocument();
    const featured = screen.getByRole('article');
    expect(within(featured).getByRole('heading', { name: 'Happy birthday' })).toBeInTheDocument();
    expect(within(featured).getByText('Photo message')).toBeInTheDocument();
    expect(within(featured).getByText(/Shared 14 October 2026/)).toBeInTheDocument();
    expect(within(featured).getByRole('link', { name: 'Open message: Happy birthday' })).toHaveAttribute('href', '/recipient/messages/m3');
    expect(container.querySelector('[data-art="PHOTO"]')).toHaveAttribute('aria-hidden', 'true');
    const rows = within(screen.getByRole('region', { name: 'Earlier messages' })).getAllByRole('listitem');
    expect(rows.map((r) => within(r).getByRole('heading').textContent)).toEqual(['A letter for you', 'Your song']);
    expect(within(rows[0]).getByText('Written message')).toBeInTheDocument();
    expect(within(rows[1]).getByText('Voice message')).toBeInTheDocument();
    expect(within(rows[1]).getByRole('link', { name: 'Open message: Your song' })).toHaveAttribute('href', '/recipient/messages/m1');
  });

  it.each([
    ['TEXT', 'Written message'],
    ['VIDEO', 'Video message'],
    ['MIXED', 'Words, photos and sound'],
  ])('one %s message: featured alone, no empty "earlier" section', async (type, label) => {
    routeFetch({ 'GET /recipient/messages': json(200, [msg('m1', 'For Sofia', type, '2026-09-01T00:00:00Z')]) });
    const { container } = renderWithClient(<ReleasedMessageList />);
    expect(await screen.findByText('1 message shared with you')).toBeInTheDocument();
    expect(screen.getByText(label)).toBeInTheDocument();
    expect(container.querySelector(`[data-art="${type}"]`)).not.toBeNull();
    expect(screen.queryByRole('region', { name: 'Earlier messages' })).not.toBeInTheDocument();
  });

  it('nothing released yet: a calm empty state that hints at nothing pending', async () => {
    routeFetch({ 'GET /recipient/messages': json(200, []) });
    renderWithClient(<ReleasedMessageList />);
    expect(await screen.findByText('Nothing has been shared with you yet.')).toBeInTheDocument();
    expect(screen.getByText('When something is ready for you, it will appear here.')).toBeInTheDocument();
    expect(screen.queryByText(/messages? shared with you$/)).not.toBeInTheDocument();
  });

  it('a failed list says so without backend details, and can retry', async () => {
    const api = routeFetch({ 'GET /recipient/messages': json(500, { statusCode: 500, message: 'PrismaClientKnownRequestError at grant' }) });
    renderWithClient(<ReleasedMessageList />);
    expect(await screen.findByText("We couldn't load your messages right now.")).toBeInTheDocument();
    expect(screen.queryByText(/Prisma/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Try again/ }));
    await waitFor(() => expect(api.called('GET', '/recipient/messages').length).toBeGreaterThan(1));
  });

  it('says who it is from in the letter header: the snapshotted display name only', async () => {
    const long = 'Lisa Margaretha Bridgett-Vanderhoeven-Kalimuthu';
    routeFetch({
      'GET /recipient/messages/m1': json(200, { ...released, hasMedia: false, textContent: 'Dear Sofia', senderDisplayName: long }),
    });
    renderWithClient(<ReleasedMessageView id="m1" />);
    const name = await screen.findByText(long);
    expect(name.closest('p')).toHaveTextContent(`From ${long}`);
    expect(name.closest('header')).not.toBeNull();
    // Serif, quiet, and wraps on a phone instead of overflowing.
    expect(name).toHaveClass('font-heading', 'break-words');
    expect(screen.queryByText('Shared with you')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/@|ownerUserId|account/i);
  });

  it('the list adds a quiet "From" line; an older message without a name shows none', async () => {
    routeFetch({
      'GET /recipient/messages': json(200, [
        { ...msg('m2', 'Newest', 'TEXT', '2026-10-14T00:00:00Z'), senderDisplayName: 'Lisa Bridgett' },
        { ...msg('m1', 'Older', 'TEXT', '2026-01-01T00:00:00Z'), senderDisplayName: null },
      ]),
    });
    renderWithClient(<ReleasedMessageList />);
    expect(await screen.findByText('From Lisa Bridgett')).toBeInTheDocument();
    expect(screen.getAllByText(/^From /)).toHaveLength(1);
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
    // A letter: title, the release date and a way back; nothing about scheduling, versions or notes.
    expect(screen.getByRole('heading', { level: 1, name: 'For Sofia' })).toBeInTheDocument();
    expect(screen.getByText('1 September 2026')).toHaveAttribute('dateTime');
    expect(screen.getByText('Shared with you')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to messages' })).toHaveAttribute('href', '/recipient/messages');
    expect(screen.getByText('Preserved privately for you.')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/private note|version|schedul|draft/i);
    expect(text.textContent).toBe('Dear Sofia,\n\n<b>Love</b>, Mum'); // not parsed as HTML
    expect(text).toHaveClass('whitespace-pre-wrap');
    expect(await screen.findByRole('img', { name: 'Photo shared with you' })).toHaveAttribute('src', 'https://storage.test/photo');
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
    expect(await screen.findByRole('img', { name: 'Photo shared with you' })).toHaveAttribute('src', 'https://storage.test/fresh');
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

  describe('SMS sign-in (mobile-only contacts, Twilio Verify via the API)', () => {
    const TC_SMS_MSG = 'If this mobile number is registered as a trusted contact, a verification code has been sent.';
    const requestTcSms = async (number = '98765 43210') => {
      await userEvent.click(screen.getByRole('button', { name: 'Mobile' }));
      await userEvent.selectOptions(screen.getByLabelText('Country code'), '+91');
      await userEvent.type(screen.getByLabelText('Mobile number'), number);
      await userEvent.click(screen.getByRole('button', { name: 'Text me a code' }));
    };

    it('email stays the default; Mobile explains the private SMS code and consent', async () => {
      routeFetch({});
      renderWithClient(<TrustedContactSignIn />);
      expect(screen.getByRole('button', { name: 'Email' })).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByLabelText('Email')).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Mobile' }));
      expect(screen.getByText(/send a private 6-digit verification code by SMS/)).toBeInTheDocument();
      expect(screen.getByText(/agree to receive a verification code by SMS/)).toBeInTheDocument();
      expect(screen.getByLabelText('Mobile number')).toHaveAttribute('type', 'tel');
    });

    it('editorial tabs, not a segmented control: no filled container; active marked by an underline', async () => {
      routeFetch({});
      renderWithClient(<TrustedContactSignIn />);
      const group = screen.getByRole('group', { name: 'Sign in with' });
      expect(group.className).not.toMatch(/(^|\s)(bg-|shadow|rounded)/);
      await userEvent.click(within(group).getByRole('button', { name: 'Mobile' }));
      const active = within(group).getByRole('button', { name: 'Mobile' });
      expect(active).toHaveAttribute('aria-pressed', 'true');
      expect(active.className).toMatch(/after:scale-x-100/);
      // No fill or shadow; only the ::after underline is coloured.
      expect(active.className).not.toMatch(/(^|\s)(bg-|shadow)/);
      expect(within(group).getByRole('button', { name: 'Email' }).className).toMatch(/after:scale-x-0/);
    });

    it('sends E.164 to the Trusted Contact route, shows only a masked number, then signs in', async () => {
      const api = routeFetch({
        'POST /trusted-contact-auth/request-sms-otp': json(202, { message: TC_SMS_MSG }),
        'POST /trusted-contact-auth/verify-sms-otp': json(200, { authenticated: true, mobile: '+91******210' }),
      });
      renderWithClient(<TrustedContactSignIn />);
      await requestTcSms();
      expect(await screen.findByText(TC_SMS_MSG)).toBeInTheDocument();
      expect(screen.getByText('+91 ••• ••• 210')).toBeInTheDocument();
      expect(document.body.textContent).not.toMatch(/98765\s?43210/);
      expect(api.called('POST', '/trusted-contact-auth/request-sms-otp')[0].body).toEqual({ mobile: '+919876543210' });
      // Never the Recipient routes.
      expect(api.calls.some((c) => c.path.startsWith('/recipient-auth'))).toBe(false);
      await userEvent.click(screen.getByLabelText('6-digit code'));
      await userEvent.paste('864 213');
      await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
      await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/trusted-contact/accounts'));
      expect(api.called('POST', '/trusted-contact-auth/verify-sms-otp')[0].body).toEqual({
        mobile: '+919876543210',
        code: '864213',
      });
    });

    it('a wrong code shows the safe message, clears the field and signs nobody in', async () => {
      routeFetch({
        'POST /trusted-contact-auth/request-sms-otp': json(202, { message: TC_SMS_MSG }),
        'POST /trusted-contact-auth/verify-sms-otp': json(401, INVALID),
      });
      renderWithClient(<TrustedContactSignIn />);
      await requestTcSms();
      await userEvent.type(await screen.findByLabelText('6-digit code'), '000000');
      await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
      expect(await screen.findByText(INVALID.message)).toBeInTheDocument();
      expect(screen.getByLabelText('6-digit code')).toHaveValue('');
      expect(router.replace).not.toHaveBeenCalled();
    });

    it('"Use a different mobile number" goes back to the mobile form', async () => {
      routeFetch({ 'POST /trusted-contact-auth/request-sms-otp': json(202, { message: TC_SMS_MSG }) });
      renderWithClient(<TrustedContactSignIn />);
      await requestTcSms();
      await userEvent.click(await screen.findByRole('button', { name: 'Use a different mobile number' }));
      expect(screen.getByLabelText('Mobile number')).toHaveValue('');
    });
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

// ─── Phase 19A: supporting evidence ─────────────────────────────────────────

describe('Trusted Contact supporting evidence (Phase 19A)', () => {
  const BASE = '/trusted-contact/accounts/t1/death-verification/evidence';
  const READY = { id: 'e1', mimeType: 'application/pdf', sizeBytes: 1_887_437, status: 'READY', uploadedAt: '2026-10-12T00:00:00Z' };
  const status = (over: object = {}) => ({
    status: 'SAFEGUARD_ACTIVE',
    reportedByYou: true,
    openedAt: '2026-10-10T00:00:00Z',
    canReport: false,
    canUploadEvidence: true,
    ...over,
  });
  const pdf = (name = 'certificate.pdf', size = 2048, type = 'application/pdf') =>
    new File([new Uint8Array(size)], name, { type });
  const routes = (over: Record<string, Response | ((body: unknown) => Response)> = {}) => {
    let list: object[] = [];
    return routeFetch({
      'GET /trusted-contact/accounts': json(200, [account({ deathVerificationStatus: 'SAFEGUARD_ACTIVE' })]),
      'GET /trusted-contact/accounts/t1/death-verification': json(200, status()),
      [`GET ${BASE}`]: () => json(200, list),
      [`POST ${BASE}/upload-url`]: json(201, {
        mediaAssetId: 'e2',
        upload: { url: 'https://upload.test/files', fields: { token: 'signed' } },
        expiresAt: '2026-10-13T00:10:00Z',
      }),
      [`POST ${BASE}/e2/complete`]: () => {
        list = [{ ...READY, id: 'e2', sizeBytes: 2048 }];
        return json(200, list[0]);
      },
      ...over,
    });
  };

  it('appears for the reporter of an open case, says plainly that it verifies and releases nothing', async () => {
    routes();
    renderWithClient(<AccountStatus id="t1" />);
    expect(await screen.findByRole('heading', { name: 'Documents for the review' })).toBeInTheDocument();
    expect(screen.getByText(/Adding evidence doesn't verify the account or release any messages/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upload evidence' })).toBeEnabled();
    // The picker offers the approved formats only (the server stays authoritative).
    const accept = screen.getByTestId('evidence-file').getAttribute('accept') ?? '';
    expect(accept).toContain('application/pdf');
    expect(accept).not.toMatch(/svg|zip|word|html/);
  });

  it('is absent for a contact who has not reported', async () => {
    routes({
      'GET /trusted-contact/accounts/t1/death-verification': json(
        200,
        status({ reportedByYou: false, canUploadEvidence: false, canReport: true }),
      ),
    });
    renderWithClient(<AccountStatus id="t1" />);
    expect(await screen.findByRole('link', { name: 'Submit a death report' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Documents for the review' })).not.toBeInTheDocument();
  });

  it('a closed case keeps the list but offers no upload', async () => {
    routes({
      'GET /trusted-contact/accounts/t1/death-verification': json(
        200,
        status({ status: 'CANCELLED', canUploadEvidence: false, canReport: true }),
      ),
      [`GET ${BASE}`]: json(200, [READY]),
    });
    renderWithClient(<AccountStatus id="t1" />);
    expect(await screen.findByText('This case is closed, so no more evidence can be added.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Upload evidence' })).not.toBeInTheDocument();
    expect(await screen.findByText(/PDF · 1\.8 MB/)).toBeInTheDocument();
  });

  it('uploads: progress, checking, then "ready for review" (never "verified")', async () => {
    const puts = fakeStorage();
    const api = routes();
    renderWithClient(<AccountStatus id="t1" />);
    await screen.findByRole('button', { name: 'Upload evidence' });
    await userEvent.upload(screen.getByTestId('evidence-file'), pdf());
    expect(await screen.findByText("Evidence uploaded. It's ready for review.")).toBeInTheDocument();
    expect(api.called('POST', `${BASE}/upload-url`)[0].body).toEqual({
      originalFileName: 'certificate.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 2048,
    });
    expect(api.called('POST', `${BASE}/e2/complete`)[0].body).toEqual({ providerFileId: FAKE_PROVIDER_FILE_ID });
    expect(puts).toHaveLength(1);
    expect(await screen.findByText(/PDF · 2 KB/)).toBeInTheDocument();
    expect(screen.queryByText(/verified|confirmed/i)).not.toBeInTheDocument();
  });

  it('shows the uploading and checking states while in flight', async () => {
    fakeStorage();
    let finish!: (r: Response) => void;
    const pending = new Promise<Response>((r) => (finish = r));
    routes({ [`POST ${BASE}/e2/complete`]: () => pending as unknown as Response });
    renderWithClient(<AccountStatus id="t1" />);
    await screen.findByRole('button', { name: 'Upload evidence' });
    await userEvent.upload(screen.getByTestId('evidence-file'), pdf());
    expect(await screen.findByText('Checking the upload…')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Uploading certificate.pdf' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upload evidence' })).toBeDisabled();
    finish(json(200, { ...READY, id: 'e2' }));
    expect(await screen.findByText("Evidence uploaded. It's ready for review.")).toBeInTheDocument();
  });

  it.each([
    [
      'an unsupported type',
      pdf('notes.docx', 100, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
      'Please choose a PDF, JPEG or PNG file.',
    ],
    ['an oversized file', pdf('big.pdf', 20 * 1024 * 1024 + 1), 'This file is larger than 20 MB.'],
  ])('refuses %s before contacting the server', async (_, file, message) => {
    const api = routes();
    renderWithClient(<AccountStatus id="t1" />);
    await screen.findByRole('button', { name: 'Upload evidence' });
    // fireEvent bypasses the picker's accept filter, as a determined user could.
    fireEvent.change(screen.getByTestId('evidence-file'), { target: { files: [file] } });
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(api.called('POST', `${BASE}/upload-url`)).toHaveLength(0);
  });

  it('shows the server’s refusal (e.g. failed checks) as a failed upload', async () => {
    fakeStorage();
    routes({
      [`POST ${BASE}/e2/complete`]: json(400, { statusCode: 400, message: 'The file does not match its declared type.' }),
    });
    renderWithClient(<AccountStatus id="t1" />);
    await screen.findByRole('button', { name: 'Upload evidence' });
    await userEvent.upload(screen.getByTestId('evidence-file'), pdf());
    expect(await screen.findByRole('alert')).toHaveTextContent('Upload failed: The file does not match its declared type.');
  });

  it('the reporter can re-view their own file through a short-lived URL fetched on click', async () => {
    const tab = { opener: {}, location: { href: '' }, close: vi.fn() };
    vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    const api = routes({
      [`GET ${BASE}`]: json(200, [READY]),
      [`GET ${BASE}/e1/access-url`]: json(200, { url: 'https://media.test/signed', expiresAt: '2026-10-13T00:05:00Z' }),
    });
    renderWithClient(<AccountStatus id="t1" />);
    await userEvent.click(await screen.findByRole('button', { name: 'View' }));
    await waitFor(() => expect(tab.location.href).toBe('https://media.test/signed'));
    expect(tab.opener).toBeNull();
    expect(api.called('GET', `${BASE}/e1/access-url`)).toHaveLength(1);
  });

  // Phase 19B: the second contact confirms with their own report, through the
  // existing action; no count, progress or other reporter is ever shown.
  it('an unreported contact on an open case gets the existing report action and no confirmation details', async () => {
    routes({
      'GET /trusted-contact/accounts/t1/death-verification': json(
        200,
        status({ status: 'READY_FOR_REVIEW', reportedByYou: false, canReport: true, canUploadEvidence: false }),
      ),
    });
    renderWithClient(<AccountStatus id="t1" />);
    expect(await screen.findByRole('link', { name: 'Submit a death report' })).toHaveAttribute(
      'href',
      '/trusted-contact/accounts/t1/report',
    );
    expect(screen.queryByText(/\d of \d|confirmation|another contact|other contact|reported by/i)).not.toBeInTheDocument();
  });

  it('the upload button is disabled at the file limit', async () => {
    routes({ [`GET ${BASE}`]: json(200, [1, 2, 3, 4, 5].map((i) => ({ ...READY, id: `e${i}` }))) });
    renderWithClient(<AccountStatus id="t1" />);
    expect(await screen.findByText("You've added the maximum of 5 files.")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upload evidence' })).toBeDisabled();
  });
});
