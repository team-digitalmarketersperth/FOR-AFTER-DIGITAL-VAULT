import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MediaAsset } from '@/lib/api/media';
import { fakeStorage, json, renderWithClient, routeFetch } from '@/test/utils';
import { AudioRecorder } from './audio-recorder';
import { MediaManager } from './media-manager';

const scope = { kind: 'messages', id: 'm1' } as const;
const asset = (over: Partial<MediaAsset> = {}): MediaAsset => ({
  id: 'a1',
  kind: 'PHOTO',
  status: 'READY',
  originalFileName: 'beach.png',
  mimeType: 'image/png',
  sizeBytes: 2048,
  uploadedAt: '2026-09-01T00:00:00Z',
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
  ...over,
});
const uploadTarget = {
  mediaAssetId: 'a9',
  uploadUrl: 'https://storage.test/put-here?sig=1',
  expiresAt: '2030-01-01T00:00:00Z',
  requiredHeaders: { 'Content-Type': 'image/png' },
};
const png = () => new File([new Uint8Array(10)], 'beach.png', { type: 'image/png' });
const pickPhoto = (file: File) =>
  userEvent.upload(document.querySelector<HTMLInputElement>('input[type=file]')!, file);

describe('MediaManager (direct uploads)', () => {
  it('checks the file type in the browser before asking for an upload URL', async () => {
    const api = routeFetch({ 'GET /messages/m1/media': json(200, []) });
    renderWithClient(<MediaManager scope={scope} kinds={['PHOTO']} editable />);
    await screen.findByText('Nothing added yet.');
    const svg = new File(['<svg/>'], 'evil.svg', { type: 'image/svg+xml' });
    // Bypass the input's accept filter, as a drag-and-drop or odd browser could.
    await userEvent.upload(document.querySelector<HTMLInputElement>('input[type=file]')!, svg, { applyAccept: false });
    expect(await screen.findByRole('alert')).toHaveTextContent('Please choose a JPEG, PNG or WebP photo.');
    expect(api.called('POST', '/messages/m1/media/upload-url')).toHaveLength(0);
  });

  it('upload-url → direct PUT to storage → complete → READY', async () => {
    let media: MediaAsset[] = [];
    const api = routeFetch({
      'GET /messages/m1/media': () => json(200, media),
      'POST /messages/m1/media/upload-url': json(201, uploadTarget),
      'POST /messages/m1/media/a9/complete': () => {
        media = [asset({ id: 'a9' })];
        return json(200, media[0]);
      },
      'GET /messages/m1/media/a9/access-url': json(200, { url: 'https://storage.test/get?sig=2', expiresAt: '2030-01-01T00:00:00Z' }),
    });
    const puts = fakeStorage(200);
    renderWithClient(<MediaManager scope={scope} kinds={['PHOTO']} editable />);
    await screen.findByText('Nothing added yet.');
    await pickPhoto(png());

    expect(await screen.findByRole('img', { name: 'beach.png' })).toHaveAttribute('src', 'https://storage.test/get?sig=2');
    expect(api.called('POST', '/messages/m1/media/upload-url')[0].body).toEqual({
      kind: 'PHOTO',
      originalFileName: 'beach.png',
      mimeType: 'image/png',
      sizeBytes: 10,
    });
    // Bytes go to storage, never through the API, with the signed Content-Type.
    expect(puts).toHaveLength(1);
    expect(puts[0]).toMatchObject({ url: uploadTarget.uploadUrl, headers: { 'Content-Type': 'image/png' } });
    expect(api.called('POST', '/messages/m1/media/a9/complete')).toHaveLength(1);
  });

  it('reports a failed storage upload and never calls complete', async () => {
    const api = routeFetch({
      'GET /messages/m1/media': json(200, []),
      'POST /messages/m1/media/upload-url': json(201, uploadTarget),
    });
    fakeStorage(0); // network/CORS failure
    renderWithClient(<MediaManager scope={scope} kinds={['PHOTO']} editable />);
    await screen.findByText('Nothing added yet.');
    await pickPhoto(png());
    expect(await screen.findByRole('alert')).toHaveTextContent(/Upload failed: We couldn't upload this file/);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(api.called('POST', '/messages/m1/media/a9/complete')).toHaveLength(0);
  });

  it('shows unfinished uploads as not usable, and deletes after confirming', async () => {
    const api = routeFetch({
      'GET /messages/m1/media': json(200, [asset({ status: 'PENDING_UPLOAD' })]),
      'DELETE /messages/m1/media/a1': new Response(null, { status: 204 }),
    });
    renderWithClient(<MediaManager scope={scope} kinds={['PHOTO']} editable />);
    expect(await screen.findByText(/Upload not finished/)).toBeInTheDocument();
    expect(api.called('GET', '/messages/m1/media/a1/access-url')).toHaveLength(0);
    await userEvent.click(screen.getByRole('button', { name: 'Remove beach.png' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(api.called('DELETE', '/messages/m1/media/a1')).toHaveLength(1));
  });

  it('is view-only when not editable, and fetches audio URLs only on demand', async () => {
    const api = routeFetch({
      'GET /messages/m1/media': json(200, [asset({ kind: 'AUDIO', originalFileName: 'song.webm', mimeType: 'audio/webm' })]),
      'GET /messages/m1/media/a1/access-url': json(200, { url: 'https://storage.test/audio', expiresAt: '2030-01-01T00:00:00Z' }),
    });
    renderWithClient(<MediaManager scope={scope} kinds={[]} editable={false} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Listen' }));
    expect(await screen.findByLabelText('Play song.webm')).toHaveAttribute('src', 'https://storage.test/audio');
    expect(api.called('GET', '/messages/m1/media/a1/access-url')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /Remove/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add a photo|Upload audio|Record/ })).not.toBeInTheDocument();
  });
});

describe('AudioRecorder', () => {
  const stopTrack = vi.fn();
  class FakeRecorder {
    static isTypeSupported = (type: string) => type === 'audio/webm;codecs=opus';
    state = 'inactive';
    ondataavailable?: (e: { data: Blob }) => void;
    onstop?: () => void;
    start() {
      this.state = 'recording';
    }
    stop() {
      this.state = 'inactive';
      this.ondataavailable?.({ data: new Blob(['sound'], { type: 'audio/webm;codecs=opus' }) });
      this.onstop?.();
    }
  }
  const withMic = (getUserMedia: () => Promise<unknown>) => {
    vi.stubGlobal('MediaRecorder', FakeRecorder);
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true });
    URL.createObjectURL = vi.fn(() => 'blob:preview');
    URL.revokeObjectURL = vi.fn();
  };
  afterEach(() => Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true }));

  it('records only after a click, previews, and hands over a backend-accepted file', async () => {
    const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop: stopTrack }] }));
    withMic(getUserMedia);
    const onUse = vi.fn();
    renderWithClient(<AudioRecorder onUse={onUse} />);
    expect(getUserMedia).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Record your voice' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Recording');
    await act(() => userEvent.click(screen.getByRole('button', { name: 'Stop' })));

    expect(stopTrack).toHaveBeenCalled(); // microphone released
    expect(screen.getByLabelText('Your recording')).toHaveAttribute('src', 'blob:preview');
    expect(onUse).not.toHaveBeenCalled(); // nothing uploads without confirmation
    await userEvent.click(screen.getByRole('button', { name: 'Use this recording' }));
    const file = onUse.mock.calls[0][0] as File;
    expect(file.type).toBe('audio/webm');
    expect(file.name).toMatch(/\.webm$/);
  });

  it('discards the recording and frees the preview', async () => {
    withMic(async () => ({ getTracks: () => [{ stop: stopTrack }] }));
    renderWithClient(<AudioRecorder onUse={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Record your voice' }));
    await act(() => userEvent.click(screen.getByRole('button', { name: 'Stop' })));
    await userEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview');
    expect(screen.getByRole('button', { name: 'Record your voice' })).toBeInTheDocument();
  });

  it('explains a denied microphone', async () => {
    withMic(async () => {
      throw new DOMException('denied', 'NotAllowedError');
    });
    renderWithClient(<AudioRecorder onUse={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Record your voice' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Microphone access was not allowed');
  });

  it('says so when the browser cannot record a supported format', () => {
    renderWithClient(<AudioRecorder onUse={vi.fn()} />);
    expect(screen.getByText(/Recording isn’t available in this browser|Recording isn't available in this browser/)).toBeInTheDocument();
  });
});
