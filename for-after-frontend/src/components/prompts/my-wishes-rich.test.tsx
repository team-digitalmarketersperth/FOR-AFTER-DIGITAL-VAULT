import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CreateMessageFromPrompt } from '@/components/memory-vault/memory-to-message';
import type { Prompt } from '@/lib/api/prompts';
import { FAKE_PROVIDER_FILE_ID, fakeStorage, json, renderWithClient, routeFetch, router } from '@/test/utils';
import { PromptEditor, PromptList } from './prompts';

vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/my-wishes' }));

// Phase 15B (approved policy): photos/recordings/videos on a wish and
// Wish → Message. The wish stays private; sharing is a separate message with
// the normal people, timing (ON_DEATH / AFTER_DEATH) and release.
const KEY = 'music-and-readings.music';
const base = `/my-wishes/prompts/${KEY}`;
const notice = (acknowledged = true) => ({
  version: 1,
  text: 'My Wishes records personal preferences and guidance only. It is not a will, legal document, medical directive, financial instruction or substitute for professional advice.',
  requiresAcknowledgement: true,
  acknowledged,
  acknowledgedAt: acknowledged ? '2026-10-08T00:00:00Z' : null,
});
const prompt = (over: Partial<Prompt> = {}): Prompt => ({
  key: KEY,
  category: 'MUSIC_AND_READINGS',
  version: 1,
  prompt: 'Are there any songs or pieces of music that are meaningful to you?',
  answered: false,
  response: null,
  ...over,
});
const answered = (over: Partial<NonNullable<Prompt['response']>> = {}) =>
  prompt({
    answered: true,
    response: {
      id: 'w1',
      promptKey: KEY,
      textContent: 'Something gentle by the sea.',
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
const routes = (p: Prompt, over: object = {}, acknowledged = true) => ({
  'GET /my-wishes/disclaimer': json(200, notice(acknowledged)),
  [`GET ${base}`]: json(200, p),
  [`GET ${base}/response/media`]: json(200, []),
  ...over,
});

describe('My Wishes editor: rich wishes (Phase 15B)', () => {
  it('offers photos, voice and video through the shared uploader; private copy; no AI help', async () => {
    routeFetch(routes(prompt()));
    renderWithClient(<PromptEditor area="my-wishes" promptKey={KEY} />);
    expect(await screen.findByRole('heading', { name: 'Add something personal' })).toBeInTheDocument();
    expect(screen.getByText('Photos, a recording or a video. Only you can see them.')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Add a photo' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upload audio' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add a video' })).toBeInTheDocument();
    // Not answered yet: no sharing offered. Never a memory picker here.
    expect(screen.queryByRole('link', { name: 'Create message for loved ones' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Linked memories' })).not.toBeInTheDocument();
    // AI help is deferred post-MVP: nothing suggests, generates or rewrites.
    expect(screen.queryByRole('button', { name: /\bAI\b|suggest|generate|rewrite|improve/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/\bAI\b/)).not.toBeInTheDocument();
  });

  it('until the notice is acknowledged, files cannot be added (Phase 15A)', async () => {
    routeFetch(routes(prompt(), {}, false));
    renderWithClient(<PromptEditor area="my-wishes" promptKey={KEY} />);
    expect(await screen.findByRole('heading', { name: 'Add something personal' })).toBeInTheDocument();
    expect(await screen.findByRole('checkbox', { name: 'I have read this notice.' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add a photo' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add a video' })).not.toBeInTheDocument();
  });

  it('uploads a photo through the My Wishes media endpoints (never message, story or memory routes)', async () => {
    const api = routeFetch(
      routes(prompt(), {
        [`POST ${base}/response/media/upload-url`]: json(201, {
          mediaAssetId: 'a1',
          upload: { url: 'https://upload.test/files', fields: { token: 't' } },
          expiresAt: '2030-01-01T00:00:00Z',
        }),
        [`POST ${base}/response/media/a1/complete`]: json(200, asset('a1', 'PHOTO', 'flowers.jpg')),
      }),
    );
    fakeStorage(200);
    renderWithClient(<PromptEditor area="my-wishes" promptKey={KEY} />);
    await screen.findByRole('button', { name: 'Add a photo' });
    await userEvent.upload(
      document.querySelector<HTMLInputElement>('input[type=file][accept*="image"]')!,
      new File([new Uint8Array(4)], 'flowers.jpg', { type: 'image/jpeg' }),
    );
    await waitFor(() => expect(api.called('POST', `${base}/response/media/a1/complete`)).toHaveLength(1));
    expect(api.called('POST', `${base}/response/media/a1/complete`)[0].body).toEqual({ providerFileId: FAKE_PROVIDER_FILE_ID });
    expect(
      api.calls.some((c) => c.path.startsWith('/messages') || c.path.startsWith('/my-story') || c.path.startsWith('/memory-vault')),
    ).toBe(false);
  });

  it('a full storage is shown safely', async () => {
    routeFetch(
      routes(prompt(), {
        [`POST ${base}/response/media/upload-url`]: json(409, {
          message: 'Your storage is full. Delete some files or upgrade your plan to add more.',
        }),
      }),
    );
    renderWithClient(<PromptEditor area="my-wishes" promptKey={KEY} />);
    await screen.findByRole('button', { name: 'Add a photo' });
    await userEvent.upload(
      document.querySelector<HTMLInputElement>('input[type=file][accept*="image"]')!,
      new File([new Uint8Array(4)], 'flowers.jpg', { type: 'image/jpeg' }),
    );
    expect(await screen.findByText(/Your storage is full/)).toBeInTheDocument();
  });

  it('lists the wish’s files and deletes one after confirming', async () => {
    const api = routeFetch(
      routes(answered({ mediaCount: 1 }), {
        [`GET ${base}/response/media`]: json(200, [asset('a1', 'AUDIO', 'song.mp3')]),
        [`DELETE ${base}/response/media/a1`]: new Response(null, { status: 204 }),
      }),
    );
    renderWithClient(<PromptEditor area="my-wishes" promptKey={KEY} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Remove song.mp3' }));
    expect(api.calls.some((c) => c.path.endsWith('/access-url'))).toBe(false);
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /Remove|Delete/ }));
    await waitFor(() => expect(api.called('DELETE', `${base}/response/media/a1`)).toHaveLength(1));
  });

  it('a files-only wish can be saved without words (sent as null)', async () => {
    const api = routeFetch(routes(answered({ textContent: null, mediaCount: 1 }), { [`PUT ${base}/response`]: json(200, {}) }));
    renderWithClient(<PromptEditor area="my-wishes" promptKey={KEY} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Save answer' }));
    await waitFor(() => expect(api.called('PUT', `${base}/response`)[0]?.body).toEqual({ textContent: null }));
  });

  it('an answered wish offers “Create message for loved ones” with calm privacy wording', async () => {
    routeFetch(routes(answered()));
    renderWithClient(<PromptEditor area="my-wishes" promptKey={KEY} />);
    expect(await screen.findByRole('link', { name: 'Create message for loved ones' })).toHaveAttribute(
      'href',
      `/my-wishes/${encodeURIComponent(KEY)}/create-message`,
    );
    expect(screen.getByText(/Your wish stays private. This creates a separate message for the people you choose/)).toBeInTheDocument();
    expect(screen.getByText(/Trusted Contacts do not receive it/)).toBeInTheDocument();
  });

  it('deleting a wish says messages already created stay', async () => {
    routeFetch(routes(answered()));
    renderWithClient(<PromptEditor area="my-wishes" promptKey={KEY} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Delete answer' }));
    expect(
      await within(await screen.findByRole('dialog')).findByText(/Messages you already created from it are separate and stay/),
    ).toBeInTheDocument();
  });

  it('the list shows what a words-free wish holds', async () => {
    routeFetch({
      'GET /my-wishes/disclaimer': json(200, notice()),
      'GET /my-wishes/prompts': json(200, [answered({ textContent: null, mediaCount: 2 })]),
    });
    renderWithClient(<PromptList area="my-wishes" />);
    expect(await screen.findByText('2 photos and recordings')).toBeInTheDocument();
  });
});

describe('Create a message from a wish (Phase 15B)', () => {
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
    title: 'Are there any songs or pieces of music that are meaningful to you?',
    contentType: 'MIXED',
    textContent: 'Something gentle by the sea.',
    status: 'DRAFT',
    createdAt: '2026-09-02T00:00:00Z',
    updatedAt: '2026-09-02T00:00:00Z',
    recipients: [{ id: 'r1', firstName: 'Sofia', lastName: null, relationship: 'Daughter' }],
  };
  const wishRoutes = (over: object = {}) => ({
    [`GET ${base}`]: json(200, answered({ mediaCount: 2 })),
    [`GET ${base}/response/media`]: json(200, [
      asset('a1', 'AUDIO', 'song.mp3'),
      asset('p1', 'PHOTO', 'beach.jpg'),
      asset('x1', 'VIDEO', 'half.mp4', 'PENDING_UPLOAD'),
    ]),
    'GET /recipients': json(200, { items: [sofia], pagination: { page: 1, limit: 100, total: 1, pages: 1 } }),
    ...over,
  });

  it('says the wish stays private; offers READY files only, the normal people checklist and after-death timing hint', async () => {
    routeFetch(wishRoutes());
    renderWithClient(<CreateMessageFromPrompt area="my-wishes" promptKey={KEY} />);
    expect(
      await screen.findByText('Your wish stays private. This creates a separate message for the people you choose.'),
    ).toBeInTheDocument();
    expect(screen.getByText(/won’t change or cancel it/)).toBeInTheDocument();
    expect(screen.getByText(/choose “After death” timing on the message/)).toBeInTheDocument();
    const content = screen.getByRole('group', { name: 'Wish content' });
    expect(await within(content).findByRole('checkbox', { name: /song\.mp3/ })).toBeInTheDocument();
    expect(within(content).queryByRole('checkbox', { name: /half\.mp4/ })).not.toBeInTheDocument();
    expect(within(content).getByRole('checkbox', { name: 'The wish’s written text' })).toBeChecked();
    expect(await screen.findByRole('checkbox', { name: /Sofia/ })).not.toBeChecked();
  });

  it('sends the explicit type and choices once, then opens the new draft in the normal message page', async () => {
    const api = routeFetch(wishRoutes({ [`POST ${base}/response/messages`]: json(201, created) }));
    renderWithClient(<CreateMessageFromPrompt area="my-wishes" promptKey={KEY} />);
    await userEvent.click(await screen.findByRole('checkbox', { name: /Sofia/ }));
    await userEvent.click(screen.getByRole('radio', { name: /Mixed/ }));
    await userEvent.click(await screen.findByRole('checkbox', { name: /song\.mp3/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Create draft message' }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/messages/msg1'));
    expect(api.called('POST', `${base}/response/messages`)).toHaveLength(1);
    expect(api.called('POST', `${base}/response/messages`)[0].body).toEqual({
      title: 'Are there any songs or pieces of music that are meaningful to you?',
      contentType: 'MIXED',
      includeText: true,
      mediaAssetIds: ['a1'],
      recipientIds: ['r1'],
    });
    // Nothing is written to the wish itself.
    expect(api.calls.some((c) => c.method === 'PUT' || c.method === 'DELETE')).toBe(false);
  });

  it('shows an API error safely and allows another try', async () => {
    routeFetch(wishRoutes({ [`POST ${base}/response/messages`]: json(400, { message: 'One or more wish files are invalid.' }) }));
    renderWithClient(<CreateMessageFromPrompt area="my-wishes" promptKey={KEY} />);
    await userEvent.click(await screen.findByRole('checkbox', { name: /Sofia/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Create draft message' }));
    expect(await screen.findByText('One or more wish files are invalid.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create draft message' })).toBeEnabled();
  });
});
