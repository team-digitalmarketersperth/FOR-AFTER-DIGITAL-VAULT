import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { fakeStorage, json, renderWithClient, routeFetch, router } from '@/test/utils';
import { CompanionProvider } from '@/components/companion/companion';
import { MEMORY_CATEGORIES } from '@/lib/api/memory-vault';
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

  it('opens with the client-approved introduction, before the action and the list', async () => {
    routeFetch({ 'GET /memory-vault': json(200, page([memory])), 'GET /memory-vault/tags': json(200, []) });
    const { container } = renderWithClient(<MemoryList filters={{}} />);
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1).toHaveTextContent(/^Memory Vault$/);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    const lines = [
      'Gather the photos, videos and stories that celebrate your life. After you pass away, your Memory Vault will become a memorial page to share with loved ones and funeral guests.',
      // Kept as secondary guidance.
      'Choose what you share with that future audience in mind. Only add content you’re comfortable having seen by everyone who may receive the memorial page link.',
    ];
    for (const line of lines) expect(screen.getByText(line)).toBeInTheDocument();
    const intro = screen.getByText(lines[1]);
    const add = screen.getByRole('link', { name: 'Save a memory' });
    expect(add).toHaveAttribute('href', '/memory-vault/new');
    expect(intro.compareDocumentPosition(add) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const card = await screen.findByRole('link', { name: /Nana’s roast/ });
    expect(intro.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container).not.toHaveTextContent('—');
    // Superseded introduction is gone.
    expect(container).not.toHaveTextContent(/Your Memory Vault|Your life, ready to be remembered|Bring together the photos|funeral - a place/);
  });

  it('redesign: one toolbar (search → tag → Save), decorative photos hidden, one Save when memories exist', async () => {
    routeFetch({ 'GET /memory-vault': json(200, page([memory])), 'GET /memory-vault/tags': json(200, tagList) });
    const { container } = renderWithClient(<MemoryList filters={{}} />);
    await screen.findByRole('link', { name: /Nana’s roast/ });
    const search = screen.getByRole('searchbox', { name: 'Search memories' });
    const tag = screen.getByRole('combobox', { name: 'Filter memories by tag' });
    const add = screen.getByRole('link', { name: 'Save a memory' });
    expect(search).toHaveAttribute('placeholder', 'Search memories…');
    expect(within(tag).getAllByRole('option').map((o) => o.textContent)).toEqual(['All tags', 'Family', 'Road trips']);
    expect(search.compareDocumentPosition(tag) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(tag.compareDocumentPosition(add) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Decorative prints: empty alt inside an aria-hidden block; no copy depends on them.
    const imgs = container.querySelectorAll('img');
    expect(imgs.length).toBe(2);
    for (const img of imgs) {
      expect(img).toHaveAttribute('alt', '');
      expect(img.closest('[aria-hidden="true"]')).not.toBeNull();
    }
    expect(screen.getByRole('link', { name: 'All' })).toHaveAttribute('aria-current', 'true');
    expect(within(screen.getByRole('navigation', { name: 'Filter by category' })).getAllByRole('link')).toHaveLength(MEMORY_CATEGORIES.length + 1);
  });

  it('empty vault: the empty state repeats Save a memory as the next step', async () => {
    routeFetch({ 'GET /memory-vault': json(200, page([])), 'GET /memory-vault/tags': json(200, []) });
    renderWithClient(<MemoryList filters={{}} />);
    expect(await screen.findByRole('heading', { level: 2, name: 'Your Memory Vault is ready when you are' })).toBeInTheDocument();
    const adds = screen.getAllByRole('link', { name: 'Save a memory' });
    expect(adds).toHaveLength(2);
    for (const a of adds) expect(a).toHaveAttribute('href', '/memory-vault/new');
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
    expect(screen.getByLabelText('Filter memories by tag')).toHaveValue('Family');
    expect(screen.getByLabelText('Search memories')).toHaveValue('italy');
  });

  it('typing a search or choosing a tag updates the URL and resets to page 1', async () => {
    routeFetch({ 'GET /memory-vault': json(200, page([memory], { page: 2, total: 30, pages: 2 })), 'GET /memory-vault/tags': json(200, tagList) });
    renderWithClient(<MemoryList filters={{ category: 'RECIPES', page: 2 }} />);
    await screen.findByRole('link', { name: /Nana’s roast/ });
    await userEvent.type(screen.getByLabelText('Search memories'), 'roast');
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/memory-vault?category=RECIPES&search=roast', { scroll: false }));
    await userEvent.selectOptions(screen.getByLabelText('Filter memories by tag'), 'Road trips');
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
      privateNote: null,
      tags: ['Family', 'Sunday lunch'],
    });
  });

  it('Help me write: the memory text only; Use this draft fills it, the rest stays, nothing is saved', async () => {
    const api = routeFetch({
      'GET /memory-vault/v1': json(200, memory),
      'GET /memory-vault/tags': json(200, tagList),
      'POST /assistant/reply': json(200, { reply: 'Nana cooked it low and slow on Sundays.', truncated: false, draft: true }),
    });
    renderWithClient(<CompanionProvider><EditMemory id="v1" /></CompanionProvider>);
    await userEvent.click(await screen.findByRole('button', { name: 'Help me write' }));
    const p = await screen.findByRole('dialog', { name: /For After AI companion/ });
    expect(p).toHaveTextContent('For: Nana’s roast');
    await userEvent.click(within(p).getByRole('checkbox', { name: /Include the text in “The memory”/ }));
    await userEvent.click(within(p).getByRole('button', { name: 'Help describe a memory' }));
    expect(api.called('POST', '/assistant/reply')[0].body).toEqual({ page: 'memory-vault', action: 'expand', source: 'Low and slow.', history: [] });
    await userEvent.click(await within(p).findByRole('button', { name: 'Use this draft' }));
    expect(within(p).getByRole('status')).toHaveTextContent('then choose Save changes.');
    await userEvent.keyboard('{Escape}');
    expect(screen.getByLabelText(/^The memory/)).toHaveValue('Nana cooked it low and slow on Sundays.');
    expect(screen.getByLabelText('Title')).toHaveValue('Nana’s roast');
    expect(api.called('PATCH', '/memory-vault/v1')).toHaveLength(0);
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

  it('a cleared private note is sent as null; the detail shows a saved one', async () => {
    const api = routeFetch({
      'GET /memory-vault/v1': json(200, { ...memory, privateNote: 'Find the better photo.' }),
      'PATCH /memory-vault/v1': json(200, memory),
      'GET /memory-vault/tags': json(200, tagList),
    });
    renderWithClient(<EditMemory id="v1" />);
    const note = await screen.findByLabelText(/^Private note to yourself/);
    expect(note).toHaveValue('Find the better photo.');
    expect(note).toHaveAccessibleDescription('Only you can see this.');
    await userEvent.clear(note);
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.called('PATCH', '/memory-vault/v1')[0]?.body).toMatchObject({ privateNote: null }));
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
