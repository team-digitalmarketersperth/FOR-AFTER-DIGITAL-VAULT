import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { fakeStorage, json, renderWithClient, routeFetch, router } from '@/test/utils';
import { EditMemory, MemoryDetail, MemoryList, NewMemory } from './memories';

vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/memory-vault' }));

const memory = {
  id: 'v1',
  title: 'Nana’s roast',
  category: 'RECIPES',
  textContent: 'Low and slow.',
  tags: [{ id: 't1', name: 'Family' }],
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
};
const page = (items: unknown[], over: object = {}) => ({
  items,
  pagination: { page: 1, limit: 25, total: items.length, pages: items.length ? 1 : 0, ...over },
});
const tagList = [
  { id: 't1', name: 'Family' },
  { id: 't2', name: 'Road trips' },
];

describe('Memory Vault', () => {
  it('lists memories with human category labels and their tags', async () => {
    routeFetch({ 'GET /memory-vault': json(200, page([memory])), 'GET /memory-vault/tags': json(200, tagList) });
    renderWithClient(<MemoryList filters={{}} />);
    const card = await screen.findByRole('link', { name: /Nana’s roast/ });
    expect(card).toHaveTextContent('Recipes');
    expect(within(card).getByRole('list', { name: 'Tags' })).toHaveTextContent('Family');
    expect(screen.getByRole('link', { name: 'Funny stories' })).toHaveAttribute('href', '/memory-vault?category=FUNNY_STORIES');
    expect(screen.queryByText('FUNNY_STORIES')).not.toBeInTheDocument();
    expect(screen.getByText('1 result')).toBeInTheDocument();
  });

  it('no memories at all: the first-time empty state', async () => {
    routeFetch({ 'GET /memory-vault': json(200, page([])), 'GET /memory-vault/tags': json(200, []) });
    renderWithClient(<MemoryList filters={{}} />);
    expect(await screen.findByText('Your Memory Vault is ready when you are')).toBeInTheDocument();
  });

  it('sends category, tag, search and page together; filtered empty state offers to clear', async () => {
    const api = routeFetch({ 'GET /memory-vault': json(200, page([], { page: 1 })), 'GET /memory-vault/tags': json(200, tagList) });
    renderWithClient(<MemoryList filters={{ category: 'TRAVEL', tag: 'Family', search: 'italy' }} />);
    expect(await screen.findByText('No memories match your filters')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Clear filters' })).toHaveAttribute('href', '/memory-vault');
    expect(screen.getByRole('link', { name: 'Travel' })).toHaveAttribute('aria-current', 'true');
    const list = api.calls.find((c) => c.path === '/memory-vault')!;
    expect(list).toMatchObject({ method: 'GET' });
    const sent = new URL(String(vi.mocked(fetch).mock.calls.find(([u]) => String(u).includes('/memory-vault?'))![0]));
    expect(Object.fromEntries(sent.searchParams)).toEqual({ category: 'TRAVEL', tag: 'Family', search: 'italy' });
    // Category links keep the other filters and drop the page.
    expect(screen.getByRole('link', { name: 'Recipes' })).toHaveAttribute(
      'href',
      '/memory-vault?category=RECIPES&tag=Family&search=italy',
    );
    expect(screen.getByLabelText('Tag')).toHaveValue('Family');
    expect(screen.getByLabelText('Search')).toHaveValue('italy');
  });

  it('typing a search or choosing a tag updates the URL and resets to page 1', async () => {
    routeFetch({ 'GET /memory-vault': json(200, page([memory], { page: 2, total: 30, pages: 2 })), 'GET /memory-vault/tags': json(200, tagList) });
    renderWithClient(<MemoryList filters={{ category: 'RECIPES', page: 2 }} />);
    await screen.findByRole('link', { name: /Nana’s roast/ });
    await userEvent.type(screen.getByLabelText('Search'), 'roast');
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/memory-vault?category=RECIPES&search=roast', { scroll: false }));
    await userEvent.selectOptions(screen.getByLabelText('Tag'), 'Road trips');
    expect(router.replace).toHaveBeenLastCalledWith('/memory-vault?category=RECIPES&tag=Road+trips', { scroll: false });
  });

  it('Previous / Next keep the filters', async () => {
    routeFetch({ 'GET /memory-vault': json(200, page([memory], { page: 2, total: 60, pages: 3 })), 'GET /memory-vault/tags': json(200, tagList) });
    renderWithClient(<MemoryList filters={{ tag: 'Family', page: 2 }} />);
    expect(await screen.findByText('Page 2 of 3 · 60 results')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Previous' })).toHaveAttribute('href', '/memory-vault?tag=Family');
    expect(screen.getByRole('link', { name: 'Next' })).toHaveAttribute('href', '/memory-vault?tag=Family&page=3');
  });

  it('a page past the end (after a delete) moves to the last page', async () => {
    routeFetch({ 'GET /memory-vault': json(200, page([], { page: 3, total: 26, pages: 2 })), 'GET /memory-vault/tags': json(200, []) });
    renderWithClient(<MemoryList filters={{ page: 3 }} />);
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/memory-vault?page=2', { scroll: false }));
  });

  it('shows an API error instead of an empty list', async () => {
    routeFetch({ 'GET /memory-vault': json(500, { message: 'Internal server error' }), 'GET /memory-vault/tags': json(200, []) });
    renderWithClient(<MemoryList filters={{}} />);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText('Your Memory Vault is ready when you are')).not.toBeInTheDocument();
  });

  it('creates with title, category, text and tags', async () => {
    const api = routeFetch({ 'POST /memory-vault': json(201, memory), 'GET /memory-vault/tags': json(200, tagList) });
    renderWithClient(<NewMemory />);
    await userEvent.click(screen.getByRole('button', { name: 'Save memory' }));
    expect(await screen.findByText('Choose a category.')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Title'), 'Nana’s roast');
    await userEvent.click(screen.getByRole('radio', { name: 'Recipes' }));
    // Enter adds; the existing spelling is reused; a duplicate is ignored.
    await userEvent.type(screen.getByLabelText(/^Tags/), 'family{Enter}');
    await userEvent.type(screen.getByLabelText(/^Tags/), 'FAMILY{Enter}');
    await userEvent.type(screen.getByLabelText(/^Tags/), '  Sunday   lunch ');
    await userEvent.click(screen.getByRole('button', { name: 'Add tag' }));
    expect(within(screen.getByRole('list', { name: 'Selected tags' })).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Family',
      'Sunday lunch',
    ]);
    await userEvent.click(screen.getByRole('button', { name: 'Save memory' }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/memory-vault/v1'));
    expect(api.called('POST', '/memory-vault')[0].body).toEqual({
      title: 'Nana’s roast',
      category: 'RECIPES',
      textContent: null,
      tags: ['Family', 'Sunday lunch'],
    });
  });

  it('edits with PATCH, sending the whole tag set (remove one, add one)', async () => {
    const api = routeFetch({
      'GET /memory-vault/v1': json(200, memory),
      'PATCH /memory-vault/v1': json(200, memory),
      'GET /memory-vault/tags': json(200, tagList),
    });
    renderWithClient(<EditMemory id="v1" />);
    await userEvent.click(await screen.findByRole('radio', { name: 'Family' }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove tag Family' }));
    await userEvent.type(screen.getByLabelText(/^Tags/), 'Childhood{Enter}');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(api.called('PATCH', '/memory-vault/v1')[0]?.body).toMatchObject({ category: 'FAMILY', tags: ['Childhood'] }),
    );
  });

  it('adds a photo through the Memory Vault media endpoints, and deletes after confirming', async () => {
    const api = routeFetch({
      'GET /memory-vault/v1': json(200, memory),
      'GET /memory-vault/v1/media': json(200, []),
      'GET /memory-vault/tags': json(200, tagList),
      'POST /memory-vault/v1/media/upload-url': json(201, {
        mediaAssetId: 'a1',
        upload: { url: 'https://upload.test/files', fields: { token: 't' } },
        expiresAt: '2030-01-01T00:00:00Z',
      }),
      'POST /memory-vault/v1/media/a1/complete': json(200, { id: 'a1', kind: 'PHOTO', status: 'READY' }),
      'DELETE /memory-vault/v1': new Response(null, { status: 204 }),
    });
    fakeStorage(200);
    renderWithClient(<MemoryDetail id="v1" />);
    await screen.findByText('Nothing added yet.');
    await userEvent.upload(document.querySelector<HTMLInputElement>('input[type=file]')!, new File([new Uint8Array(4)], 'a.jpg', { type: 'image/jpeg' }));
    await waitFor(() => expect(api.called('POST', '/memory-vault/v1/media/a1/complete')).toHaveLength(1));
    expect(api.calls.some((c) => c.path.startsWith('/messages'))).toBe(false);

    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete memory' }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/memory-vault'));
  });
});
