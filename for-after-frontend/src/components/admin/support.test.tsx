import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AdminSupportRequest } from '@/lib/api/admin';
import { json, renderWithClient, routeFetch, router } from '@/test/utils';
import { AdminSupportDetail, AdminSupportList } from './support';

vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/admin/support' }));
const toast = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast }));

const ID = '7d6f1d8e-3c55-4a3a-9f1e-2b9a8f0e4c11';
const OWNER = '11111111-1111-4111-8111-111111111111';
const ADMIN = '22222222-2222-4222-8222-222222222222';
const T = '2026-10-31T02:00:00.000Z';
const detail = (over: Partial<AdminSupportRequest> = {}): AdminSupportRequest => ({
  id: ID,
  subject: 'Cannot add a photo',
  category: 'UPLOADS_STORAGE',
  status: 'OPEN',
  createdAt: T,
  lastPublicActivityAt: T,
  ownerUserId: OWNER,
  description: 'The upload spins forever.',
  updatedAt: T,
  messages: [],
  internalNotes: [{ id: 'n1', authorUserId: ADMIN, body: 'Checked the scanner.', createdAt: T }],
  ...over,
});

describe('Admin support', () => {
  it('inbox: requests with status, category and account; filter ids checked before the URL', async () => {
    routeFetch({
      'GET /admin/support/requests': json(200, {
        items: [{ id: ID, subject: 'Cannot add a photo', category: 'UPLOADS_STORAGE', status: 'WAITING_FOR_CUSTOMER', createdAt: T, lastPublicActivityAt: T, ownerUserId: OWNER }],
        pagination: { page: 1, limit: 25, total: 1, pages: 1 },
      }),
    });
    renderWithClient(<AdminSupportList filters={{ page: 1 }} />);
    const table = await screen.findByRole('table', { name: 'Support requests' });
    expect(within(table).getByRole('link', { name: 'Cannot add a photo' })).toHaveAttribute('href', `/admin/support/${ID}`);
    expect(within(table).getByText('Waiting for customer')).toBeInTheDocument();
    expect(within(table).getByText('Uploads and storage')).toBeInTheDocument();
    router.replace.mockClear();
    await userEvent.type(screen.getByLabelText('Account ID'), 'lisa@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Apply filters' }));
    expect(await screen.findByText('Enter a full account ID.')).toBeInTheDocument();
    expect(router.replace).not.toHaveBeenCalled();
    // No bulk, assignment or export controls.
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Apply filters']);
  });

  it('workspace: public thread with role labels only (no admin ids), compact times, notes apart', async () => {
    routeFetch({
      [`GET /admin/support/requests/${ID}`]: json(
        200,
        detail({
          messages: [
            { id: 'm1', authorRole: 'ADMIN', authorUserId: ADMIN, body: 'Line one\nLine two', createdAt: T },
            { id: 'm2', authorRole: 'CUSTOMER', authorUserId: OWNER, body: 'x'.repeat(300), createdAt: T },
          ],
        }),
      ),
    });
    renderWithClient(<AdminSupportDetail id={ID} />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Cannot add a photo' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'All support requests' })).toHaveAttribute('href', '/admin/support');
    const conversation = screen.getByRole('heading', { name: 'Conversation' }).closest('section')!;
    expect(within(conversation).getByText('Visible to the customer')).toBeInTheDocument();
    expect(within(conversation).getAllByText('Customer')).toHaveLength(2); // description + follow-up
    expect(within(conversation).getByText('For After support')).toBeInTheDocument();
    expect(
      within(conversation).getByText((_, el) => el?.tagName === 'P' && el.textContent === 'Line one\nLine two'),
    ).toHaveClass('whitespace-pre-wrap');
    // Never an admin id or the note text in the public thread.
    expect(conversation.textContent).not.toContain(ADMIN.slice(0, 8));
    expect(within(conversation).queryByText('Checked the scanner.')).not.toBeInTheDocument();
    // The reply box lives inside the conversation panel.
    expect(within(conversation).getByLabelText('Reply to customer')).toHaveAttribute('placeholder', 'Write a helpful reply…');
    expect(within(conversation).getByText('The customer can see this reply.')).toBeInTheDocument();
    const notes = screen.getByRole('heading', { name: 'Internal notes' }).closest('section')!;
    expect(within(notes).getByText('Administrators only')).toBeInTheDocument();
    expect(within(notes).getByText('Never shown to the customer.')).toBeInTheDocument();
    expect(within(notes).getByText('Checked the scanner.')).toBeInTheDocument();
    expect(notes.textContent).not.toContain(ADMIN.slice(0, 8));
    // Details: shortened ids, full values one disclosure away, the correct public-activity field.
    const details = screen.getByRole('heading', { name: 'Request details' }).closest('section')!;
    expect(within(details).getByText(ID)).toBeInTheDocument();
    expect(within(details).getByText(OWNER)).toBeInTheDocument();
    expect(within(details).getByRole('link', { name: /View account/ })).toHaveAttribute('href', `/admin/users/${OWNER}`);
    expect(within(details).getByText(/Times shown in/)).toBeInTheDocument();
    // Initial load never focuses the reply box.
    expect(document.activeElement).not.toBe(within(conversation).getByLabelText('Reply to customer'));
  });

  it('internal note: collapsed until asked; hiding keeps the draft; saving goes to /notes only', async () => {
    const { called } = routeFetch({
      [`GET /admin/support/requests/${ID}`]: json(200, detail({ internalNotes: [] })),
      [`POST /admin/support/requests/${ID}/notes`]: json(201, detail()),
    });
    renderWithClient(<AdminSupportDetail id={ID} />);
    await screen.findByText('No internal notes yet.');
    const box = screen.getByLabelText('Internal note');
    expect(box).not.toBeVisible();
    const toggle = screen.getByRole('button', { name: 'Add internal note' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(toggle);
    expect(box).toBeVisible();
    await waitFor(() => expect(box).toHaveFocus());
    await userEvent.type(box, 'Asked engineering.');
    await userEvent.click(screen.getByRole('button', { name: 'Hide note box' }));
    expect(box).not.toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Add internal note' }));
    expect(box).toHaveValue('Asked engineering.'); // the draft survived collapsing
    await userEvent.click(screen.getByRole('button', { name: 'Save internal note' }));
    await waitFor(() => expect(called('POST', `/admin/support/requests/${ID}/notes`)).toHaveLength(1));
    expect(called('POST', `/admin/support/requests/${ID}/replies`)).toHaveLength(0);
    expect(Object.keys(called('POST', `/admin/support/requests/${ID}/notes`)[0]!.body as object).sort()).toEqual(['body', 'clientRequestId']);
  });

  it('reply goes to /replies only; a failed reply keeps its text; status conflict is reported, not shown as saved', async () => {
    let n = 0;
    const { called } = routeFetch({
      [`GET /admin/support/requests/${ID}`]: json(200, detail()),
      [`POST /admin/support/requests/${ID}/replies`]: () => (n++ === 0 ? json(503, { message: 'x' }) : json(201, detail())),
      [`PATCH /admin/support/requests/${ID}/status`]: json(409, { message: 'This request’s status was changed by someone else. Reload it and try again.' }),
    });
    renderWithClient(<AdminSupportDetail id={ID} />);
    const reply = await screen.findByLabelText('Reply to customer');
    await userEvent.type(reply, 'On it.');
    await userEvent.click(screen.getByRole('button', { name: 'Send reply' }));
    expect(await screen.findByText(/Something went wrong on our side/)).toBeInTheDocument();
    expect(reply).toHaveValue('On it.');
    const ids = () => called('POST', `/admin/support/requests/${ID}/replies`).map((c) => (c.body as { clientRequestId: string }).clientRequestId);
    await userEvent.click(screen.getByRole('button', { name: 'Send reply' }));
    await waitFor(() => expect(reply).toHaveValue(''));
    expect(ids()[0]).toBe(ids()[1]); // the retry is the same submission
    expect(called('POST', `/admin/support/requests/${ID}/notes`)).toHaveLength(0);

    const status = screen.getByRole('heading', { name: 'Request status' }).closest('section')!;
    const select = within(status).getByLabelText('Change to');
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['In progress', 'Waiting for customer', 'Resolved']);
    await userEvent.selectOptions(select, 'RESOLVED');
    // Choosing does not submit, and the badge still shows the saved status.
    expect(called('PATCH', `/admin/support/requests/${ID}/status`)).toHaveLength(0);
    expect(within(status).getByText('Open')).toBeInTheDocument();
    await userEvent.click(within(status).getByRole('button', { name: 'Update status' }));
    expect(await within(status).findByText(/changed by someone else/)).toBeInTheDocument();
    expect(called('PATCH', `/admin/support/requests/${ID}/status`)[0]!.body).toEqual({ status: 'RESOLVED', expectedStatus: 'OPEN' });
    expect(within(status).queryByText('Resolved', { selector: 'span' })).not.toBeInTheDocument();
  });

  it('copy: full value only on request; a clipboard failure is said honestly', async () => {
    routeFetch({ [`GET /admin/support/requests/${ID}`]: json(200, detail()) });
    const writeText = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('denied'));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderWithClient(<AdminSupportDetail id={ID} />);
    const details = (await screen.findByRole('heading', { name: 'Request details' })).closest('section')!;
    expect(writeText).not.toHaveBeenCalled();
    const [copyRef, copyAccount] = within(details).getAllByRole('button', { name: 'Copy' });
    await userEvent.click(copyRef!);
    expect(writeText).toHaveBeenLastCalledWith(ID);
    await userEvent.click(copyAccount!);
    expect(writeText).toHaveBeenLastCalledWith(OWNER);
    await waitFor(() => expect(toast).toHaveBeenLastCalledWith("Couldn't copy. Select the text instead."));
  });

  it('resolved requests can only be reopened', async () => {
    routeFetch({ [`GET /admin/support/requests/${ID}`]: json(200, detail({ status: 'RESOLVED' })) });
    renderWithClient(<AdminSupportDetail id={ID} />);
    const select = await screen.findByLabelText('Change to');
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['Open']);
  });
});
