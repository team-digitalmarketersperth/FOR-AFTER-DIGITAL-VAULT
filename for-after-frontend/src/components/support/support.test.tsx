import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupportRequest } from '@/lib/api/support';
import { queryKeys, resetPrivateCache } from '@/lib/query/query-client';
import { json, renderWithClient, routeFetch, router } from '@/test/utils';
import { NewSupportRequest, SupportDetail, SupportList } from './support';

vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/support' }));
const toast = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast }));

const ID = '7d6f1d8e-3c55-4a3a-9f1e-2b9a8f0e4c11';
const T = '2026-10-31T02:00:00.000Z';
const request = (over: Partial<SupportRequest> = {}): SupportRequest => ({
  id: ID,
  subject: 'Cannot add a photo',
  category: 'UPLOADS_STORAGE',
  status: 'OPEN',
  createdAt: T,
  lastPublicActivityAt: T,
  description: 'The upload spins forever.',
  messages: [{ id: 'm1', authorRole: 'ADMIN', body: 'We are looking into it.', createdAt: T }],
  ...over,
});

beforeEach(() => router.push.mockClear());

describe('Customer support', () => {
  it('new request: inline validation, then success only after the API confirmed it', async () => {
    const { called } = routeFetch({ 'POST /support/requests': json(201, request()) });
    renderWithClient(<NewSupportRequest />);
    expect(screen.getByText(/without including passwords, verification codes/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Send request' }));
    expect(screen.getByText(/Enter a subject/)).toBeInTheDocument();
    expect(screen.getByText('Choose a category.')).toBeInTheDocument();
    expect(called('POST', '/support/requests')).toHaveLength(0);

    await userEvent.type(screen.getByLabelText('Subject'), 'Cannot add a photo');
    await userEvent.selectOptions(screen.getByLabelText('Category'), 'UPLOADS_STORAGE');
    await userEvent.type(screen.getByLabelText('Description'), 'The upload spins forever.');
    await userEvent.click(screen.getByRole('button', { name: 'Send request' }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith(`/support/${ID}`));
    const [sent] = called('POST', '/support/requests');
    // Only what the person typed; owner, status and diagnostics never come from the browser.
    expect(Object.keys(sent!.body as object).sort()).toEqual(['category', 'clientRequestId', 'description', 'subject']);
  });

  it('a failed send keeps the text; the retry reuses the same submission id (no duplicate)', async () => {
    let n = 0;
    const { called } = routeFetch({
      'POST /support/requests': () => (n++ === 0 ? json(500, { message: 'Something went wrong.' }) : json(201, request())),
    });
    renderWithClient(<NewSupportRequest />);
    await userEvent.type(screen.getByLabelText('Subject'), 'Cannot add a photo');
    await userEvent.selectOptions(screen.getByLabelText('Category'), 'TECHNICAL');
    await userEvent.type(screen.getByLabelText('Description'), 'The upload spins forever.');
    await userEvent.click(screen.getByRole('button', { name: 'Send request' }));
    expect(await screen.findByText('Your request wasn’t sent')).toBeInTheDocument();
    expect(screen.getByLabelText('Description')).toHaveValue('The upload spins forever.');
    expect(router.push).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Send request' }));
    await waitFor(() => expect(router.push).toHaveBeenCalled());
    const ids = called('POST', '/support/requests').map((c) => (c.body as { clientRequestId: string }).clientRequestId);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
  });

  it('list: one link per card; subject, friendly status, category and public dates; real count; nothing invented', async () => {
    const created = '2026-10-29T02:00:00.000Z';
    routeFetch({
      'GET /support/requests': json(200, {
        items: [{ ...request(), createdAt: created, status: 'WAITING_FOR_CUSTOMER' }],
        pagination: { page: 1, limit: 25, total: 1, pages: 1 },
      }),
    });
    renderWithClient(<SupportList page={1} />);
    expect(screen.getByRole('heading', { level: 1, name: 'A little help, when you need it.' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'New request' })).toHaveAttribute('href', '/support/new');
    const card = (await screen.findByRole('link', { name: 'Cannot add a photo' })).closest('li')!;
    const list = card.closest('ul')!;
    // The subject is the card's only link (stretched), so nothing interactive nests.
    expect(within(card).getAllByRole('link')).toHaveLength(1);
    expect(within(card).getByRole('link', { name: 'Cannot add a photo' })).toHaveAttribute('href', `/support/${ID}`);
    expect(within(card).getByText('Waiting for you')).toBeInTheDocument();
    expect(within(card).getByText('Uploads and storage')).toBeInTheDocument();
    // Sent = created; Updated = last public activity (never an internal note).
    expect(card).toHaveTextContent('Sent 29 Oct 2026 · Updated 31 Oct 2026');
    expect(within(card).getByText('29 Oct 2026')).toHaveAttribute('datetime', created);
    expect(screen.getByRole('heading', { name: /Your requests/ })).toHaveTextContent('(1)');
    // No fabricated unread, reply counts, excerpts or internal data.
    expect(card.textContent).not.toMatch(/unread|new reply|\d+ repl|internal|note|looking into/i);
    // Guidance: supplementary, after the list, no promises.
    const guidance = screen.getByRole('complementary', { name: 'How can we help?' });
    expect(guidance).toHaveTextContent('Please don’t include passwords or verification codes.');
    expect(guidance.textContent).not.toMatch(/24\/7|within|email you|attach/i);
    expect(list.compareDocumentPosition(guidance) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('empty, loading and failure: a failed load is an error with Try again, never "no requests"', async () => {
    routeFetch({ 'GET /support/requests': json(200, { items: [], pagination: { page: 1, limit: 25, total: 0, pages: 0 } }) });
    const { unmount } = renderWithClient(<SupportList page={1} />);
    expect(screen.getByRole('status')).toHaveTextContent(/Loading your support requests/);
    expect(await screen.findByText('We’re here to help.')).toBeInTheDocument();
    expect(screen.getByText('Create a request whenever you need a hand.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Create a request' })).toHaveAttribute('href', '/support/new');
    unmount();
    let n = 0;
    routeFetch({
      'GET /support/requests': () =>
        n++ === 0 ? json(500, { message: 'x' }) : json(200, { items: [request()], pagination: { page: 1, limit: 25, total: 1, pages: 1 } }),
    });
    renderWithClient(<SupportList page={1} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn't load this/i);
    expect(screen.queryByText('We’re here to help.')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('link', { name: 'Cannot add a photo' })).toBeInTheDocument();
  });

  it('detail: header, connected public thread ("You" / "For After support"), details card, guidance; follow-up kept on failure', async () => {
    let n = 0;
    routeFetch({
      [`GET /support/requests/${ID}`]: json(200, request()),
      [`POST /support/requests/${ID}/messages`]: () =>
        n++ === 0
          ? json(503, { message: 'Service unavailable.' })
          : json(201, request({ messages: [...request().messages, { id: 'm2', authorRole: 'CUSTOMER', body: 'Still spinning.', createdAt: T }] })),
    });
    renderWithClient(<SupportDetail id={ID} />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Cannot add a photo' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'All support requests' })).toHaveAttribute('href', '/support');
    expect(screen.getByText('Your conversation with the For After team.')).toBeInTheDocument();
    const conversation = screen.getByRole('heading', { name: 'Conversation' }).closest('section')!;
    expect(within(conversation).getByText(/Only you and the For After support team can see this request/)).toBeInTheDocument();
    // The description opens the thread as "You"; replies are "For After support"; no admin identity.
    expect(within(conversation).getAllByText('You')).toHaveLength(1);
    expect(within(conversation).getByText('The upload spins forever.')).toBeInTheDocument();
    expect(within(conversation).getByText('For After support')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/internal|note|admin/i);
    // Details: status as text, the public-activity time under its real name, a short reference.
    const details = screen.getByRole('heading', { name: 'Request details' }).closest('section')!;
    expect(within(details).getByText('Open')).toBeInTheDocument();
    expect(within(details).getByText('Last public activity')).toBeInTheDocument();
    expect(within(details).queryByText('Last reply')).not.toBeInTheDocument();
    expect(within(details).getByText(ID)).toBeInTheDocument(); // full value inside the disclosure
    expect(within(details).getByText(/Times shown in/)).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'A little help, when you need it.' })).toHaveTextContent(
      'Your requests and replies stay together here, so you can return whenever you need.',
    );
    expect(document.body.textContent).not.toMatch(/24\/7|within \d|response time/i);

    const box = screen.getByLabelText('Add a follow-up');
    await userEvent.type(box, 'Still spinning.');
    await userEvent.click(screen.getByRole('button', { name: 'Send follow-up' }));
    expect(await screen.findByText(/Something went wrong on our side/)).toBeInTheDocument();
    expect(box).toHaveValue('Still spinning.');
    await userEvent.click(screen.getByRole('button', { name: 'Send follow-up' }));
    await waitFor(() => expect(box).toHaveValue(''));
    expect(within(conversation).getByText('Still spinning.')).toBeInTheDocument();
  });

  it('resolved (from the stored status only): readable, no follow-up box, banner points to the existing new-request form', async () => {
    routeFetch({ [`GET /support/requests/${ID}`]: json(200, request({ status: 'RESOLVED' })) });
    renderWithClient(<SupportDetail id={ID} />);
    expect(await screen.findByRole('heading', { name: 'This request is resolved' })).toBeInTheDocument();
    expect(screen.getByText(/You can still read this conversation\. For another question, create a new request\./)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Create a new request' })).toHaveAttribute('href', '/support/new');
    expect(screen.queryByLabelText('Add a follow-up')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /reopen/i })).not.toBeInTheDocument();
  });

  it('an open request with a support reply is not shown as resolved', async () => {
    routeFetch({ [`GET /support/requests/${ID}`]: json(200, request({ status: 'IN_PROGRESS' })) });
    renderWithClient(<SupportDetail id={ID} />);
    expect(await screen.findByLabelText('Add a follow-up')).toBeInTheDocument();
    expect(screen.queryByText('This request is resolved')).not.toBeInTheDocument();
  });

  it('copy: the full reference only on click; a clipboard failure is said honestly', async () => {
    routeFetch({ [`GET /support/requests/${ID}`]: json(200, request()) });
    const writeText = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('denied'));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderWithClient(<SupportDetail id={ID} />);
    const copy = await screen.findByRole('button', { name: 'Copy' });
    expect(writeText).not.toHaveBeenCalled();
    await userEvent.click(copy);
    expect(writeText).toHaveBeenLastCalledWith(ID);
    await waitFor(() => expect(toast).toHaveBeenLastCalledWith('Copied'));
    await userEvent.click(copy);
    await waitFor(() => expect(toast).toHaveBeenLastCalledWith("Couldn't copy. Select the text instead."));
  });

  it('not found and failures are never shown as an empty or resolved request', async () => {
    routeFetch({ [`GET /support/requests/${ID}`]: json(404, { message: 'Support request not found.' }) });
    const { unmount } = renderWithClient(<SupportDetail id={ID} />);
    expect(await screen.findByText('We couldn’t find this support request')).toBeInTheDocument();
    unmount();
    routeFetch({ [`GET /support/requests/${ID}`]: json(500, { message: 'x' }) });
    renderWithClient(<SupportDetail id={ID} />);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText('This request is resolved')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Conversation' })).not.toBeInTheDocument();
  });

  it('sign-out or account change drops cached support requests', async () => {
    const { queryClient } = renderWithClient(<div />);
    queryClient.setQueryData(queryKeys.supportRequest(ID), request());
    queryClient.setQueryData(queryKeys.supportPage(1), { items: [] });
    await resetPrivateCache(queryClient, null);
    expect(queryClient.getQueryData(queryKeys.supportRequest(ID))).toBeUndefined();
    expect(queryClient.getQueryData(queryKeys.supportPage(1))).toBeUndefined();
  });
});
