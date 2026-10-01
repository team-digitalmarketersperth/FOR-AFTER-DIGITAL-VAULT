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
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
};

describe('Memory Vault', () => {
  it('lists memories with human category labels', async () => {
    routeFetch({ 'GET /memory-vault': json(200, [memory]) });
    renderWithClient(<MemoryList />);
    const card = await screen.findByRole('link', { name: /Nana’s roast/ });
    expect(card).toHaveTextContent('Recipes');
    expect(screen.getByRole('link', { name: 'Funny stories' })).toHaveAttribute('href', '/memory-vault?category=FUNNY_STORIES');
    expect(screen.queryByText('FUNNY_STORIES')).not.toBeInTheDocument();
  });

  it('filters by category through the API and the URL', async () => {
    const api = routeFetch({
      'GET /memory-vault': (_b, url) => json(200, url.searchParams.get('category') === 'TRAVEL' ? [] : [memory]),
    });
    renderWithClient(<MemoryList category="TRAVEL" />);
    expect(await screen.findByText('Nothing in Travel yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Travel' })).toHaveAttribute('aria-current', 'true');
    expect(api.calls[0]).toMatchObject({ method: 'GET', path: '/memory-vault' });
  });

  it('creates with title, category and text only', async () => {
    const api = routeFetch({ 'POST /memory-vault': json(201, memory) });
    renderWithClient(<NewMemory />);
    await userEvent.click(screen.getByRole('button', { name: 'Save memory' }));
    expect(await screen.findByText('Choose a category.')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Title'), 'Nana’s roast');
    await userEvent.click(screen.getByRole('radio', { name: 'Recipes' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save memory' }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/memory-vault/v1'));
    expect(api.called('POST', '/memory-vault')[0].body).toEqual({ title: 'Nana’s roast', category: 'RECIPES', textContent: null });
  });

  it('edits with PATCH', async () => {
    const api = routeFetch({ 'GET /memory-vault/v1': json(200, memory), 'PATCH /memory-vault/v1': json(200, memory) });
    renderWithClient(<EditMemory id="v1" />);
    await userEvent.click(await screen.findByRole('radio', { name: 'Family' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.called('PATCH', '/memory-vault/v1')[0]?.body).toMatchObject({ category: 'FAMILY' }));
  });

  it('adds a photo through the Memory Vault media endpoints, and deletes after confirming', async () => {
    const api = routeFetch({
      'GET /memory-vault/v1': json(200, memory),
      'GET /memory-vault/v1/media': json(200, []),
      'POST /memory-vault/v1/media/upload-url': json(201, {
        mediaAssetId: 'a1',
        uploadUrl: 'https://storage.test/put',
        expiresAt: '2030-01-01T00:00:00Z',
        requiredHeaders: { 'Content-Type': 'image/jpeg' },
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
