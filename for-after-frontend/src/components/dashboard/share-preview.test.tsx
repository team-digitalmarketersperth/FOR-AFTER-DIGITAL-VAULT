import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { json, renderWithClient, routeFetch } from '@/test/utils';
import { SharePreview } from './share-preview';

const timeline = {
  upcoming: [
    // A birthday comes first in time, but a fixed date is preferred.
    { key: 'b1', messageId: 'm-bday', title: 'Happy birthday', triggerType: 'BIRTHDAY', dueAt: '2030-03-02T09:00:00Z', timezone: 'Australia/Perth', eventLabel: null, recipients: ['Sam'], repeatsAnnually: true },
    { key: 'b2', messageId: 'm-bday', title: 'Happy birthday', triggerType: 'BIRTHDAY', dueAt: '2030-05-02T09:00:00Z', timezone: 'Australia/Perth', eventLabel: null, recipients: ['Ana'], repeatsAnnually: true },
    { key: 'f1', messageId: 'm1', title: 'For your wedding day', triggerType: 'FIXED_DATE', dueAt: '2030-06-12T01:00:00Z', timezone: 'Australia/Perth', eventLabel: null, recipients: ['Sam'], repeatsAnnually: false },
  ],
  conditional: [{ key: 'c1', messageId: 'm-after', title: 'When I’m gone', triggerType: 'AFTER_DEATH', afterDeathDays: 30, recipients: ['Ana'] }],
  recent: [],
};

const message = {
  id: 'm1',
  title: 'For your wedding day',
  contentType: 'MIXED',
  textContent: 'I am so proud of you.\nDance all night.',
  privateNote: 'SECRET NOTE never shown',
  status: 'SCHEDULED',
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
  recipients: [{ id: 'r1', firstName: 'Sam', lastName: 'Lee', relationship: 'Son' }],
  version: 1,
};
const asset = (id: string, kind: string, status = 'READY') => ({
  id,
  kind,
  status,
  originalFileName: `${id}.bin`,
  mimeType: kind === 'PHOTO' ? 'image/jpeg' : 'video/mp4',
  sizeBytes: 10,
  uploadedAt: null,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
});

const routes = (over: Record<string, Response | ((...a: never[]) => Response)> = {}) =>
  routeFetch({
    'GET /users/me/delivery-timeline': json(200, timeline),
    'GET /messages/m1': json(200, message),
    'GET /messages/m1/media': json(200, [asset('p1', 'PHOTO'), asset('u1', 'VIDEO', 'PENDING_UPLOAD')]),
    'GET /messages/m1/media/p1/access-url': json(200, { url: 'https://media.test/p1.jpg', expiresAt: '2030-01-01T00:00:00Z' }),
    ...over,
  });

describe('Preview how it will be shared (dashboard)', () => {
  it('picks the next fixed-date scheduled message by default, with real recipients and timing', async () => {
    routes();
    renderWithClient(<SharePreview />);
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Preview how it will be shared');
    expect(screen.getByText('See your scheduled message as a Story before it’s delivered.')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { level: 3, name: 'For your wedding day' })).toBeInTheDocument();
    expect(await screen.findByText('Sam Lee')).toBeInTheDocument();
    expect(screen.getByText(/Scheduled · 12 June? 2030/)).toBeInTheDocument();
    // One option per message (the birthday's two dates are one message).
    const select = screen.getByLabelText('Message to preview');
    expect(within(select).getAllByRole('option').map((o) => o.getAttribute('value'))).toEqual(['m-bday', 'm1', 'm-after']);
    expect(select).toHaveValue('m1');
    expect(screen.getByText('A private preview only visible to you.')).toBeInTheDocument();
    // Processing media is explained, not shown.
    expect(await screen.findByText(/1 file is still uploading or being checked/)).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('SECRET NOTE');
  });

  it('after-death messages show the rule, never a date', async () => {
    routes({
      'GET /messages/m-after': json(200, { ...message, id: 'm-after', title: 'When I’m gone', contentType: 'TEXT', recipients: [] }),
      'GET /messages/m-after/media': json(200, []),
    });
    renderWithClient(<SharePreview />);
    await userEvent.selectOptions(await screen.findByLabelText('Message to preview'), 'm-after');
    expect(await screen.findByRole('heading', { level: 3, name: 'When I’m gone' })).toBeInTheDocument();
    expect(screen.getAllByText('30 days after my passing').length).toBeGreaterThan(0);
    expect(screen.queryByText(/Scheduled ·/)).not.toBeInTheDocument();
  });

  it('opens the message and Story previews read-only: real content, no private note, nothing sent; no Reel', async () => {
    const api = routes();
    renderWithClient(<SharePreview />);
    await screen.findByText('Sam Lee');
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Preview message' }));
    let dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/I am so proud of you/)).toBeInTheDocument();
    expect(dialog).not.toHaveTextContent('SECRET NOTE');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Preview message' })).toHaveFocus());

    // Reel was removed: no column, button, thumbnail or dialog.
    expect(screen.queryByText(/Reel/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Reel/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Preview Story: For your wedding day' }));
    dialog = await screen.findByRole('dialog', { name: /Story preview/ });
    expect(within(dialog).getByRole('list', { name: 'Part 1 of 2' })).toBeInTheDocument();
    expect(await within(dialog).findByAltText('Photo in this message')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Next' }));
    expect(within(dialog).getByRole('list', { name: 'Part 2 of 2' })).toBeInTheDocument();
    expect(within(dialog).getByText(/Dance all night/)).toBeInTheDocument();
    expect(dialog).not.toHaveTextContent('SECRET NOTE');
    await user.click(within(dialog).getByRole('button', { name: 'Close preview' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Preview Story: For your wedding day' })).toHaveFocus());

    // The Story button opens the same Story preview.
    await user.click(screen.getByRole('button', { name: 'Preview Story' }));
    expect(await screen.findByRole('dialog', { name: /Story preview/ })).toBeInTheDocument();

    // Previewing only ever reads.
    expect(api.calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('Story viewer: play/pause drives the real media, text never auto-advances, leaving or closing pauses playback', async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    routes({
      'GET /messages/m1/media': json(200, [asset('v1', 'VIDEO'), asset('p1', 'PHOTO')]),
      'GET /messages/m1/media/v1/access-url': json(200, { url: 'https://media.test/v1.mp4', expiresAt: '2030-01-01T00:00:00Z' }),
    });
    renderWithClient(<SharePreview />);
    await screen.findByText('Sam Lee');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Preview Story' }));
    const dialog = await screen.findByRole('dialog', { name: /Story preview/ });
    // Header from real data; three parts: video, photo, written message.
    expect(within(dialog).getAllByText('Private preview').length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText('For Sam Lee').length).toBeGreaterThan(0);
    expect(within(dialog).getByText('1 / 3')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Previous' })).toHaveAttribute('aria-disabled', 'true');

    // Video slide: the centre control plays and pauses the actual element, with no autoplay.
    const video = await within(dialog).findByLabelText('Video in this message');
    expect(video).not.toHaveAttribute('autoplay');
    expect(play).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Play video' }));
    expect(play).toHaveBeenCalledTimes(1);

    // Next: the video is paused on the way out.
    pause.mockClear();
    await user.click(within(dialog).getByRole('button', { name: 'Next' }));
    expect(pause).toHaveBeenCalled();
    expect(within(dialog).getByText('2 / 3')).toBeInTheDocument();
    // Photo slide: the centre control is the slideshow, and it can be paused.
    await user.click(within(dialog).getByRole('button', { name: /slideshow/ }));
    expect(within(dialog).getByRole('button', { name: /slideshow/ })).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Next' }));
    expect(within(dialog).getByText('3 / 3')).toBeInTheDocument();
    // Written slide: full text, no play control that would do nothing, no Next past the end.
    expect(within(dialog).getByText(/I am so proud of you\.\s+Dance all night\./)).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /^(Play|Pause)/ })).not.toBeInTheDocument();
    const next = within(dialog).getByRole('button', { name: 'Next' });
    expect(next).toHaveAttribute('aria-disabled', 'true');
    // Still focused (not dropped out of the dialog), and clicking it again does nothing.
    expect(next).toHaveFocus();
    await user.click(next);
    expect(within(dialog).getByText('3 / 3')).toBeInTheDocument();
    // No sample copy is invented.
    expect(dialog).not.toHaveTextContent(/Dear |With love|A moment to remember|Some moments stay/);

    // Keyboard: Left goes back; Escape closes and pauses whatever was playing.
    await user.keyboard('{ArrowLeft}{ArrowLeft}');
    expect(within(dialog).getByText('1 / 3')).toBeInTheDocument();
    pause.mockClear();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(pause).toHaveBeenCalled();
    play.mockRestore();
    pause.mockRestore();
  });

  it('nothing ready to show: previews are disabled with the reason', async () => {
    routes({
      'GET /messages/m1': json(200, { ...message, contentType: 'VIDEO', textContent: null }),
      'GET /messages/m1/media': json(200, [asset('u1', 'VIDEO', 'PENDING_UPLOAD')]),
    });
    renderWithClient(<SharePreview />);
    expect(await screen.findByText(/1 file is still uploading/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Preview Story' })).toBeDisabled();
    expect(screen.getByText('Nothing ready to preview yet.')).toBeInTheDocument();
  });

  it('no scheduled messages: the empty state links to message creation', async () => {
    routes({ 'GET /users/me/delivery-timeline': json(200, { upcoming: [], conditional: [], recent: [] }) });
    renderWithClient(<SharePreview />);
    expect(await screen.findByText('Your next message starts here.')).toBeInTheDocument();
    expect(screen.getByText('Create and schedule a message to preview it as a Story.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Create a message' })).toHaveAttribute('href', '/messages/new');
  });

  it('a failed load offers a retry', async () => {
    let fail = true;
    routes({ 'GET /users/me/delivery-timeline': () => (fail ? json(500, { message: 'down' }) : json(200, timeline)) });
    renderWithClient(<SharePreview />);
    const retry = await screen.findByRole('button', { name: 'Try again' }, { timeout: 5000 });
    fail = false;
    await userEvent.click(retry);
    expect(await screen.findByRole('heading', { level: 3, name: 'For your wedding day' })).toBeInTheDocument();
  });

  it('a message deleted since the timeline loaded reloads the timeline', async () => {
    let gone = false;
    const api = routes({
      'GET /messages/m1': () => json(404, { message: 'Not found' }),
      'GET /users/me/delivery-timeline': () => {
        const body = gone ? { ...timeline, upcoming: timeline.upcoming.filter((e) => e.messageId !== 'm1') } : timeline;
        gone = true;
        return json(200, body);
      },
      'GET /messages/m-bday': json(200, { ...message, id: 'm-bday', title: 'Happy birthday' }),
      'GET /messages/m-bday/media': json(200, []),
    });
    renderWithClient(<SharePreview />);
    expect(await screen.findByRole('heading', { level: 3, name: 'Happy birthday' })).toBeInTheDocument();
    expect(api.called('GET', '/users/me/delivery-timeline').length).toBe(2);
  });
});
