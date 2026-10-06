import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Message } from '@/lib/api/messages';
import { json, renderWithClient, routeFetch, router, page } from '@/test/utils';
import { MessageDetail } from './message-detail';
import { EditMessage, NewMessage } from './message-form';
import { MessageList } from './message-list';

vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/messages' }));

const person = (id: string, firstName: string) => ({
  id,
  firstName,
  lastName: null,
  relationship: 'Daughter',
  email: null,
  mobile: null,
  birthday: null,
  privateNote: null,
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
});

const message = (over: Partial<Message> = {}): Message => ({
  id: 'm1',
  title: 'For your 18th',
  contentType: 'TEXT',
  textContent: 'Dear Sofia,',
  status: 'DRAFT',
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-02T00:00:00Z',
  recipients: [{ id: 'r1', firstName: 'Sofia', lastName: null, relationship: 'Daughter' }],
  ...over,
});

const schedule = {
  id: 's1',
  triggerType: 'FIXED_DATE',
  scheduledFor: '2030-12-25T01:00:00.000Z',
  afterDeathDays: null,
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
};

const noSchedule = json(404, { statusCode: 404, message: 'Schedule not found.' });

describe('Messages', () => {
  it('groups messages by status with a calm summary', async () => {
    routeFetch({
      'GET /messages': json(200, [message(), message({ id: 'm2', title: 'Our song', status: 'SCHEDULED' })]),
    });
    renderWithClient(<MessageList />);
    const drafts = await screen.findByRole('region', { name: 'Drafts' });
    expect(within(drafts).getByRole('link', { name: /For your 18th/ })).toHaveTextContent('For Sofia');
    expect(within(screen.getByRole('region', { name: 'Scheduled' })).getByText('Our song')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Released' })).not.toBeInTheDocument();
  });

  it('creates a draft with the chosen type and people; VIDEO is not offered', async () => {
    const api = routeFetch({
      'GET /recipients': json(200, page([person('r1', 'Sofia'), person('r2', 'Tom')])),
      'POST /messages': json(201, message()),
    });
    renderWithClient(<NewMessage />);
    expect(await screen.findByRole('radio', { name: /Written/ })).toBeChecked();
    expect(screen.getAllByRole('radio').map((r) => (r as HTMLInputElement).value)).toEqual(['TEXT', 'PHOTO', 'AUDIO', 'MIXED']);

    await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(await screen.findByText('Choose at least one person.')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('checkbox', { name: /Tom/ }));
    await userEvent.click(screen.getByRole('radio', { name: /Mixed/ }));
    await userEvent.type(screen.getByLabelText('Title'), 'For your 18th');
    await userEvent.type(screen.getByLabelText(/^Message/), 'Dear Tom,');
    await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));

    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/messages/m1'));
    expect(api.called('POST', '/messages')[0].body).toEqual({
      title: 'For your 18th',
      contentType: 'MIXED',
      textContent: 'Dear Tom,',
      recipientIds: ['r2'],
    });
  });

  it('edits a draft with PATCH', async () => {
    const api = routeFetch({
      'GET /messages/m1': json(200, message()),
      'GET /recipients': json(200, page([person('r1', 'Sofia')])),
      'PATCH /messages/m1': json(200, message({ title: 'New title' })),
    });
    renderWithClient(<EditMessage id="m1" />);
    const title = await screen.findByLabelText('Title');
    await userEvent.clear(title);
    await userEvent.type(title, 'New title');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/messages/m1'));
    expect(api.called('PATCH', '/messages/m1')[0].body).toMatchObject({ title: 'New title', recipientIds: ['r1'] });
  });

  it('does not offer editing for a scheduled message: it explains unschedule-to-edit', async () => {
    const api = routeFetch({ 'GET /messages/m1': json(200, message({ status: 'SCHEDULED' })), 'GET /recipients': json(200, page([])) });
    renderWithClient(<EditMessage id="m1" />);
    expect(await screen.findByText('This message is scheduled')).toBeInTheDocument();
    expect(screen.getByText(/unschedule it first: it goes back to being a draft, and nothing in it is deleted/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument();
    expect(api.calls.some((c) => c.method !== 'GET')).toBe(false);
  });

  it('shows released messages read-only', async () => {
    routeFetch({
      'GET /messages/m1': json(200, message({ status: 'RELEASED' })),
      'GET /messages/m1/media': json(200, []),
      'GET /messages/m1/schedule': json(200, schedule),
    });
    renderWithClient(<MessageDetail id="m1" />);
    expect(await screen.findByText(/This message has been released/)).toBeInTheDocument();
    expect(screen.getByText('Can no longer be changed')).toBeInTheDocument();
    for (const name of ['Edit', 'Delete draft', 'Schedule message', 'Unschedule to edit']) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name })).not.toBeInTheDocument();
    }
  });

  it('unschedules only after confirming, then refreshes the message', async () => {
    let status: Message['status'] = 'SCHEDULED';
    const api = routeFetch({
      'GET /messages/m1': () => json(200, message({ status })),
      'GET /messages/m1/media': json(200, []),
      'GET /messages/m1/schedule': () => (status === 'SCHEDULED' ? json(200, schedule) : noSchedule),
      'DELETE /messages/m1/schedule': () => {
        status = 'DRAFT';
        return new Response(null, { status: 204 });
      },
    });
    renderWithClient(<MessageDetail id="m1" />);
    expect(await screen.findByText('Locked while scheduled')).toBeInTheDocument();
    await userEvent.click(await screen.findByRole('button', { name: 'Unschedule to edit' }));
    const dialog = await screen.findByRole('dialog', { name: 'Unschedule this message?' });
    expect(dialog).toHaveTextContent('Nothing in the message is deleted.');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Unschedule' }));
    expect(await screen.findByRole('link', { name: 'Edit' })).toHaveAttribute('href', '/messages/m1/edit');
    expect(api.called('DELETE', '/messages/m1/schedule')).toHaveLength(1);
  });
});

describe('Scheduling a draft', () => {
  const draft = (over: Partial<Message> = {}) => ({
    'GET /messages/m1': json(200, message(over)),
    'GET /messages/m1/media': json(200, []),
  });

  it('sends FIXED_DATE with an explicit timezone offset for the chosen local time', async () => {
    const api = routeFetch({ ...draft(), 'POST /messages/m1/schedule': json(201, schedule) });
    renderWithClient(<MessageDetail id="m1" />);
    expect(await screen.findByText('Ready to schedule.')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Date'), '2030-12-25');
    await userEvent.clear(screen.getByLabelText('Time'));
    await userEvent.type(screen.getByLabelText('Time'), '09:30');
    await userEvent.click(screen.getByRole('button', { name: 'Schedule message' }));
    await waitFor(() => expect(api.called('POST', '/messages/m1/schedule')).toHaveLength(1));
    const body = api.called('POST', '/messages/m1/schedule')[0].body as { scheduledFor: string };
    expect(body).toMatchObject({ triggerType: 'FIXED_DATE', afterDeathDays: null });
    expect(body.scheduledFor).toMatch(/^2030-12-25T09:30:00[+-]\d{2}:\d{2}$/);
    expect(new Date(body.scheduledFor).getTime()).toBe(new Date(2030, 11, 25, 9, 30).getTime());
  });

  it('rejects a date in the past before calling the API', async () => {
    const api = routeFetch(draft());
    renderWithClient(<MessageDetail id="m1" />);
    await userEvent.type(await screen.findByLabelText('Date'), '2020-01-01');
    await userEvent.click(screen.getByRole('button', { name: 'Schedule message' }));
    expect(await screen.findByText('Choose a date and time in the future.')).toBeInTheDocument();
    expect(api.called('POST', '/messages/m1/schedule')).toHaveLength(0);
  });

  it('sends ON_DEATH with no date and explains that only verification releases', async () => {
    const api = routeFetch({ ...draft(), 'POST /messages/m1/schedule': json(201, { ...schedule, triggerType: 'ON_DEATH', scheduledFor: null }) });
    renderWithClient(<MessageDetail id="m1" />);
    await userEvent.click(await screen.findByRole('radio', { name: /After my passing/ }));
    expect(screen.queryByLabelText('Date')).not.toBeInTheDocument();
    expect(screen.getByText(/A report from a trusted contact is never enough on its own/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Schedule message' }));
    await waitFor(() =>
      expect(api.called('POST', '/messages/m1/schedule')[0]?.body).toEqual({
        triggerType: 'ON_DEATH',
        scheduledFor: null,
        afterDeathDays: null,
      }),
    );
  });

  it('sends AFTER_DEATH with a whole number of days', async () => {
    const api = routeFetch({ ...draft(), 'POST /messages/m1/schedule': json(201, { ...schedule, triggerType: 'AFTER_DEATH' }) });
    renderWithClient(<MessageDetail id="m1" />);
    await userEvent.click(await screen.findByRole('radio', { name: /Some time after my passing/ }));
    const days = screen.getByLabelText('How long after?');
    await userEvent.clear(days);
    await userEvent.type(days, '1.5');
    await userEvent.click(screen.getByRole('button', { name: 'Schedule message' }));
    expect(await screen.findByText(/Enter a whole number of days/)).toBeInTheDocument();
    await userEvent.clear(days);
    await userEvent.type(days, '365');
    await userEvent.click(screen.getByRole('button', { name: 'Schedule message' }));
    await waitFor(() =>
      expect(api.called('POST', '/messages/m1/schedule')[0]?.body).toEqual({
        triggerType: 'AFTER_DEATH',
        scheduledFor: null,
        afterDeathDays: 365,
      }),
    );
  });

  it('shows readiness guidance and the backend 409 composition message', async () => {
    routeFetch({
      ...draft({ contentType: 'PHOTO', textContent: null }),
      'POST /messages/m1/schedule': json(409, { statusCode: 409, message: 'PHOTO messages require at least one ready photo.' }),
    });
    renderWithClient(<MessageDetail id="m1" />);
    expect(await screen.findByText('Add at least one photo.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('radio', { name: /After my passing/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Schedule message' }));
    expect(await screen.findByText('PHOTO messages require at least one ready photo.')).toBeInTheDocument();
  });
});

describe('Creating a draft, then going to scheduling', () => {
  const people = { 'GET /recipients': json(200, page([person('r1', 'Sofia')])) };

  async function fillTextDraft() {
    await userEvent.click(await screen.findByRole('checkbox', { name: /Sofia/ }));
    await userEvent.type(screen.getByLabelText('Title'), 'For your 18th');
    await userEvent.type(screen.getByLabelText(/^Message/), 'Dear Sofia,');
  }

  it('Save draft creates once and opens the draft as before', async () => {
    const api = routeFetch({ ...people, 'POST /messages': json(201, message()) });
    renderWithClient(<NewMessage />);
    await fillTextDraft();
    await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/messages/m1'));
    expect(api.called('POST', '/messages')).toHaveLength(1);
  });

  it('Continue to schedule creates once and opens the returned message at its schedule panel', async () => {
    const api = routeFetch({ ...people, 'POST /messages': json(201, message({ id: 'm9' })) });
    renderWithClient(<NewMessage />);
    await fillTextDraft();
    await userEvent.click(screen.getByRole('button', { name: /Continue to schedule/ }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/messages/m9?focus=schedule'));
    expect(api.called('POST', '/messages')).toHaveLength(1);
    expect(api.called('POST', '/messages/m9/schedule')).toHaveLength(0); // never schedules from here
    // Both actions stay disabled through navigation.
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Saving/ })).toBeDisabled();
  });

  it('on API failure stays put, keeps what was written and shows the error', async () => {
    const api = routeFetch({ ...people, 'POST /messages': json(400, { statusCode: 400, message: 'Title is too long.' }) });
    renderWithClient(<NewMessage />);
    await fillTextDraft();
    await userEvent.click(screen.getByRole('button', { name: /Continue to schedule/ }));
    expect(await screen.findByText('Title is too long.')).toBeInTheDocument();
    expect(router.push).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Title')).toHaveValue('For your 18th');
    expect(screen.getByLabelText(/^Message/)).toHaveValue('Dear Sofia,');
    // Released for a retry.
    expect(screen.getByRole('button', { name: /Continue to schedule/ })).toBeEnabled();
    expect(api.called('POST', '/messages')).toHaveLength(1);
  });

  it('a double click creates only one message', async () => {
    const api = routeFetch({ ...people, 'POST /messages': json(201, message()) });
    renderWithClient(<NewMessage />);
    await fillTextDraft();
    // Two clicks back to back, without waiting between them.
    const go = screen.getByRole('button', { name: /Continue to schedule/ });
    fireEvent.click(go);
    fireEvent.click(go);
    await waitFor(() => expect(router.push).toHaveBeenCalledTimes(1));
    expect(api.called('POST', '/messages')).toHaveLength(1);
  });

  it('an incomplete PHOTO draft is still created and opened at scheduling', async () => {
    const api = routeFetch({ ...people, 'POST /messages': json(201, message({ contentType: 'PHOTO', textContent: null })) });
    renderWithClient(<NewMessage />);
    await userEvent.click(await screen.findByRole('checkbox', { name: /Sofia/ }));
    await userEvent.click(screen.getByRole('radio', { name: /^Photos/ }));
    await userEvent.type(screen.getByLabelText('Title'), 'Our photos');
    await userEvent.click(screen.getByRole('button', { name: /Continue to schedule/ }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/messages/m1?focus=schedule'));
    expect(api.called('POST', '/messages')[0].body).toMatchObject({ contentType: 'PHOTO', textContent: null });
  });

  it('the detail page focuses the schedule panel once, showing the real readiness blocker', async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    window.history.replaceState(null, '', '/messages/m1?focus=schedule');
    routeFetch({
      'GET /messages/m1': json(200, message({ contentType: 'PHOTO', textContent: null })),
      'GET /messages/m1/media': json(200, []),
    });
    renderWithClient(<MessageDetail id="m1" />);
    const panel = await screen.findByRole('region', { name: 'When will it be shared?' });
    expect(panel).toHaveAttribute('id', 'message-schedule');
    await waitFor(() => expect(panel).toHaveFocus());
    expect(scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ block: 'start' }));
    expect(window.location.search).toBe(''); // read once: refresh/Back won't jump again
    expect(await screen.findByText('Add at least one photo.')).toBeInTheDocument();
    window.history.replaceState(null, '', '/');
  });

  it('the detail page does not move focus without the param', async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    routeFetch({ 'GET /messages/m1': json(200, message()), 'GET /messages/m1/media': json(200, []) });
    renderWithClient(<MessageDetail id="m1" />);
    expect(await screen.findByText('Ready to schedule.')).toBeInTheDocument();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});
