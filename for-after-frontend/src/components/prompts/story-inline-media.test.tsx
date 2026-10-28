import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Prompt } from '@/lib/api/prompts';
import { FAKE_PROVIDER_FILE_ID, fakeStorage, json, page, renderWithClient, routeFetch, router } from '@/test/utils';
import { CompanionProvider } from '@/components/companion/companion';
import { StoryWorkspace } from './story-workspace';

vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/my-story' }));

// Inline media and Memory Vault links on the focused My Story editor (2026-10-27).
const A = 'travel.journey';
const B = 'travel.place';
const base = (key: string) => `/my-story/prompts/${key}`;
const prompt = (key: string, text: string, response: Prompt['response'] = null): Prompt => ({
  key,
  category: 'TRAVEL',
  version: 1,
  prompt: text,
  answered: !!response,
  response,
});
const answer = (over: Partial<NonNullable<Prompt['response']>> = {}) => ({
  id: 'r1',
  promptKey: A,
  textContent: 'By train.',
  privateNote: null,
  memories: [],
  mediaCount: 0,
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
  ...over,
});
const asset = (id: string, kind: string, name: string, status = 'READY') => ({
  id,
  kind,
  status,
  originalFileName: name,
  mimeType: kind === 'VIDEO' ? 'video/mp4' : kind === 'AUDIO' ? 'audio/mpeg' : 'image/jpeg',
  sizeBytes: 10,
  uploadedAt: null,
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
});
const memory = (id: string, title: string) => ({ id, title, category: 'TRAVEL', textContent: null, tags: [], createdAt: '', updatedAt: '' });
const uploadUrl = (id: string) =>
  json(201, { mediaAssetId: id, upload: { url: 'https://upload.test/files', fields: { token: 't' } }, expiresAt: '2030-01-01T00:00:00Z' });

type Routes = Parameters<typeof routeFetch>[0];
const setup = (first: Prompt['response'] = null, extra: Routes = {}) =>
  routeFetch({
    // With A answered, B is too, so the editor opens on A (it opens on the first unanswered question).
    'GET /my-story/prompts': json(200, [
      prompt(A, 'Tell us about a journey?', first),
      prompt(B, 'A place you still think about?', first && answer({ id: 'r2', promptKey: B })),
    ]),
    [`GET /users/me/drafts/MY_STORY/${A}`]: new Response(null, { status: 204 }),
    [`GET /users/me/drafts/MY_STORY/${B}`]: new Response(null, { status: 204 }),
    [`GET ${base(A)}/response/media`]: json(200, []),
    [`GET ${base(B)}/response/media`]: json(200, []),
    'GET /memory-vault': json(200, page([memory('m1', 'Train to Kalgoorlie'), memory('m2', 'Night in Esperance')])),
    ...extra,
  });
const fileInput = () => document.querySelector<HTMLInputElement>('input[type=file]')!;
const choose = (file: File) => fireEvent.change(fileInput(), { target: { files: [file] } });
const jpeg = (name = 'beach.jpg') => new File([new Uint8Array(4)], name, { type: 'image/jpeg' });

describe('My Story focused editor: inline media and memories', () => {
  it('shows Add to this memory, private note and sharing in order, with no detour link', async () => {
    setup(answer());
    const { container } = renderWithClient(<CompanionProvider><StoryWorkspace /></CompanionProvider>);
    await screen.findByRole('heading', { name: 'Add to this memory' });
    expect(screen.getByText('Add a photo, video or audio recording.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Photos, memories, private note and sharing/ })).not.toBeInTheDocument();
    // One file input taking exactly the pipeline's types; no recording offered here.
    expect(fileInput().accept.split(',')).toEqual([
      'image/jpeg', 'image/png', 'image/webp', 'audio/mpeg', 'audio/mp4', 'audio/webm', 'audio/wav', 'video/mp4', 'video/webm',
    ]);
    expect(screen.queryByRole('button', { name: /Record/ })).not.toBeInTheDocument();
    const order = ['Your answer', 'Add to this memory', 'Private note', 'Sharing settings', 'Save answer', 'Previous question'].map(
      (t) => within(container).getAllByText(t)[0],
    );
    for (let i = 1; i < order.length; i++) {
      expect(order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    // Answered: sharing offers the existing separate-message flow, nothing else.
    expect(screen.getByRole('link', { name: 'Create a message' })).toHaveAttribute('href', `/my-story/${A}/create-message`);
  });

  it('Add media uploads a photo through this question’s endpoints, without navigating; typed text is kept', async () => {
    const api = setup(null, {
      [`POST ${base(A)}/response/media/upload-url`]: uploadUrl('a1'),
      [`POST ${base(A)}/response/media/a1/complete`]: json(200, asset('a1', 'PHOTO', 'beach.jpg')),
    });
    fakeStorage(200);
    renderWithClient(<CompanionProvider><StoryWorkspace /></CompanionProvider>);
    await userEvent.type(await screen.findByLabelText('Your answer'), 'Unsaved words.');
    choose(jpeg());
    await waitFor(() => expect(api.called('POST', `${base(A)}/response/media/a1/complete`)).toHaveLength(1));
    expect(api.called('POST', `${base(A)}/response/media/a1/complete`)[0].body).toEqual({ providerFileId: FAKE_PROVIDER_FILE_ID });
    expect(api.called('POST', `${base(A)}/response/media/upload-url`)[0].body).toMatchObject({ kind: 'PHOTO', mimeType: 'image/jpeg' });
    expect(router.push).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Your answer')).toHaveValue('Unsaved words.');
    // Saving files never sends the answer text.
    expect(api.called('PUT', `${base(A)}/response`)).toHaveLength(0);
  });

  it('picks AUDIO and VIDEO by the file type (audio/webm vs video/webm)', async () => {
    const api = setup(null, {
      [`POST ${base(A)}/response/media/upload-url`]: uploadUrl('a1'),
      [`POST ${base(A)}/response/media/a1/complete`]: json(200, asset('a1', 'AUDIO', 'x')),
    });
    fakeStorage(200);
    renderWithClient(<CompanionProvider><StoryWorkspace /></CompanionProvider>);
    await screen.findByRole('button', { name: 'Add media' });
    choose(new File([new Uint8Array(4)], 'voice.webm', { type: 'audio/webm' }));
    await waitFor(() => expect(api.called('POST', `${base(A)}/response/media/a1/complete`)).toHaveLength(1));
    choose(new File([new Uint8Array(4)], 'clip.webm', { type: 'video/webm' }));
    await waitFor(() => expect(api.called('POST', `${base(A)}/response/media/upload-url`)).toHaveLength(2));
    expect(api.called('POST', `${base(A)}/response/media/upload-url`).map((c) => (c.body as { kind: string }).kind)).toEqual(['AUDIO', 'VIDEO']);
  });

  it('refuses unsupported and oversized files before asking for an upload', async () => {
    const api = setup();
    renderWithClient(<CompanionProvider><StoryWorkspace /></CompanionProvider>);
    await screen.findByRole('button', { name: 'Add media' });
    choose(new File(['x'], 'notes.pdf', { type: 'application/pdf' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/JPEG, PNG or WebP photo, an MP3, M4A, WebM or WAV recording, or an MP4 or WebM video/);
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    const big = new File(['x'], 'long.mp4', { type: 'video/mp4' });
    Object.defineProperty(big, 'size', { value: 101 * 1024 * 1024 });
    choose(big);
    expect(await screen.findByRole('alert')).toHaveTextContent('This file is larger than 100 MB.');
    expect(api.calls.some((c) => c.path.endsWith('/upload-url'))).toBe(false);
  });

  it('a scan/verification refusal stays failed (not ready), with Try again for the same file', async () => {
    let completes = 0;
    const api = setup(null, {
      [`POST ${base(A)}/response/media/upload-url`]: () => uploadUrl(`a${completes + 1}`),
      [`POST ${base(A)}/response/media/a1/complete`]: () => {
        completes++;
        return json(400, { message: 'This file could not be accepted. Please choose a different file.' });
      },
      [`POST ${base(A)}/response/media/a2/complete`]: json(200, asset('a2', 'PHOTO', 'beach.jpg')),
    });
    fakeStorage(200);
    renderWithClient(<CompanionProvider><StoryWorkspace /></CompanionProvider>);
    await screen.findByRole('button', { name: 'Add media' });
    choose(jpeg());
    expect(await screen.findByText(/Upload failed: This file could not be accepted/)).toBeInTheDocument();
    expect(screen.queryByText('Photo added')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(api.called('POST', `${base(A)}/response/media/a2/complete`)).toHaveLength(1));
  });

  it('a quota refusal is shown and nothing is uploaded', async () => {
    setup(null, {
      [`POST ${base(A)}/response/media/upload-url`]: json(409, { statusCode: 409, message: 'Your storage is full. Delete files you no longer need to add new ones.' }),
    });
    const puts = fakeStorage(200);
    renderWithClient(<CompanionProvider><StoryWorkspace /></CompanionProvider>);
    await screen.findByRole('button', { name: 'Add media' });
    choose(jpeg());
    expect(await screen.findByText(/Upload failed: Your storage is full/)).toBeInTheDocument();
    expect(puts).toHaveLength(0);
  });

  it('shows the answer’s files as tiles (type, name, status) with remove confirmation; previews only on demand', async () => {
    const api = setup(answer({ mediaCount: 2 }), {
      [`GET ${base(A)}/response/media`]: json(200, [asset('a1', 'VIDEO', 'a-very-long-video-file-name.mp4'), asset('a2', 'PHOTO', 'half.jpg', 'PENDING_UPLOAD')]),
      [`DELETE ${base(A)}/response/media/a2`]: new Response(null, { status: 204 }),
    });
    renderWithClient(<CompanionProvider><StoryWorkspace /></CompanionProvider>);
    const tiles = await screen.findByRole('list', { name: 'Photos, recordings and videos' });
    expect(within(tiles).getByText('Video')).toBeInTheDocument();
    expect(within(tiles).getByRole('button', { name: 'Watch' })).toBeInTheDocument();
    expect(within(tiles).getByText('Upload not finished. Remove it and upload again.')).toBeInTheDocument();
    expect(api.calls.some((c) => c.path.endsWith('/access-url'))).toBe(false); // nothing autoloads or autoplays
    await userEvent.click(within(tiles).getByRole('button', { name: 'Remove half.jpg' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(api.called('DELETE', `${base(A)}/response/media/a2`)).toHaveLength(1));
  });

  it('Choose from Memory Vault: Cancel changes nothing; linking sends only the set, never the text; no duplicates', async () => {
    const api = setup(answer({ memories: [{ id: 'm2', title: 'Night in Esperance', category: 'TRAVEL' }] }), {
      [`PUT ${base(A)}/response`]: json(200, answer()),
    });
    renderWithClient(<CompanionProvider><StoryWorkspace category="TRAVEL" /></CompanionProvider>);
    await screen.findByRole('button', { name: 'Add media' });
    await userEvent.type(screen.getByLabelText('Your answer'), ' And back.');

    await userEvent.click(screen.getByRole('button', { name: 'Choose from Memory Vault' }));
    let dialog = await screen.findByRole('dialog', { name: 'Choose from Memory Vault' });
    const options = await within(dialog).findByRole('list', { name: 'Memories you can link' });
    // Already linked m2 is not offered again.
    expect(within(options).queryByText('Night in Esperance')).not.toBeInTheDocument();
    await userEvent.click(within(options).getByRole('button', { name: 'Choose' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(api.called('PUT', `${base(A)}/response`)).toHaveLength(0);
    expect(screen.getByLabelText('Your answer')).toHaveValue('By train. And back.');

    await userEvent.click(screen.getByRole('button', { name: 'Choose from Memory Vault' }));
    dialog = await screen.findByRole('dialog', { name: 'Choose from Memory Vault' });
    await userEvent.click(within(await within(dialog).findByRole('list', { name: 'Memories you can link' })).getByRole('button', { name: 'Choose' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Link 1 memory' }));
    await waitFor(() => expect(api.called('PUT', `${base(A)}/response`)).toHaveLength(1));
    expect(api.called('PUT', `${base(A)}/response`)[0].body).toEqual({ memoryVaultItemIds: ['m2', 'm1'] });
    expect(screen.getByLabelText('Your answer')).toHaveValue('By train. And back.');
  });

  it('unlinking removes the link only: the memory itself is never deleted', async () => {
    const api = setup(answer({ memories: [{ id: 'm2', title: 'Night in Esperance', category: 'TRAVEL' }] }), {
      [`PUT ${base(A)}/response`]: json(200, answer()),
    });
    renderWithClient(<CompanionProvider><StoryWorkspace /></CompanionProvider>);
    await userEvent.click(await screen.findByRole('button', { name: 'Unlink Night in Esperance' }));
    await waitFor(() => expect(api.called('PUT', `${base(A)}/response`)[0]?.body).toEqual({ memoryVaultItemIds: [] }));
    expect(api.calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('private note loads, is saved with Save answer, and a failed save keeps both', async () => {
    let fail = true;
    const api = setup(answer({ privateNote: 'Ask Mum about the date.' }), {
      [`PUT ${base(A)}/response`]: () => (fail ? json(500, { message: 'Nope' }) : json(200, answer())),
    });
    renderWithClient(<CompanionProvider><StoryWorkspace /></CompanionProvider>);
    const note = await screen.findByLabelText(/Private note to yourself/);
    expect(note).toHaveValue('Ask Mum about the date.');
    await userEvent.type(note, ' 1972?');
    await userEvent.click(screen.getByRole('button', { name: 'Save answer' }));
    await waitFor(() => expect(api.called('PUT', `${base(A)}/response`)).toHaveLength(1));
    expect(note).toHaveValue('Ask Mum about the date. 1972?');
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Save answer' }));
    expect(await screen.findByText('Your answer and private note are saved.')).toBeInTheDocument();
    expect(api.called('PUT', `${base(A)}/response`)[1].body).toEqual({ textContent: 'By train.', privateNote: 'Ask Mum about the date. 1972?' });
  });

  it('not answered yet: sharing explains it needs a saved answer', async () => {
    setup();
    renderWithClient(<CompanionProvider><StoryWorkspace /></CompanionProvider>);
    expect(await screen.findByText('You can create a message once this answer is saved.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Create a message' })).not.toBeInTheDocument();
  });

  it('leaving mid-upload asks first; the late upload is cancelled for its own question, never the new one', async () => {
    let issue!: (r: Response) => void;
    const api = setup(null, {
      [`POST ${base(A)}/response/media/upload-url`]: () => new Promise<Response>((r) => (issue = r)) as never,
      [`DELETE ${base(A)}/response/media/a1`]: new Response(null, { status: 204 }),
    });
    fakeStorage(200);
    renderWithClient(<CompanionProvider><StoryWorkspace /></CompanionProvider>);
    await screen.findByRole('button', { name: 'Add media' });
    choose(jpeg());
    expect(await screen.findByText(/Uploading/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Next question/ }));
    let dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Leaving now cancels the upload in progress');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Stay here' }));
    expect(screen.getByText(/Uploading/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Next question/ }));
    dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel upload and continue' }));
    expect(screen.getByRole('heading', { name: 'A place you still think about?' })).toBeInTheDocument();

    issue(uploadUrl('a1'));
    await waitFor(() => expect(api.called('DELETE', `${base(A)}/response/media/a1`)).toHaveLength(1));
    expect(api.calls.some((c) => c.path.includes('/complete'))).toBe(false);
    expect(api.calls.some((c) => c.method !== 'GET' && c.path.startsWith(base(B)))).toBe(false);
  });
});
