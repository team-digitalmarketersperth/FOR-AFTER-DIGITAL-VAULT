import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { AttentionItem } from '@/lib/api/attention';
import { json, renderWithClient, routeFetch } from '@/test/utils';
import { NeedsAttention } from './attention';

const A = 'GET /users/me/attention';
const item = (over: Partial<AttentionItem>): AttentionItem => ({
  key: 'MESSAGES_NEED_TIMING',
  category: 'MESSAGES',
  priority: 'MEDIUM',
  title: '2 messages need timing',
  description: null,
  actionLabel: 'Review messages',
  actionHref: '/messages',
  ...over,
});
const ITEMS = [
  item({
    key: 'STORAGE',
    category: 'STORAGE',
    priority: 'HIGH',
    title: 'Storage is 93% full',
    description: 'Free up space to keep adding photos, recordings and videos.',
    actionLabel: 'Manage storage',
    actionHref: '/settings/storage',
  }),
  item({
    key: 'TRUSTED_CONTACT:c1',
    category: 'TRUSTED_CONTACTS',
    title: 'James hasn’t accepted the invitation yet',
    actionLabel: 'Review contacts',
    actionHref: '/trusted-contacts',
  }),
  item({}),
  item({
    key: 'RECIPIENT_BIRTHDAY_MISSING:r1',
    category: 'PEOPLE',
    title: 'Sarah is missing a birthday',
    description: 'Needed for 1 scheduled birthday message.',
    actionLabel: 'Add birthday',
    actionHref: '/people/r1/edit',
  }),
];
const rows = () => within(screen.getByRole('list')).getAllByRole('listitem');

describe('Needs your attention (dashboard)', () => {
  it('lists the API’s items in its order, each a link to its own page with a clear action', async () => {
    routeFetch({ [A]: json(200, { items: ITEMS, total: 4 }) });
    renderWithClient(<NeedsAttention />);
    expect(screen.getByRole('heading', { level: 2, name: 'Needs your attention' })).toBeInTheDocument();
    await screen.findByText('Storage is 93% full');
    expect(rows().map((r) => within(r).getByRole('link').getAttribute('href'))).toEqual([
      '/settings/storage',
      '/trusted-contacts',
      '/messages',
      '/people/r1/edit',
    ]);
    // One readable sentence per row; HIGH is not colour alone, assistive tech hears it too.
    expect(rows().map((r) => within(r).getByRole('link').getAttribute('aria-label'))).toEqual([
      'Worth doing soon: Storage is 93% full. Free up space to keep adding photos, recordings and videos. Manage storage',
      'James hasn’t accepted the invitation yet. Review contacts',
      '2 messages need timing. Review messages',
      'Sarah is missing a birthday. Needed for 1 scheduled birthday message. Add birthday',
    ]);
    expect(screen.queryByText(/more things? to review/)).toBeNull();
    // Calm copy only.
    expect(screen.queryByText(/urgent|critical|error|problem|issue/i)).toBeNull();
  });

  it('shows at most four rows and counts the rest', async () => {
    const six = [...ITEMS, item({ key: 'x1', title: 'Fifth' }), item({ key: 'x2', title: 'Sixth' })];
    routeFetch({ [A]: json(200, { items: six, total: 6 }) });
    renderWithClient(<NeedsAttention />);
    await screen.findByText('Storage is 93% full');
    expect(rows()).toHaveLength(4);
    expect(screen.queryByText('Fifth')).toBeNull();
    expect(screen.getByText('+2 more things to review')).toBeInTheDocument();
  });

  it('nothing to do: a small all-clear, no list', async () => {
    routeFetch({ [A]: json(200, { items: [], total: 0 }) });
    renderWithClient(<NeedsAttention />);
    expect(await screen.findByText('Everything looks in order')).toBeInTheDocument();
    expect(screen.getByText('No actions need your attention right now.')).toBeInTheDocument();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('loading: quiet placeholders, never an early all-clear or fake items', () => {
    routeFetch({ [A]: (() => new Promise<Response>(() => {})) as unknown as () => Response });
    renderWithClient(<NeedsAttention />);
    expect(screen.getByRole('list', { name: 'Loading things to review' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByText('Everything looks in order')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('error: says it is unavailable, never “all clear”', async () => {
    routeFetch({ [A]: json(500, { message: 'Internal server error' }) });
    renderWithClient(<NeedsAttention />);
    expect(await screen.findByText('Things to review are unavailable right now.')).toBeInTheDocument();
    expect(screen.queryByText('Everything looks in order')).toBeNull();
  });
});
