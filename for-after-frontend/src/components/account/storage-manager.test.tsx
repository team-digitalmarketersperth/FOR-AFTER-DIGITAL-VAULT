import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { StorageItem } from '@/lib/api/media';
import { json, page, renderWithClient, routeFetch, router } from '@/test/utils';
import { StorageManager } from './storage-manager';

vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/settings/storage' }));

const MB = 1024 ** 2;
const GIB = 1024 ** 3;
const usage = (over: object = {}) => ({
  usedBytes: 25 * MB,
  reservedBytes: 0,
  limitBytes: 5 * GIB,
  remainingBytes: 5 * GIB - 25 * MB,
  percentage: 0,
  level: 'NORMAL',
  breakdown: [
    { source: 'MESSAGE', bytes: 15 * MB },
    { source: 'MEMORY_VAULT', bytes: 10 * MB },
    { source: 'MY_STORY', bytes: 0 },
    { source: 'MY_WISHES', bytes: 0 },
    { source: 'RECIPIENT_PHOTO', bytes: 0 },
  ],
  ...over,
});
const item = (over: Partial<StorageItem> = {}): StorageItem => ({
  id: 'f1',
  type: 'PHOTO',
  sizeBytes: 12.8 * MB,
  source: 'MEMORY_VAULT',
  sourceId: 'mem1',
  displayName: 'Family holiday',
  createdAt: '2026-10-08T00:00:00Z',
  canDelete: true,
  deleteRestriction: null,
  ...over,
});
const scheduled = item({
  id: 'f2',
  type: 'VIDEO',
  sizeBytes: 95.4 * MB,
  source: 'MESSAGE',
  sourceId: 'msg1',
  displayName: 'Birthday video',
  canDelete: false,
  deleteRestriction: 'MESSAGE_SCHEDULED',
});

const render = (filters = {}, routes: Record<string, Parameters<typeof routeFetch>[0][string]> = {}) => {
  const api = routeFetch({
    'GET /users/me/storage': json(200, usage()),
    'GET /users/me/storage/items': json(200, page([scheduled, item()])),
    ...routes,
  });
  renderWithClient(<StorageManager filters={filters} />);
  return api;
};
// The list request's query string, as sent.
const capture = (items: StorageItem[] = [item()]) => {
  const seen: string[] = [];
  return {
    seen,
    handler: (_: unknown, url: URL) => {
      seen.push(url.search);
      return json(200, page(items));
    },
  };
};

describe('Storage Manager', () => {
  it('shows the same usage as Settings, remaining and percentage, and a breakdown of non-empty sources', async () => {
    render();
    expect(await screen.findByText(/of 5\.0 GB used/)).toHaveTextContent('25.0 MB of 5.0 GB used');
    expect(screen.getByRole('progressbar', { name: 'Storage used' })).toHaveAttribute('aria-valuenow', '0');
    expect(screen.getByText('Remaining').nextSibling).toHaveTextContent('5.0 GB');
    const breakdown = screen.getByRole('region', { name: 'Storage breakdown' });
    expect(within(breakdown).getByText('Messages')).toBeInTheDocument();
    expect(within(breakdown).getByText('15.0 MB')).toBeInTheDocument();
    expect(within(breakdown).getByText('Memory Vault')).toBeInTheDocument();
    expect(within(breakdown).queryByText('My Story')).not.toBeInTheDocument();
  });

  it('shows uploads in progress separately when there are any', async () => {
    render({}, { 'GET /users/me/storage': json(200, usage({ reservedBytes: 100 * MB })) });
    expect(await screen.findByText('Uploads in progress')).toBeInTheDocument();
    expect(screen.getByText('125.0 MB', { exact: false })).toBeInTheDocument();
  });

  it('lists files largest first by default, with source, size, date and the right action', async () => {
    const list = capture([scheduled, item()]);
    const api = render({}, { 'GET /users/me/storage/items': list.handler });
    await screen.findByText('Family holiday');
    const files = within(screen.getByRole('region', { name: 'Your files' })).getAllByRole('listitem');
    expect(files[0]).toHaveTextContent('Birthday video');
    expect(files[0]).toHaveTextContent('95.4 MB');
    expect(files[1]).toHaveTextContent('Family holiday');
    expect(files[1]).toHaveTextContent('8 Oct 2026');
    // The default sort is not sent: the API's default is largest first.
    expect(list.seen).toEqual(['']);
    expect(screen.getByRole('combobox', { name: 'Sort' })).toHaveValue('size_desc');
    // No signed preview is fetched just to render the list.
    expect(api.calls.some((c) => c.path.includes('access-url'))).toBe(false);
  });

  it('a scheduled message’s file explains the rule and offers only Open message', async () => {
    render();
    expect(
      await screen.findByText('This file belongs to a scheduled message. Unschedule the message before changing its content.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open message: Birthday video' })).toHaveAttribute('href', '/messages/msg1');
    expect(screen.queryByRole('button', { name: 'Delete: Birthday video' })).not.toBeInTheDocument();
  });

  it('a released message’s file can only be viewed', async () => {
    render(
      {},
      {
        'GET /users/me/storage/items': json(200, page([{ ...scheduled, deleteRestriction: 'MESSAGE_RELEASED' }])),
      },
    );
    expect(await screen.findByText(/part of a released message and cannot be removed/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View message: Birthday video' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Delete/ })).not.toBeInTheDocument();
  });

  it('type chips, source and sort drive the URL (the API filters)', async () => {
    render({ type: 'PHOTO' });
    const chips = await screen.findByRole('navigation', { name: 'Filter by type' });
    expect(within(chips).getByRole('link', { name: 'Photos' })).toHaveAttribute('aria-current', 'true');
    expect(within(chips).getByRole('link', { name: 'Audio' })).toHaveAttribute('href', '/settings/storage?type=AUDIO');
    expect(within(chips).getByRole('link', { name: 'Videos' })).toHaveAttribute('href', '/settings/storage?type=VIDEO');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Where' }), 'MEMORY_VAULT');
    expect(router.replace).toHaveBeenLastCalledWith('/settings/storage?type=PHOTO&source=MEMORY_VAULT', { scroll: false });
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Sort' }), 'created_desc');
    expect(router.replace).toHaveBeenLastCalledWith('/settings/storage?type=PHOTO&sort=created_desc', { scroll: false });
  });

  it('sends the filters to the API', async () => {
    const list = capture();
    render(
      { type: 'AUDIO', source: 'MY_STORY', sort: 'created_asc', page: 2 },
      { 'GET /users/me/storage/items': list.handler },
    );
    await waitFor(() => expect(list.seen).toEqual(['?type=AUDIO&source=MY_STORY&sort=created_asc&page=2']));
  });

  it('paginates with the API’s pages', async () => {
    render({}, { 'GET /users/me/storage/items': json(200, page([item()], { total: 30, pages: 2 })) });
    const pager = await screen.findByRole('navigation', { name: 'Pagination' });
    expect(pager).toHaveTextContent('Page 1 of 2');
    expect(within(pager).getByRole('link', { name: /Next/ })).toHaveAttribute('href', '/settings/storage?page=2');
  });

  it('deleting asks first, uses the file’s own endpoint, then refreshes usage and the list', async () => {
    let deleted = false;
    const api = render(
      {},
      {
        'GET /users/me/storage/items': () => json(200, page(deleted ? [scheduled] : [scheduled, item()])),
        'GET /users/me/storage': () => json(200, usage(deleted ? { usedBytes: 12 * MB } : {})),
        'DELETE /memory-vault/mem1/media/f1': () => {
          deleted = true;
          return new Response(null, { status: 204 });
        },
      },
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Delete: Family holiday' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete this photo?' });
    expect(dialog).toHaveTextContent('Family holiday · 12.8 MB');
    expect(dialog).toHaveTextContent('permanently removes the photo from your Memory Vault');
    expect(api.called('DELETE', '/memory-vault/mem1/media/f1')).toHaveLength(0);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete photo' }));
    await waitFor(() => expect(api.called('DELETE', '/memory-vault/mem1/media/f1')).toHaveLength(1));
    await waitFor(() => expect(screen.queryByText('Family holiday')).not.toBeInTheDocument());
    expect(await screen.findByText(/of 5\.0 GB used/)).toHaveTextContent('12.0 MB of 5.0 GB used');
  });

  it('a profile photo is removed through People I Love; the person stays', async () => {
    const api = render(
      {},
      {
        'GET /users/me/storage/items': json(
          200,
          page([item({ id: 'p1', source: 'RECIPIENT_PHOTO', sourceId: 'r1', displayName: 'Sofia Rossi' })]),
        ),
        'DELETE /recipients/r1/photo/p1': new Response(null, { status: 204 }),
      },
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Remove photo: Sofia Rossi · profile photo' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove this profile photo?' });
    expect(dialog).toHaveTextContent('the person stays in People I Love');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove photo' }));
    await waitFor(() => expect(api.called('DELETE', '/recipients/r1/photo/p1')).toHaveLength(1));
  });

  it('a refused delete (e.g. the message was scheduled meanwhile) keeps the dialog open with the reason', async () => {
    render(
      {},
      {
        'GET /users/me/storage/items': json(
          200,
          page([item({ id: 'd1', source: 'MESSAGE', sourceId: 'msg9', displayName: 'Draft letter' })]),
        ),
        'DELETE /messages/msg9/media/d1': json(409, {
          message: 'Media can only be changed on a draft message. Unschedule it first.',
        }),
      },
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Delete: Draft letter' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('from this draft message');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete photo' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Unschedule it first.');
  });

  it('full storage: the calm notice, and deleting still works', async () => {
    render({}, { 'GET /users/me/storage': json(200, usage({ level: 'FULL', percentage: 100, remainingBytes: 0 })) });
    expect(await screen.findByText(/new uploads are paused until you free up space/)).toHaveAttribute('role', 'status');
    expect(screen.getByRole('button', { name: 'Delete: Family holiday' })).toBeEnabled();
    expect(screen.queryByText(/upgrade|plan/i)).not.toBeInTheDocument();
  });

  it('empty storage and no-match states', async () => {
    render({}, { 'GET /users/me/storage/items': json(200, page([])) });
    expect(await screen.findByRole('heading', { name: 'Your storage is empty.' })).toBeInTheDocument();
  });

  it('filters with no results offer Clear filters', async () => {
    render({ type: 'VIDEO' }, { 'GET /users/me/storage/items': json(200, page([])) });
    expect(await screen.findByRole('heading', { name: 'No files match these filters.' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Clear filters' })).toHaveAttribute('href', '/settings/storage');
  });

  it('loading and error states', async () => {
    render({}, { 'GET /users/me/storage/items': json(500, { message: 'Internal server error' }) });
    expect(screen.getAllByRole('status').length).toBeGreaterThan(0);
    expect(await screen.findByRole('alert')).toHaveTextContent("We couldn't load this");
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('stacks on small screens: no table, a list of cards', async () => {
    render();
    await screen.findByText('Family holiday');
    expect(document.querySelector('table')).toBeNull();
  });
});
