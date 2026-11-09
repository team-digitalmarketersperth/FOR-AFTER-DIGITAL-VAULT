import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Message, Schedule } from '@/lib/api/messages';
import { json, page, renderWithClient, routeFetch, router } from '@/test/utils';
import { MessageDetail } from './message-detail';

vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/messages' }));

// Phase 16: NOW, BIRTHDAY, ANNIVERSARY, CUSTOM_EVENT, ANNUAL_AFTER_DEATH.
const message = (over: Partial<Message> = {}): Message => ({
  id: 'm1',
  title: 'For your birthday',
  contentType: 'TEXT',
  textContent: 'Dear Sofia,',
  privateNote: null,
  status: 'DRAFT',
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-02T00:00:00Z',
  recipients: [
    { id: 'r1', firstName: 'Sofia', lastName: null, relationship: 'Daughter' },
    { id: 'r2', firstName: 'Tom', lastName: 'Lee', relationship: 'Son' },
  ],
  version: 1,
  ...over,
});
const person = (id: string, firstName: string, birthday: string | null) => ({
  id,
  firstName,
  lastName: firstName === 'Tom' ? 'Lee' : null,
  relationship: null,
  email: null,
  mobile: null,
  birthday,
  privateNote: null,
  photoId: null,
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
});
const schedule = (over: Partial<Schedule> = {}): Schedule => ({
  id: 's1',
  triggerType: 'BIRTHDAY',
  scheduledFor: null,
  afterDeathDays: null,
  timezone: 'Australia/Perth',
  localTime: '09:00',
  annualMonth: null,
  annualDay: null,
  eventDate: null,
  eventLabel: null,
  releasedRecipientCount: 0,
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
  ...over,
});

const draft = (birthdays: [string | null, string | null] = ['1990-03-10', '2001-07-24']) => ({
  'GET /messages/m1': json(200, message()),
  'GET /messages/m1/media': json(200, []),
  'GET /recipients': json(200, page([person('r1', 'Sofia', birthdays[0]), person('r2', 'Tom', birthdays[1])])),
  'POST /messages/m1/schedule': json(201, schedule()),
});
const posted = (api: ReturnType<typeof routeFetch>) => api.called('POST', '/messages/m1/schedule')[0]?.body;
const submit = () => userEvent.click(screen.getByRole('button', { name: 'Schedule message' }));
const pick = async (name: RegExp) => userEvent.click(await screen.findByRole('radio', { name }));

describe('Schedule picker: Phase 16 triggers', () => {
  it('offers every approved option', async () => {
    routeFetch(draft());
    renderWithClient(<MessageDetail id="m1" />);
    for (const name of [
      /Right away/,
      /On a date you choose/,
      /On their birthday, every year/,
      /Every year on a date/,
      /On a special occasion/,
      /^After my passing/,
      /Some time after my passing/,
      /Every year after my passing/,
    ]) {
      expect(await screen.findByRole('radio', { name })).toBeInTheDocument();
    }
  });

  it('NOW sends no date or extra fields', async () => {
    const api = routeFetch(draft());
    renderWithClient(<MessageDetail id="m1" />);
    await pick(/Right away/);
    expect(screen.getByText(/as soon as it’s scheduled/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Date')).not.toBeInTheDocument();
    await submit();
    await waitFor(() =>
      expect(posted(api)).toEqual({ triggerType: 'NOW', scheduledFor: null, afterDeathDays: null }),
    );
  });

  it('BIRTHDAY sends a local time and an IANA zone (the browser zone by default)', async () => {
    const api = routeFetch(draft());
    renderWithClient(<MessageDetail id="m1" />);
    await pick(/On their birthday/);
    expect(screen.getByText(/different recipients may receive it on different days/)).toBeInTheDocument();
    expect(screen.getByText(/shared on 28 February in other years/)).toBeInTheDocument();
    const zone = screen.getByLabelText('Time zone') as HTMLSelectElement;
    expect(zone.value).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    await userEvent.selectOptions(zone, 'Asia/Tokyo');
    const time = screen.getByLabelText('Time');
    await userEvent.clear(time);
    await userEvent.type(time, '07:30');
    await submit();
    await waitFor(() =>
      expect(posted(api)).toEqual({
        triggerType: 'BIRTHDAY',
        scheduledFor: null,
        afterDeathDays: null,
        timezone: 'Asia/Tokyo',
        localTime: '07:30',
      }),
    );
  });

  it('BIRTHDAY names recipients without a birthday and shows the server refusal', async () => {
    routeFetch({
      ...draft(['1990-03-10', null]),
      'POST /messages/m1/schedule': json(409, {
        statusCode: 409,
        message: 'Every recipient needs a birthday for a birthday release.',
      }),
    });
    renderWithClient(<MessageDetail id="m1" />);
    await pick(/On their birthday/);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Tom Lee doesn’t have a birthday saved yet.',
    );
    await submit();
    expect(await screen.findByText(/needs a birthday for a birthday release/)).toBeInTheDocument();
  });

  it('ANNIVERSARY: month + day (29 Feb allowed, 30 Feb refused) + time + zone', async () => {
    const api = routeFetch(draft());
    renderWithClient(<MessageDetail id="m1" />);
    await pick(/Every year on a date/);
    await userEvent.selectOptions(screen.getByLabelText('Month'), '2');
    await userEvent.selectOptions(screen.getByLabelText('Day'), '30');
    await submit();
    expect(await screen.findByText('Choose a day that exists in that month.')).toBeInTheDocument();
    expect(posted(api)).toBeUndefined();
    await userEvent.selectOptions(screen.getByLabelText('Day'), '29');
    await userEvent.selectOptions(screen.getByLabelText('Time zone'), 'America/New_York');
    await submit();
    await waitFor(() =>
      expect(posted(api)).toEqual({
        triggerType: 'ANNIVERSARY',
        scheduledFor: null,
        afterDeathDays: null,
        timezone: 'America/New_York',
        localTime: '09:00',
        annualMonth: 2,
        annualDay: 29,
      }),
    );
  });

  it('CUSTOM_EVENT: one-time, named, dated; markup and past dates refused', async () => {
    const api = routeFetch(draft());
    renderWithClient(<MessageDetail id="m1" />);
    await pick(/On a special occasion/);
    expect(screen.getByText('Shared once, on this day. It doesn’t repeat.')).toBeInTheDocument();
    await submit();
    expect(await screen.findByText('Give the occasion a name.')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('What’s the occasion?'), '<b>Wedding</b>');
    await userEvent.type(screen.getByLabelText('Date'), '2020-01-01');
    await submit();
    expect(await screen.findByText('Please leave out < and >.')).toBeInTheDocument();
    expect(screen.getByText('Choose a date in the future.')).toBeInTheDocument();
    expect(posted(api)).toBeUndefined();

    const label = screen.getByLabelText('What’s the occasion?');
    await userEvent.clear(label);
    await userEvent.type(label, '  Mia’s graduation ');
    const date = screen.getByLabelText('Date');
    await userEvent.clear(date);
    await userEvent.type(date, '2031-06-01');
    await userEvent.selectOptions(screen.getByLabelText('Time zone'), 'Australia/Sydney');
    await submit();
    await waitFor(() =>
      expect(posted(api)).toEqual({
        triggerType: 'CUSTOM_EVENT',
        scheduledFor: null,
        afterDeathDays: null,
        timezone: 'Australia/Sydney',
        localTime: '09:00',
        eventDate: '2031-06-01',
        eventLabel: 'Mia’s graduation',
      }),
    );
  });

  it('ANNUAL_AFTER_DEATH explains that only a verified death starts it', async () => {
    const api = routeFetch(draft());
    renderWithClient(<MessageDetail id="m1" />);
    await pick(/Every year after my passing/);
    expect(screen.getByText(/Nothing is shared until your passing has been formally verified/)).toBeInTheDocument();
    expect(screen.getByText(/A report from a trusted contact is never enough on its own/)).toBeInTheDocument();
    await submit();
    await waitFor(() =>
      expect(posted(api)).toMatchObject({
        triggerType: 'ANNUAL_AFTER_DEATH',
        scheduledFor: null,
        afterDeathDays: null,
        localTime: '09:00',
      }),
    );
  });
});

describe('Scheduled repeating messages', () => {
  const scheduled = (s: Schedule) => ({
    'GET /messages/m1': json(200, message({ status: 'SCHEDULED' })),
    'GET /messages/m1/media': json(200, []),
    'GET /messages/m1/schedule': json(200, s),
    'GET /recipients': json(200, page([person('r1', 'Sofia', '1990-03-10'), person('r2', 'Tom', '2001-07-24')])),
  });

  it('before anyone has received it: still Scheduled, timing can change (prefilled)', async () => {
    routeFetch(scheduled(schedule({ triggerType: 'ANNIVERSARY', annualMonth: 2, annualDay: 29, localTime: '18:30' })));
    renderWithClient(<MessageDetail id="m1" />);
    expect(
      await screen.findByText('Every year on 29 February at 6:30 pm (Australia/Perth time)'),
    ).toBeInTheDocument();
    expect(screen.getByText(/Repeats every year/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Unschedule to edit' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Change timing' }));
    expect(screen.getByRole('radio', { name: /Every year on a date/ })).toBeChecked();
    expect((screen.getByLabelText('Day') as HTMLSelectElement).value).toBe('29');
    expect((screen.getByLabelText('Time') as HTMLInputElement).value).toBe('18:30');
  });

  it('a stored zone alias the browser lists under another name stays selected', async () => {
    routeFetch(scheduled(schedule({ timezone: 'Asia/Kolkata' })));
    renderWithClient(<MessageDetail id="m1" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Change timing' }));
    expect((screen.getByLabelText('Time zone') as HTMLSelectElement).value).toBe('Asia/Kolkata');
  });

  it('after one recipient received it: never "Released", no change or unschedule', async () => {
    routeFetch(scheduled(schedule({ releasedRecipientCount: 1 })));
    renderWithClient(<MessageDetail id="m1" />);
    expect(await screen.findByText(/Every year on each recipient’s birthday at 9:00 am/)).toBeInTheDocument();
    expect(screen.getByText(/Shared with 1 of 2 recipients so far/)).toBeInTheDocument();
    expect(screen.queryByText('Released')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Change timing' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Unschedule to edit' })).not.toBeInTheDocument();
  });

  it('describes a custom event with its name, calendar date and zone', async () => {
    routeFetch(
      scheduled(
        schedule({
          triggerType: 'CUSTOM_EVENT',
          eventDate: '2031-06-01T00:00:00.000Z',
          eventLabel: 'Mia’s graduation',
          scheduledFor: '2031-05-31T23:00:00.000Z',
          timezone: 'Australia/Sydney',
        }),
      ),
    );
    renderWithClient(<MessageDetail id="m1" />);
    expect(
      await screen.findByText('Mia’s graduation: 1 June 2031 at 9:00 am (Australia/Sydney time)'),
    ).toBeInTheDocument();
  });
});
