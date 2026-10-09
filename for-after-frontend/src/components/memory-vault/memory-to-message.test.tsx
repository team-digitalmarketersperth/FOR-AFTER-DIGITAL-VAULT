import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { EditMessage } from '@/components/messages/message-form';
import { json, renderWithClient, routeFetch, router } from '@/test/utils';
import { MemoryDetail } from './memories';
import { CreateMessageFromMemory } from './memory-to-message';

vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/memory-vault' }));

// Phase 13B: a memory is shared by making a separate DRAFT message from it.
const memory = {
  id: 'v1',
  title: 'Christmas at Nana’s',
  category: 'FAMILY',
  textContent: 'Original content',
  tags: [{ id: 't1', name: 'Family' }],
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
};
const asset = (id: string, kind: string, name: string, status = 'READY') => ({
  id,
  kind,
  status,
  originalFileName: name,
  mimeType: kind === 'PHOTO' ? 'image/jpeg' : 'audio/mpeg',
  sizeBytes: 100,
  uploadedAt: null,
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
});
const page = (items: unknown[]) => ({ items, pagination: { page: 1, limit: 100, total: items.length, pages: 1 } });
const sofia = {
  id: 'r1',
  firstName: 'Sofia',
  lastName: null,
  relationship: 'Daughter',
  email: null,
  mobile: null,
  birthday: null,
  privateNote: null,
  photoId: null,
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
};
const created = {
  id: 'm1',
  title: 'For Sofia',
  contentType: 'MIXED',
  textContent: 'Original content',
  status: 'DRAFT',
  createdAt: '2026-09-02T00:00:00Z',
  updatedAt: '2026-09-02T00:00:00Z',
  recipients: [{ id: 'r1', firstName: 'Sofia', lastName: null, relationship: 'Daughter' }],
};
const routes = (over: object = {}) => ({
  'GET /memory-vault/v1': json(200, memory),
  'GET /memory-vault/v1/media': json(200, [
    asset('a1', 'PHOTO', 'tree.jpg'),
    asset('a2', 'AUDIO', 'carols.mp3'),
    asset('a3', 'PHOTO', 'half-done.jpg', 'PENDING_UPLOAD'),
  ]),
  'GET /recipients': json(200, page([sofia])),
  ...over,
});

describe('Create a message from a memory', () => {
  it('the memory page offers "Create a message"', async () => {
    routeFetch(routes({ 'GET /memory-vault/tags': json(200, []) }));
    renderWithClient(<MemoryDetail id="v1" />);
    expect(await screen.findByRole('link', { name: 'Create a message' })).toHaveAttribute(
      'href',
      '/memory-vault/v1/create-message',
    );
  });

  it('explains the memory stays private; offers only READY files and the existing People I Love checklist', async () => {
    routeFetch(routes());
    renderWithClient(<CreateMessageFromMemory id="v1" />);
    expect(
      await screen.findByText('Your memory stays private. A separate message will be created from the content you choose.'),
    ).toBeInTheDocument();
    expect(await screen.findByRole('checkbox', { name: /Sofia/ })).not.toBeChecked();
    const content = screen.getByRole('group', { name: 'Memory content' });
    expect(await within(content).findByRole('checkbox', { name: /tree\.jpg/ })).toBeInTheDocument();
    expect(within(content).getByRole('checkbox', { name: /carols\.mp3/ })).toBeInTheDocument();
    expect(within(content).queryByRole('checkbox', { name: /half-done/ })).not.toBeInTheDocument();
    expect(within(content).getByRole('checkbox', { name: 'The memory’s written text' })).toBeChecked();
    expect(screen.getByLabelText('Message title')).toHaveValue('Christmas at Nana’s');
  });

  it('sends the explicit choices once, shows "Creating…", then opens the new draft', async () => {
    let finish!: () => void;
    const api = routeFetch(
      routes({
        'POST /memory-vault/v1/messages': () =>
          new Promise<Response>((resolve) => (finish = () => resolve(json(201, created)))) as unknown as Response,
      }),
    );
    renderWithClient(<CreateMessageFromMemory id="v1" />);
    await userEvent.click(await screen.findByRole('checkbox', { name: /Sofia/ }));
    await userEvent.click(screen.getByRole('radio', { name: /Photos/ }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'The memory’s written text' }));
    await userEvent.click(await screen.findByRole('checkbox', { name: /tree\.jpg/ }));
    const submit = screen.getByRole('button', { name: 'Create draft message' });
    await userEvent.click(submit);
    expect(await screen.findByRole('button', { name: /Creating…/ })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: /Creating…/ }));
    finish();
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/messages/m1'));
    expect(api.called('POST', '/memory-vault/v1/messages')).toHaveLength(1);
    expect(api.called('POST', '/memory-vault/v1/messages')[0].body).toEqual({
      title: 'Christmas at Nana’s',
      contentType: 'PHOTO',
      includeText: false,
      mediaAssetIds: ['a1'],
      recipientIds: ['r1'],
    });
    // The memory itself is never written.
    expect(api.calls.some((c) => c.method !== 'GET' && c.path === '/memory-vault/v1')).toBe(false);
  });

  it('needs at least one person, like every message', async () => {
    const api = routeFetch(routes());
    renderWithClient(<CreateMessageFromMemory id="v1" />);
    await screen.findByRole('checkbox', { name: /Sofia/ });
    await userEvent.click(screen.getByRole('button', { name: 'Create draft message' }));
    expect(await screen.findByText('Choose at least one person.')).toBeInTheDocument();
    expect(api.called('POST', '/memory-vault/v1/messages')).toHaveLength(0);
  });

  it('shows an API error safely and lets the Customer try again', async () => {
    routeFetch(routes({ 'POST /memory-vault/v1/messages': json(400, { message: 'One or more memory files are invalid.' }) }));
    renderWithClient(<CreateMessageFromMemory id="v1" />);
    await userEvent.click(await screen.findByRole('checkbox', { name: /Sofia/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Create draft message' }));
    expect(await screen.findByText('One or more memory files are invalid.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create draft message' })).toBeEnabled();
    expect(router.push).not.toHaveBeenCalledWith('/messages/m1');
  });

  it('the new draft opens in the normal message editor with its copied content and recipients', async () => {
    routeFetch({ 'GET /messages/m1': json(200, created), 'GET /recipients': json(200, page([sofia])) });
    renderWithClient(<EditMessage id="m1" />);
    expect(await screen.findByLabelText('Title')).toHaveValue('For Sofia');
    expect(screen.getByLabelText(/^Message/)).toHaveValue('Original content');
    expect(await screen.findByRole('checkbox', { name: /Sofia/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: /Mixed/ })).toBeChecked();
  });
});
