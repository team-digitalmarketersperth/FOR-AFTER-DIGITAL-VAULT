import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { DeliveryTimeline, UpcomingDelivery } from '@/lib/api/delivery-timeline';
import { conditionalLabel, shortWhen, toRecipients, upcomingDetail, whenLabel } from '@/lib/delivery-timeline';
import { json, renderWithClient, routeFetch } from '@/test/utils';
import { ComingUp, DeliveryTimelinePage } from './delivery-timeline';

const T = '/users/me/delivery-timeline';
const R = '/users/me/readiness';
const up = (over: Partial<UpcomingDelivery>): UpcomingDelivery => ({
  key: over.key ?? Math.random().toString(36),
  messageId: 'm1',
  title: 'Christmas message',
  triggerType: 'FIXED_DATE',
  dueAt: '2027-12-23T22:00:00.000Z',
  timezone: null,
  eventLabel: null,
  recipients: ['Mum'],
  repeatsAnnually: false,
  ...over,
});
const plan = (over: Partial<DeliveryTimeline> = {}): DeliveryTimeline => ({
  upcoming: [
    up({ key: 'now', messageId: 'm0', title: 'Right away', triggerType: 'NOW', dueAt: null }),
    up({ key: 'xmas' }),
    up({ key: 'b1', messageId: 'm2', title: 'Birthday message', triggerType: 'BIRTHDAY', dueAt: '2028-03-14T01:00:00.000Z', timezone: 'Australia/Perth', recipients: ['Sarah'], repeatsAnnually: true }),
    up({ key: 'b2', messageId: 'm2', title: 'Birthday message', triggerType: 'BIRTHDAY', dueAt: '2028-06-22T01:00:00.000Z', timezone: 'Australia/Perth', recipients: ['James'], repeatsAnnually: true }),
  ],
  conditional: [
    { key: 'c1', messageId: 'm3', title: 'Letter to family', triggerType: 'ON_DEATH', afterDeathDays: null, recipients: ['Mum', 'Sarah', 'James', 'Emma'] },
    { key: 'c2', messageId: 'm4', title: 'Thirty days on', triggerType: 'AFTER_DEATH', afterDeathDays: 30, recipients: ['Sarah'] },
    { key: 'c3', messageId: 'm5', title: 'Annual remembrance', triggerType: 'ANNUAL_AFTER_DEATH', afterDeathDays: null, recipients: ['Mum'] },
  ],
  recent: [],
  ...over,
});
const readiness = (needsScheduling: number) => ({
  score: 0,
  completedSteps: 0,
  totalSteps: 5,
  steps: [{ key: 'SCHEDULING', complete: false, messages: 3, needsScheduling }],
});

describe('Delivery Timeline page', () => {
  it('dated deliveries in order, per-Recipient birthdays, and conditional ones without dates', async () => {
    routeFetch({ [`GET ${T}`]: json(200, plan()), [`GET ${R}`]: json(200, readiness(0)) });
    renderWithClient(<DeliveryTimelinePage />);
    expect(screen.getByRole('heading', { level: 1, name: 'Delivery Timeline' })).toBeInTheDocument();
    const coming = await screen.findByRole('region', { name: 'Coming up' });
    const rows = within(coming).getAllByRole('listitem');
    // en-AU writes June and July in full.
    expect(rows.map((r) => r.querySelector('p')!.textContent)).toEqual(['Now', '24 Dec 2027', '14 Mar 2028', '22 June 2028']);
    expect(rows[0]).toHaveTextContent('Right away to Mum');
    expect(rows[0]).toHaveTextContent('As soon as possible');
    // One row per Recipient for a birthday message, each with its own date.
    expect(rows[2]).toHaveTextContent('Birthday message to Sarah');
    expect(rows[3]).toHaveTextContent('Birthday message to James');
    expect(rows[2]).toHaveTextContent(/Birthday · 9:00 am .*repeats every year/);
    expect(within(rows[1]).getByRole('link', { name: /View message/ })).toHaveAttribute('href', '/messages/m1');

    const when = screen.getByRole('region', { name: 'When the time comes' });
    expect(within(when).getByText(/only after our team verifies a death/)).toBeInTheDocument();
    const cond = within(when).getAllByRole('listitem');
    expect(cond.map((r) => r.querySelector('p')!.textContent)).toEqual([
      'After my passing',
      '30 days after my passing',
      'Every year after my passing',
    ]);
    expect(cond[0]).toHaveTextContent('Letter to family to Mum, Sarah + 2 more');
    // No technical trigger codes or fake dates for conditional events.
    expect(document.body.textContent).not.toMatch(/ON_DEATH|AFTER_DEATH|FIXED_DATE|death event/);
    expect(within(when).queryByText(/\d{4}/)).toBeNull();
  });

  it('no plans: a calm empty state; drafts waiting for timing are counted from readiness', async () => {
    routeFetch({ [`GET ${T}`]: json(200, plan({ upcoming: [], conditional: [] })), [`GET ${R}`]: json(200, readiness(2)) });
    renderWithClient(<DeliveryTimelinePage />);
    expect(await screen.findByText('No delivery plans yet')).toBeInTheDocument();
    expect(await screen.findByText('2 messages still need timing')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Review messages' })[0]).toHaveAttribute('href', '/messages');
  });

  it('recently delivered is shown separately, never as upcoming', async () => {
    routeFetch({
      [`GET ${T}`]: json(200, plan({ upcoming: [], conditional: [], recent: [{ key: 'r', messageId: 'm9', title: 'Sent note', deliveredAt: '2026-10-10T02:00:00Z', recipients: ['Mum'] }] })),
      [`GET ${R}`]: json(200, readiness(0)),
    });
    renderWithClient(<DeliveryTimelinePage />);
    const recent = await screen.findByRole('region', { name: 'Recently delivered' });
    expect(recent).toHaveTextContent('Sent note to Mum');
    expect(screen.queryByRole('region', { name: 'Coming up' })).toBeNull();
  });

  it('loading: a timeline-shaped skeleton, not the empty state', () => {
    routeFetch({ [`GET ${T}`]: () => new Promise<Response>(() => undefined) as unknown as Response, [`GET ${R}`]: json(200, readiness(0)) });
    renderWithClient(<DeliveryTimelinePage />);
    expect(screen.getByLabelText('Loading your delivery timeline')).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByText('No delivery plans yet')).toBeNull();
  });

  it('error: unavailable, without blocking anything else', async () => {
    routeFetch({ [`GET ${T}`]: json(500, { statusCode: 500, message: 'x' }), [`GET ${R}`]: json(200, readiness(0)) });
    renderWithClient(<DeliveryTimelinePage />);
    expect(await screen.findByText('Your delivery timeline is unavailable right now.', {}, { timeout: 5000 })).toBeInTheDocument();
  });
});

describe('Coming up (dashboard)', () => {
  it('at most four: the next dated ones, with the first conditional keeping the last place', async () => {
    routeFetch({ [`GET ${T}`]: json(200, plan()) });
    renderWithClient(<ComingUp />);
    await screen.findByText('Right away');
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(4);
    expect(rows[2]).toHaveTextContent('Birthday message to Sarah');
    expect(rows[3]).toHaveTextContent('After my passingLetter to family');
    expect(screen.getByRole('link', { name: /View delivery timeline/ })).toHaveAttribute('href', '/messages/timeline');
  });

  it('shows the conditional one when there are few dated ones', async () => {
    routeFetch({ [`GET ${T}`]: json(200, plan({ upcoming: [up({ key: 'x' })] })) });
    renderWithClient(<ComingUp />);
    expect(await screen.findByText('After my passing')).toBeInTheDocument();
  });

  it('empty and error states are calm', async () => {
    routeFetch({ [`GET ${T}`]: json(200, plan({ upcoming: [], conditional: [] })) });
    renderWithClient(<ComingUp />);
    expect(await screen.findByText(/No delivery plans yet/)).toBeInTheDocument();
  });
});

describe('timeline labels', () => {
  const now = new Date('2026-10-13T03:00:00Z');
  it('dates in the schedule’s own zone, relative words for today and tomorrow', () => {
    // 23 Dec 22:00 UTC is already 24 Dec in Perth.
    expect(whenLabel({ dueAt: '2026-12-23T22:00:00Z', timezone: 'Australia/Perth' }, now)).toBe('24 Dec 2026');
    expect(whenLabel({ dueAt: '2026-10-13T10:00:00Z', timezone: 'Australia/Perth' }, now)).toBe('Today');
    expect(whenLabel({ dueAt: '2026-10-14T10:00:00Z', timezone: 'Australia/Perth' }, now)).toBe('Tomorrow');
    expect(whenLabel({ dueAt: null, timezone: null }, now)).toBe('Now');
    expect(shortWhen({ dueAt: '2026-12-23T22:00:00Z', timezone: 'Australia/Perth' }, now)).toBe('24 Dec');
    expect(shortWhen({ dueAt: '2027-03-14T01:00:00Z', timezone: 'Australia/Perth' }, now)).toBe('14 Mar 2027');
  });

  it('recipients and conditional wording', () => {
    expect(toRecipients([])).toBe('');
    expect(toRecipients(['Mum'])).toBe('to Mum');
    expect(toRecipients(['Mum', 'Sarah'])).toBe('to Mum and Sarah');
    expect(toRecipients(['Mum', 'Sarah', 'James'])).toBe('to Mum, Sarah + 1 more');
    expect(conditionalLabel({ triggerType: 'ON_DEATH', afterDeathDays: null })).toBe('After my passing');
    expect(conditionalLabel({ triggerType: 'AFTER_DEATH', afterDeathDays: 1 })).toBe('1 day after my passing');
    expect(conditionalLabel({ triggerType: 'ANNUAL_AFTER_DEATH', afterDeathDays: null })).toBe('Every year after my passing');
    expect(upcomingDetail(up({ triggerType: 'CUSTOM_EVENT', eventLabel: 'Graduation day', timezone: 'Asia/Kolkata', dueAt: '2027-09-05T04:30:00Z' }))).toMatch(
      /^Graduation day · 10:00 am Kolkata time$/,
    );
  });
});
