import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ActivityItem } from '@/lib/api/activity';
import { groupByDay, longDay, shortDay } from '@/lib/activity';
import { json, page, renderWithClient, routeFetch } from '@/test/utils';
import { ActivityHistory, RecentChanges } from './activity';

const at = (daysAgo: number, hour = 14) => {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, 42, 0, 0);
  return d.toISOString();
};
const item = (type: ActivityItem['type'], createdAt: string, target: string | null = null, id = type + createdAt) => ({
  id,
  type,
  createdAt,
  target,
});

describe('Recent changes (dashboard)', () => {
  it('lists the latest changes newest first, in calm words, linking only to items that still exist', async () => {
    const api = routeFetch({
      'GET /users/me/activity': json(
        200,
        page([
          item('MESSAGE_UPDATED', at(0), 'm1'),
          item('TRUSTED_CONTACT_UPDATED', at(1), 't1'),
          item('MEMORY_ADDED', at(3), 'v1'),
          item('MESSAGE_RESCHEDULED', at(5), 'm1'),
          item('MESSAGE_DELETED', at(6)),
        ]),
      ),
    });
    renderWithClient(<RecentChanges />);
    expect(screen.getByRole('heading', { name: 'Recent changes' })).toBeInTheDocument();
    await screen.findByText('Message updated');
    const rows = screen.getAllByRole('listitem');
    expect(rows.map((r) => r.textContent)).toEqual([
      `Message updatedToday`,
      `Trusted Contact changedYesterday`,
      `Memory added${shortDay(at(3))}`,
      `Schedule changed${shortDay(at(5))}`,
      `Message removed${shortDay(at(6))}`,
    ]);
    expect(within(rows[0]).getByRole('link', { name: 'Message updated' })).toHaveAttribute('href', '/messages/m1');
    expect(within(rows[1]).getByRole('link')).toHaveAttribute('href', '/trusted-contacts');
    expect(within(rows[2]).getByRole('link')).toHaveAttribute('href', '/memory-vault/v1');
    // A removed message is plain text, never a broken link.
    expect(within(rows[4]).queryByRole('link')).toBeNull();
    expect(screen.getByRole('link', { name: /View all activity/ })).toHaveAttribute('href', '/settings/activity');
    // The dashboard asks for five, newest first (the API orders).
    expect(api.calls[0].path).toBe('/users/me/activity');
    expect(screen.queryByText(/MESSAGE_|_UPDATED/)).toBeNull();
  });

  it('empty: a calm sentence, no View all', async () => {
    routeFetch({ 'GET /users/me/activity': json(200, page([])) });
    renderWithClient(<RecentChanges />);
    expect(await screen.findByText(/No recent changes yet/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /View all/ })).toBeNull();
  });

  it('loading: skeleton rows, never example activity', () => {
    routeFetch({ 'GET /users/me/activity': () => new Promise<Response>(() => undefined) as unknown as Response });
    renderWithClient(<RecentChanges />);
    expect(screen.getByLabelText('Loading recent changes')).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByText(/added|updated/)).toBeNull();
  });

  it('error: unavailable, and nothing else breaks', async () => {
    routeFetch({ 'GET /users/me/activity': json(500, { statusCode: 500, message: 'Internal server error' }) });
    renderWithClient(<RecentChanges />);
    expect(await screen.findByText('Recent changes are unavailable right now.', {}, { timeout: 5000 })).toBeInTheDocument();
  });

  it('account events link to settings; story and wish answers to their prompt', async () => {
    routeFetch({
      'GET /users/me/activity': json(
        200,
        page([
          item('PROFILE_UPDATED', at(0, 10)),
          item('STORY_RESPONSE_ADDED', at(0, 9), 'childhood.earliest-memory'),
          item('WISH_RESPONSE_UPDATED', at(0, 8), 'ceremony.style'),
        ]),
      ),
    });
    renderWithClient(<RecentChanges />);
    expect(await screen.findByRole('link', { name: 'Account details updated' })).toHaveAttribute('href', '/settings');
    expect(screen.getByRole('link', { name: 'Story answer added' })).toHaveAttribute('href', '/my-story/childhood.earliest-memory');
    expect(screen.getByRole('link', { name: 'Wishes updated' })).toHaveAttribute('href', '/my-wishes/ceremony.style');
  });
});

describe('Activity page', () => {
  it('groups by day (Today, Yesterday, then the date) with times, and pages through the API', async () => {
    const api = routeFetch({
      'GET /users/me/activity': json(
        200,
        page(
          [
            item('MESSAGE_UPDATED', at(0, 14), 'm1'),
            item('TRUSTED_CONTACT_ADDED', at(0, 11), 't1'),
            item('MEMORY_ADDED', at(1, 16), 'v1'),
            item('PERSON_REMOVED', at(4, 9)),
          ],
          { page: 2, total: 29, pages: 2 },
        ),
      ),
    });
    renderWithClient(<ActivityHistory page={2} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Activity' })).toBeInTheDocument();
    const today = await screen.findByRole('region', { name: 'Today' });
    expect(within(today).getAllByRole('listitem')).toHaveLength(2);
    expect(within(today).getAllByRole('listitem')[0]).toHaveTextContent(/Message updated\s*2:42/i);
    expect(screen.getByRole('region', { name: 'Yesterday' })).toHaveTextContent('Memory added');
    expect(screen.getByRole('region', { name: longDay(at(4)) })).toHaveTextContent('Person removed');
    expect(api.calls[0].path).toBe('/users/me/activity');
    const nav = screen.getByRole('navigation', { name: 'Pagination' });
    expect(within(nav).getByRole('link', { name: /Previous/ })).toHaveAttribute('href', '/settings/activity');
  });

  it('a new account has an empty, calm history', async () => {
    routeFetch({ 'GET /users/me/activity': json(200, page([])) });
    renderWithClient(<ActivityHistory page={1} />);
    expect(await screen.findByText(/Activity history begins when you start making changes/)).toBeInTheDocument();
  });
});

describe('activity dates', () => {
  it('short and long day labels, and grouping by the viewer’s day', () => {
    const now = new Date(2026, 9, 13, 12);
    expect(shortDay(new Date(2026, 9, 13, 1).toISOString(), now)).toBe('Today');
    expect(shortDay(new Date(2026, 9, 12, 23).toISOString(), now)).toBe('Yesterday');
    expect(shortDay(new Date(2026, 9, 8, 9).toISOString(), now)).toBe('8 Oct');
    expect(shortDay(new Date(2025, 11, 30, 9).toISOString(), now)).toBe('30 Dec 2025');
    expect(longDay(new Date(2026, 9, 10, 9).toISOString(), now)).toBe('10 October 2026');
    const items = [new Date(2026, 9, 13, 9), new Date(2026, 9, 13, 8), new Date(2026, 9, 12, 20)].map((d, i) =>
      item('MEMORY_ADDED', d.toISOString(), null, String(i)),
    );
    expect(groupByDay(items).map((g) => g.items.length)).toEqual([2, 1]);
  });
});
