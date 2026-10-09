import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CreateMessageFromPrompt } from '@/components/memory-vault/memory-to-message';
import type { Prompt } from '@/lib/api/prompts';
import { FAKE_PROVIDER_FILE_ID, fakeStorage, json, renderWithClient, routeFetch, router } from '@/test/utils';
import { PromptEditor, PromptList } from './prompts';

vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/my-story' }));

// Phase 14B: rich My Story answers (files, linked memories) and Story → Message.
const KEY = 'travel.journey';
const base = `/my-story/prompts/${KEY}`;
const memory = (id: string, title: string) => ({
  id,
  title,
  category: 'TRAVEL',
  textContent: null,
  tags: [],
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
});
const prompt = (over: Partial<Prompt> = {}): Prompt => ({
  key: KEY,
  category: 'TRAVEL',
  version: 1,
  prompt: 'Tell us about a journey that stayed with you.',
  answered: false,
  response: null,
  ...over,
});
const answered = (over: Partial<NonNullable<Prompt['response']>> = {}) =>
  prompt({
    answered: true,
    response: {
      id: 'r1',
      promptKey: KEY,
      promptTextSnapshot: 'Tell us about a journey that stayed with you.',
      promptVersion: 1,
      textContent: 'By train to Kalgoorlie.',
      memories: [],
      mediaCount: 0,
      createdAt: '2026-09-01T00:00:00Z',
      updatedAt: '2026-09-01T00:00:00Z',
      ...over,
    },
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
const page = (items: unknown[]) => ({ items, pagination: { page: 1, limit: 25, total: items.length, pages: 1 } });
const routes = (p: Prompt, over: object = {}) => ({
  [`GET ${base}`]: json(200, p),
  [`GET ${base}/response/media`]: json(200, []),
  'GET /memory-vault': json(200, page([memory('m1', 'Train to Kalgoorlie'), memory('m2', 'Night in Esperance')])),
  ...over,
});

describe('My Story editor: rich answers (Phase 14B)', () => {
  it('offers photos, voice and video (upload or record) through the shared uploader; private copy', async () => {
    routeFetch(routes(prompt()));
    renderWithClient(<PromptEditor area="my-story" promptKey={KEY} />);
    expect(await screen.findByRole('heading', { name: 'Add to your story' })).toBeInTheDocument();
    expect(screen.getByText('Photos, a recording or a video. Only you can see them.')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Add a photo' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upload audio' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add a video' })).toBeInTheDocument();
    // The shared audio/video recorders come with AUDIO/VIDEO (they need a
    // browser MediaRecorder; recorder behaviour is tested in media.test.tsx).
    // Not answered yet: no sharing offered.
    expect(screen.queryByRole('link', { name: 'Create a message' })).not.toBeInTheDocument();
  });

  it('uploads a photo through the My Story media endpoints (never message or memory routes)', async () => {
    const api = routeFetch(
      routes(prompt(), {
        [`POST ${base}/response/media/upload-url`]: json(201, {
          mediaAssetId: 'a1',
          upload: { url: 'https://upload.test/files', fields: { token: 't' } },
          expiresAt: '2030-01-01T00:00:00Z',
        }),
        [`POST ${base}/response/media/a1/complete`]: json(200, asset('a1', 'PHOTO', 'beach.jpg')),
      }),
    );
    fakeStorage(200);
    renderWithClient(<PromptEditor area="my-story" promptKey={KEY} />);
    await screen.findByRole('button', { name: 'Add a photo' });
    await userEvent.upload(
      document.querySelector<HTMLInputElement>('input[type=file][accept*="image"]')!,
      new File([new Uint8Array(4)], 'beach.jpg', { type: 'image/jpeg' }),
    );
    await waitFor(() => expect(api.called('POST', `${base}/response/media/a1/complete`)).toHaveLength(1));
    expect(api.called('POST', `${base}/response/media/a1/complete`)[0].body).toEqual({ providerFileId: FAKE_PROVIDER_FILE_ID });
    expect(api.calls.some((c) => c.path.startsWith('/messages') || c.path.startsWith('/memory-vault/'))).toBe(false);
  });

  it('a scan or verification failure is shown safely and the file stays unusable', async () => {
    routeFetch(
      routes(prompt(), {
        [`POST ${base}/response/media/upload-url`]: json(201, {
          mediaAssetId: 'a1',
          upload: { url: 'https://upload.test/files', fields: { token: 't' } },
          expiresAt: '2030-01-01T00:00:00Z',
        }),
        [`POST ${base}/response/media/a1/complete`]: json(400, {
          message: 'This file could not be accepted. Please choose a different file.',
        }),
      }),
    );
    fakeStorage(200);
    renderWithClient(<PromptEditor area="my-story" promptKey={KEY} />);
    await screen.findByRole('button', { name: 'Add a photo' });
    await userEvent.upload(
      document.querySelector<HTMLInputElement>('input[type=file][accept*="image"]')!,
      new File([new Uint8Array(4)], 'bad.jpg', { type: 'image/jpeg' }),
    );
    expect(await screen.findByText(/This file could not be accepted/)).toBeInTheDocument();
  });

  it('lists the answer’s files with previews only on demand, and deletes after confirming', async () => {
    const api = routeFetch(
      routes(answered({ mediaCount: 1 }), {
        [`GET ${base}/response/media`]: json(200, [asset('a1', 'AUDIO', 'carols.mp3')]),
        [`DELETE ${base}/response/media/a1`]: new Response(null, { status: 204 }),
      }),
    );
    renderWithClient(<PromptEditor area="my-story" promptKey={KEY} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Remove carols.mp3' }));
    expect(api.calls.some((c) => c.path.endsWith('/access-url'))).toBe(false);
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /Remove|Delete/ }));
    await waitFor(() => expect(api.called('DELETE', `${base}/response/media/a1`)).toHaveLength(1));
  });

  it('a files-only answer can be saved without words (sent as null)', async () => {
    const api = routeFetch(routes(answered({ textContent: null, mediaCount: 1 }), { [`PUT ${base}/response`]: json(200, {}) }));
    renderWithClient(<PromptEditor area="my-story" promptKey={KEY} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Save answer' }));
    await waitFor(() => expect(api.called('PUT', `${base}/response`)[0]?.body).toEqual({ textContent: null }));
  });

  it('links and unlinks own memories by replacing the set; the server’s refusal is shown', async () => {
    const api = routeFetch(
      routes(answered({ memories: [{ id: 'm2', title: 'Night in Esperance', category: 'TRAVEL' }] }), {
        [`PUT ${base}/response`]: json(200, {}),
      }),
    );
    renderWithClient(<PromptEditor area="my-story" promptKey={KEY} />);
    const linked = await screen.findByRole('list', { name: 'Linked memories' });
    expect(linked).toHaveTextContent('Night in Esperance');
    const options = await screen.findByRole('list', { name: 'Memories you can link' });
    expect(within(options).queryByText('Night in Esperance')).not.toBeInTheDocument();
    await userEvent.click(within(options).getByRole('button', { name: 'Link' }));
    await waitFor(() =>
      expect(api.called('PUT', `${base}/response`)[0]?.body).toEqual({ memoryVaultItemIds: ['m2', 'm1'] }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Unlink Night in Esperance' }));
    await waitFor(() => expect(api.called('PUT', `${base}/response`)[1]?.body).toEqual({ memoryVaultItemIds: [] }));
    expect(screen.getByText(/Links stay private and are never shared/)).toBeInTheDocument();
  });

  it('an answered story offers “Create a message” with the privacy note', async () => {
    routeFetch(routes(answered()));
    renderWithClient(<PromptEditor area="my-story" promptKey={KEY} />);
    expect(await screen.findByRole('link', { name: 'Create a message' })).toHaveAttribute(
      'href',
      `/my-story/${encodeURIComponent(KEY)}/create-message`,
    );
    expect(screen.getByText(/Your story stays private. This creates a separate message/)).toBeInTheDocument();
  });

  it('the list shows what a words-free answer holds', async () => {
    routeFetch({
      'GET /my-story/prompts': json(200, [
        answered({ textContent: null, mediaCount: 2, memories: [{ id: 'm1', title: 'T', category: 'TRAVEL' }] }),
      ]),
    });
    renderWithClient(<PromptList area="my-story" />);
    expect(await screen.findByText('2 photos and recordings · 1 linked memory')).toBeInTheDocument();
  });
});

describe('Create a message from a story (Phase 14B)', () => {
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
    id: 'msg1',
    title: 'Tell us about a journey that stayed with you.',
    contentType: 'VIDEO',
    textContent: null,
    status: 'DRAFT',
    createdAt: '2026-09-02T00:00:00Z',
    updatedAt: '2026-09-02T00:00:00Z',
    recipients: [{ id: 'r1', firstName: 'Sofia', lastName: null, relationship: 'Daughter' }],
  };
  const storyRoutes = (over: object = {}) => ({
    [`GET ${base}`]: json(200, answered({ mediaCount: 2 })),
    [`GET ${base}/response/media`]: json(200, [
      asset('v1', 'VIDEO', 'train.mp4'),
      asset('p1', 'PHOTO', 'platform.jpg'),
      asset('x1', 'PHOTO', 'half.jpg', 'PENDING_UPLOAD'),
    ]),
    'GET /recipients': json(200, { items: [sofia], pagination: { page: 1, limit: 100, total: 1, pages: 1 } }),
    ...over,
  });

  it('says the story stays private; offers READY files only and the normal people checklist', async () => {
    routeFetch(storyRoutes());
    renderWithClient(<CreateMessageFromPrompt area="my-story" promptKey={KEY} />);
    expect(
      await screen.findByText('Your story stays private. A separate message will be created from the content you choose.'),
    ).toBeInTheDocument();
    expect(screen.getByText(/memories linked to your story are not shared/)).toBeInTheDocument();
    const content = screen.getByRole('group', { name: 'Story content' });
    expect(await within(content).findByRole('checkbox', { name: /train\.mp4/ })).toBeInTheDocument();
    expect(within(content).queryByRole('checkbox', { name: /half\.jpg/ })).not.toBeInTheDocument();
    expect(within(content).getByRole('checkbox', { name: 'The story’s written text' })).toBeChecked();
    expect(await screen.findByRole('checkbox', { name: /Sofia/ })).not.toBeChecked();
  });

  it('sends the explicit type and choices once, then opens the new draft in the normal message page', async () => {
    let finish!: () => void;
    const api = routeFetch(
      storyRoutes({
        [`POST ${base}/response/messages`]: () =>
          new Promise<Response>((resolve) => (finish = () => resolve(json(201, created)))) as unknown as Response,
      }),
    );
    renderWithClient(<CreateMessageFromPrompt area="my-story" promptKey={KEY} />);
    await userEvent.click(await screen.findByRole('checkbox', { name: /Sofia/ }));
    await userEvent.click(screen.getByRole('radio', { name: /Video/ }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'The story’s written text' }));
    await userEvent.click(await screen.findByRole('checkbox', { name: /train\.mp4/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Create draft message' }));
    expect(await screen.findByRole('button', { name: /Creating…/ })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: /Creating…/ }));
    finish();
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/messages/msg1'));
    expect(api.called('POST', `${base}/response/messages`)).toHaveLength(1);
    expect(api.called('POST', `${base}/response/messages`)[0].body).toEqual({
      title: 'Tell us about a journey that stayed with you.',
      contentType: 'VIDEO',
      includeText: false,
      mediaAssetIds: ['v1'],
      recipientIds: ['r1'],
    });
    // Nothing is written to the story itself.
    expect(api.calls.some((c) => c.method === 'PUT' || c.method === 'DELETE')).toBe(false);
  });

  it('shows an API error safely and allows another try', async () => {
    routeFetch(storyRoutes({ [`POST ${base}/response/messages`]: json(400, { message: 'One or more story files are invalid.' }) }));
    renderWithClient(<CreateMessageFromPrompt area="my-story" promptKey={KEY} />);
    await userEvent.click(await screen.findByRole('checkbox', { name: /Sofia/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Create draft message' }));
    expect(await screen.findByText('One or more story files are invalid.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create draft message' })).toBeEnabled();
  });
});
