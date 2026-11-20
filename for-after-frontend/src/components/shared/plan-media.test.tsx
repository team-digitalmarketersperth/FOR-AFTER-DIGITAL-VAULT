import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MediaManager } from '@/components/media/media-manager';
import { CreateMessageFromPrompt } from '@/components/memory-vault/memory-to-message';
import { EditMessage, NewMessage } from '@/components/messages/message-form';
import { fakeStorage, json, renderWithClient, routeFetch, router } from '@/test/utils';

vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/messages' }));

// Updated Plans Step 4: an entitled Premium plan adds photos and audio but no new video (GET /billing
// features.mediaKinds). Video controls say "Complete"; existing videos stay viewable and removable; the trial's tier badges
// controls are unchanged; unknown plan locks nothing (the API still refuses with TIER_REQUIRED).
const TITLE = 'Video is part of For After Complete';
const COPY = 'Your plan includes photos and audio. Video is available with For After Complete. Videos you already have stay as they are, and you can still view or remove them.';
const REFUSED = { statusCode: 409, error: 'Conflict', code: 'TIER_REQUIRED', requiredTier: 'COMPLETE', feature: 'VIDEO', message: 'Video is available with For After Complete. Your plan includes photos and audio.' };
const billing = (mediaKinds: string[] | undefined, media = true) =>
  json(200, {
    enabled: true,
    state: media ? 'paid_active' : 'trial_active',
    enforced: true,
    hasAccess: true,
    trialEligible: false,
    trial: null,
    subscription: null,
    plans: [],
    canManageSubscription: false,
    trialCaps: { recipients: null, trustedContacts: null, questions: null, memories: null },
    features: { media, memoryLinks: media, ...(mediaKinds && { mediaKinds }) },
  });
const PREMIUM = () => billing(['PHOTO', 'AUDIO']);
const COMPLETE = () => billing(['PHOTO', 'AUDIO', 'VIDEO']);
const OLDER_API = () => billing(undefined); // no mediaKinds: nothing locked
const TRIAL = () => billing([], false);
const scope = { kind: 'messages', id: 'm1' } as const;
const asset = (id: string, kind: string, name: string) => ({ id, kind, status: 'READY', originalFileName: name, mimeType: kind === 'VIDEO' ? 'video/mp4' : 'image/jpeg', sizeBytes: 100, uploadedAt: null, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' });
const sofia = { id: 'r1', firstName: 'Sofia', lastName: null, relationship: 'Daughter', email: null, mobile: null, birthday: null, privateNote: null, photoId: null, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' };
const page = (items: unknown[]) => ({ items, pagination: { page: 1, limit: 100, total: items.length, pages: 1 } });
const message = (over: object = {}) => ({ id: 'm1', title: 'For Sofia', contentType: 'TEXT', textContent: 'Dear Sofia,', privateNote: null, status: 'DRAFT', version: 1, createdAt: '2026-09-02T00:00:00Z', updatedAt: '2026-09-02T00:00:00Z', recipients: [{ id: 'r1', firstName: 'Sofia', lastName: null, relationship: 'Daughter' }], ...over });

describe('Premium media controls (Updated Plans Step 4)', () => {
  it('photos and audio are normal; video controls say Complete and explain it; Escape returns focus; existing video stays with Remove', async () => {
    routeFetch({ 'GET /messages/m1/media': json(200, [asset('v1', 'VIDEO', 'kept.mp4')]), 'GET /billing': PREMIUM() });
    renderWithClient(<MediaManager scope={scope} kinds={['PHOTO', 'AUDIO', 'VIDEO']} editable />);
    const video = await screen.findByRole('button', { name: /Add a video\s*Complete/ });
    expect(screen.getByRole('button', { name: /Record a video\s*Complete/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add a photo' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upload audio' })).toBeInTheDocument();
    expect(screen.queryByText('Premium')).not.toBeInTheDocument();
    await userEvent.click(video);
    const dialog = await screen.findByRole('dialog', { name: TITLE });
    expect(within(dialog).getByText(COPY)).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: 'View plans' })).toHaveAttribute('href', '/settings/plan');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(video).toHaveFocus());
    expect(screen.getByRole('button', { name: 'Remove kept.mp4' })).toBeInTheDocument();
  });

  it('Complete and an API without mediaKinds: the normal video controls, no Complete mark', async () => {
    for (const plan of [COMPLETE, OLDER_API]) {
      routeFetch({ 'GET /messages/m1/media': json(200, []), 'GET /billing': plan() });
      const { unmount } = renderWithClient(<MediaManager scope={scope} kinds={['PHOTO', 'VIDEO']} editable />);
      expect(await screen.findByRole('button', { name: 'Add a video' })).toBeInTheDocument();
      expect(screen.queryByText('Complete')).not.toBeInTheDocument();
      unmount();
    }
  });

  it('trial: unchanged, video shows Complete (Updated Plans Step 7)', async () => {
    routeFetch({ 'GET /messages/m1/media': json(200, []), 'GET /billing': TRIAL() });
    renderWithClient(<MediaManager scope={scope} kinds={['PHOTO', 'VIDEO']} editable />);
    // Updated Plans Step 7: on the trial, photos name Premium and video names Complete (the lowest tier with each).
    expect(await screen.findByRole('button', { name: /Add a video\s*Complete/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Record a video\s*Complete/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Add a photo\s*Premium/ })).toBeInTheDocument();
  });

  it('a stale page whose video upload is refused (TIER_REQUIRED): the message and View plans, no pointless Try again', async () => {
    const puts = fakeStorage();
    routeFetch({ 'GET /messages/m1/media': json(200, []), 'GET /billing': COMPLETE(), 'POST /messages/m1/media/upload-url': json(409, REFUSED) });
    const { container } = renderWithClient(<MediaManager scope={scope} kinds={['VIDEO']} editable />);
    await screen.findByRole('button', { name: 'Add a video' });
    const input = container.querySelector('input[type=file]') as HTMLInputElement;
    await userEvent.upload(input, new File([new Uint8Array([0, 0, 0, 0x20])], 'v.mp4', { type: 'video/mp4' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(REFUSED.message);
    expect(within(alert).getByRole('link', { name: 'View plans' })).toHaveAttribute('href', '/settings/plan');
    expect(within(alert).queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    expect(puts).toHaveLength(0);
  });
});

describe('Message format and conversion (Updated Plans Step 4)', () => {
  it('new message on Premium: Video shows Complete and keeps the typed text; Photo, Audio and Mixed are normal choices', async () => {
    routeFetch({ 'GET /recipients': json(200, page([sofia])), 'GET /billing': PREMIUM() });
    renderWithClient(<NewMessage />);
    await waitFor(() => expect(screen.getAllByRole('radio').map((r) => (r as HTMLInputElement).value)).toEqual(['TEXT', 'PHOTO', 'AUDIO', 'MIXED']));
    await userEvent.type(screen.getByLabelText('Title'), 'Kept title');
    await userEvent.click(screen.getByRole('button', { name: /Video\s*Complete/ }));
    const dialog = await screen.findByRole('dialog', { name: TITLE });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.getByLabelText('Title')).toHaveValue('Kept title');
  });

  it('a VIDEO message from before keeps its own format on Premium', async () => {
    routeFetch({ 'GET /messages/m1': json(200, message({ contentType: 'VIDEO', textContent: null })), 'GET /messages/m1/media': json(200, []), 'GET /recipients': json(200, page([sofia])), 'GET /billing': PREMIUM() });
    renderWithClient(<EditMessage id="m1" />);
    await waitFor(() => expect(screen.getByRole('radio', { name: /Video/ })).toBeChecked());
    expect(screen.queryByText('Complete')).not.toBeInTheDocument();
  });

  it('a refused save (TIER_REQUIRED) keeps the form and offers View plans', async () => {
    routeFetch({ 'GET /recipients': json(200, page([sofia])), 'GET /billing': COMPLETE(), 'POST /messages': json(409, REFUSED) });
    renderWithClient(<NewMessage />);
    await userEvent.click(await screen.findByRole('radio', { name: /Video/ }));
    await userEvent.click(screen.getByRole('checkbox', { name: /Sofia/ }));
    await userEvent.type(screen.getByLabelText('Title'), 'Kept');
    await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(await screen.findByText(REFUSED.message)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View plans' })).toHaveAttribute('href', '/settings/plan');
    expect(screen.getByLabelText('Title')).toHaveValue('Kept');
  });

  it('story → message on Premium: photos can be picked; the video shows Complete instead of a checkbox, so it is never sent', async () => {
    const KEY = 'travel.journey';
    const base = `/my-story/prompts/${KEY}`;
    const api = routeFetch({
      [`GET ${base}`]: json(200, { key: KEY, category: 'TRAVEL', version: 1, prompt: 'A journey?', answered: true, response: { id: 'r1', promptKey: KEY, textContent: 'By train.', privateNote: null, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', mediaCount: 2, memories: [] } }),
      [`GET ${base}/response/media`]: json(200, [asset('v1', 'VIDEO', 'train.mp4'), asset('p1', 'PHOTO', 'platform.jpg')]),
      'GET /recipients': json(200, page([sofia])),
      'GET /billing': PREMIUM(),
      [`POST ${base}/response/messages`]: json(201, message()),
    });
    renderWithClient(<CreateMessageFromPrompt area="my-story" promptKey={KEY} />);
    const content = await screen.findByRole('group', { name: 'Story content' });
    expect(await within(content).findByRole('checkbox', { name: /platform\.jpg/ })).toBeInTheDocument();
    expect(within(content).queryByRole('checkbox', { name: /train\.mp4/ })).not.toBeInTheDocument();
    expect(within(content).getByText(/train\.mp4/)).toBeInTheDocument();
    await userEvent.click(within(content).getByRole('button', { name: /Copy this video\s*Complete/ }));
    await userEvent.click(within(await screen.findByRole('dialog', { name: TITLE })).getByRole('button', { name: 'Close' }));
    expect(api.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });
});
