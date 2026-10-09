import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MediaAsset } from '@/lib/api/media';
import { FAKE_PROVIDER_FILE_ID, fakeStorage, json, renderWithClient, routeFetch } from '@/test/utils';
import { Recorder } from './recorder';
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
  upload: {
    url: 'https://upload.test/files',
    fields: { token: 'signed-token', fileName: 'a9.png', folder: '/for-after/x/photo/' },
  },
  expiresAt: '2030-01-01T00:00:00Z',
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

  it('upload-url → direct upload to the provider → complete with its file id → READY', async () => {
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
    // Bytes go to the provider, never through the API: a multipart POST of
    // exactly the signed fields plus the file.
    expect(puts).toHaveLength(1);
    expect(puts[0]).toMatchObject({ method: 'POST', url: uploadTarget.upload.url });
    const form = puts[0].body as FormData;
    expect(form.get('token')).toBe('signed-token');
    expect(form.get('folder')).toBe('/for-after/x/photo/');
    expect((form.get('file') as File).name).toBe('beach.png');
    expect(api.called('POST', '/messages/m1/media/a9/complete')[0].body).toEqual({
      providerFileId: FAKE_PROVIDER_FILE_ID,
    });
  });

  it('reports a failed provider upload and never calls complete', async () => {
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

  it('VIDEO: checks the type, uploads, and plays from a signed URL only on demand', async () => {
    let media: MediaAsset[] = [];
    const api = routeFetch({
      'GET /messages/m1/media': () => json(200, media),
      'POST /messages/m1/media/upload-url': json(201, uploadTarget),
      'POST /messages/m1/media/a9/complete': () => {
        media = [asset({ id: 'a9', kind: 'VIDEO', originalFileName: 'hello.mp4', mimeType: 'video/mp4' })];
        return json(200, media[0]);
      },
      'GET /messages/m1/media/a9/access-url': json(200, { url: 'https://media.test/v?ik-s=1', expiresAt: '2030-01-01T00:00:00Z' }),
    });
    fakeStorage(200);
    renderWithClient(<MediaManager scope={scope} kinds={['VIDEO']} editable />);
    await screen.findByText('Nothing added yet.');
    const input = document.querySelector<HTMLInputElement>('input[type=file]')!;
    expect(input.accept).toBe('video/mp4,video/webm');
    await userEvent.upload(input, new File(['x'], 'clip.mov', { type: 'video/quicktime' }), { applyAccept: false });
    expect(await screen.findByRole('alert')).toHaveTextContent('Please choose an MP4 or WebM video.');
    expect(api.called('POST', '/messages/m1/media/upload-url')).toHaveLength(0);

    await userEvent.upload(input, new File([new Uint8Array(10)], 'hello.mp4', { type: 'video/mp4' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Watch' }));
    expect(await screen.findByLabelText('Play hello.mp4')).toHaveAttribute('src', 'https://media.test/v?ik-s=1');
    expect(api.called('POST', '/messages/m1/media/upload-url')[0].body).toMatchObject({ kind: 'VIDEO', mimeType: 'video/mp4' });
  });

  it.each([
    ['VIDEO', 'big.mp4', 'video/mp4', 100],
    ['AUDIO', 'big.wav', 'audio/wav', 25],
  ] as const)('refuses %s over the %s MB provider limit before asking for an upload', async (kind, name, type, mb) => {
    const api = routeFetch({ 'GET /messages/m1/media': json(200, []) });
    renderWithClient(<MediaManager scope={scope} kinds={[kind]} editable />);
    await screen.findByText('Nothing added yet.');
    const big = new File(['x'], name, { type });
    Object.defineProperty(big, 'size', { value: mb * 1024 * 1024 + 1 });
    await userEvent.upload(document.querySelector<HTMLInputElement>('input[type=file]')!, big);
    expect(await screen.findByRole('alert')).toHaveTextContent(`larger than ${mb} MB`);
    expect(api.called('POST', '/messages/m1/media/upload-url')).toHaveLength(0);
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
    expect(screen.queryByRole('button', { name: /Add a photo|Upload audio|Add a video|Record/ })).not.toBeInTheDocument();
  });
});

describe('Recorder (audio and video)', () => {
  let chunk = new Blob(['bytes']);
  class FakeRecorder {
    static supported: string[] = [];
    static isTypeSupported = (type: string) => FakeRecorder.supported.includes(type);
    state = 'inactive';
    ondataavailable?: ((e: { data: Blob }) => void) | null;
    onstop?: (() => void) | null;
    start() {
      this.state = 'recording';
    }
    stop() {
      this.state = 'inactive';
      this.ondataavailable?.({ data: chunk });
      this.onstop?.();
    }
  }
  // A camera + microphone stream whose tracks record being stopped.
  const fakeStream = () => {
    const tracks = [
      { stop: vi.fn(), onended: null as null | (() => void) },
      { stop: vi.fn(), onended: null as null | (() => void) },
    ];
    return { getTracks: () => tracks, tracks };
  };
  const withDevices = (
    getUserMedia: (c?: unknown) => Promise<unknown>,
    supported = ['audio/webm;codecs=opus', 'video/webm;codecs=vp8,opus'],
  ) => {
    FakeRecorder.supported = supported;
    vi.stubGlobal('MediaRecorder', FakeRecorder);
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true });
    URL.createObjectURL = vi.fn(() => 'blob:preview');
    URL.revokeObjectURL = vi.fn();
  };
  afterEach(() => {
    Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
    vi.unstubAllGlobals();
    vi.useRealTimers();
    chunk = new Blob(['bytes']);
  });
  const recordVideo = async () => {
    await userEvent.click(screen.getByRole('button', { name: 'Record a video' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Start recording' }));
    await act(() => userEvent.click(screen.getByRole('button', { name: 'Stop' })));
  };

  describe('audio', () => {
    it('records only after a click, previews, and hands over a backend-accepted file', async () => {
      const stream = fakeStream();
      const getUserMedia = vi.fn(async () => stream);
      withDevices(getUserMedia);
      const onUse = vi.fn();
      renderWithClient(<Recorder kind="AUDIO" onUse={onUse} />);
      expect(getUserMedia).not.toHaveBeenCalled();

      await userEvent.click(screen.getByRole('button', { name: 'Record your voice' }));
      expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
      expect(await screen.findByRole('status')).toHaveTextContent('Recording');
      await act(() => userEvent.click(screen.getByRole('button', { name: 'Stop' })));

      expect(stream.tracks[0].stop).toHaveBeenCalled(); // microphone released
      expect(screen.getByLabelText('Your recording')).toHaveAttribute('src', 'blob:preview');
      expect(onUse).not.toHaveBeenCalled(); // nothing uploads without confirmation
      await userEvent.click(screen.getByRole('button', { name: 'Use this recording' }));
      const file = onUse.mock.calls[0][0] as File;
      expect(file.type).toBe('audio/webm');
      expect(file.name).toMatch(/\.webm$/);
    });

    it('discards the recording and frees the preview', async () => {
      withDevices(async () => fakeStream());
      renderWithClient(<Recorder kind="AUDIO" onUse={vi.fn()} />);
      await userEvent.click(screen.getByRole('button', { name: 'Record your voice' }));
      await act(() => userEvent.click(screen.getByRole('button', { name: 'Stop' })));
      await userEvent.click(screen.getByRole('button', { name: 'Discard' }));
      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview');
      expect(screen.getByRole('button', { name: 'Record your voice' })).toBeInTheDocument();
    });

    it('explains a denied microphone', async () => {
      withDevices(async () => {
        throw new DOMException('denied', 'NotAllowedError');
      });
      renderWithClient(<Recorder kind="AUDIO" onUse={vi.fn()} />);
      await userEvent.click(screen.getByRole('button', { name: 'Record your voice' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('Access to your microphone was not allowed');
    });

    it('says so when the browser cannot record a supported format', () => {
      renderWithClient(<Recorder kind="AUDIO" onUse={vi.fn()} />);
      expect(screen.getByText(/Recording isn.t available in this browser/)).toBeInTheDocument();
    });
  });

  describe('video', () => {
    it('is offered next to "Add a video" on an editable VIDEO draft, and asks for nothing on render', async () => {
      const getUserMedia = vi.fn(async () => fakeStream());
      withDevices(getUserMedia);
      routeFetch({ 'GET /messages/m1/media': json(200, []) });
      renderWithClient(<MediaManager scope={scope} kinds={['VIDEO']} editable />);
      await screen.findByText('Nothing added yet.');
      expect(screen.getByRole('button', { name: 'Add a video' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Record a video' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Record your voice' })).toBeNull();
      expect(getUserMedia).not.toHaveBeenCalled();
    });

    it('is not offered on a scheduled (view-only) message', async () => {
      withDevices(async () => fakeStream());
      routeFetch({ 'GET /messages/m1/media': json(200, []) });
      renderWithClient(<MediaManager scope={scope} kinds={[]} editable={false} />);
      await screen.findByText('No photos, audio or video.');
      expect(screen.queryByRole('button', { name: 'Record a video' })).toBeNull();
    });

    it('camera + mic on click → live preview → timed recording → playback; nothing uploads; devices released', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const stream = fakeStream();
      const getUserMedia = vi.fn(async () => stream);
      withDevices(getUserMedia);
      const onUse = vi.fn();
      renderWithClient(<Recorder kind="VIDEO" onUse={onUse} />);

      await userEvent.click(screen.getByRole('button', { name: 'Record a video' }));
      expect(getUserMedia).toHaveBeenCalledWith({ audio: true, video: { facingMode: 'user' } });
      expect(await screen.findByLabelText('Camera preview')).toBeInTheDocument();
      expect(screen.getByRole('status')).toHaveTextContent('Not recording yet');

      await userEvent.click(screen.getByRole('button', { name: 'Start recording' }));
      expect(screen.getByRole('status')).toHaveTextContent('Recording 0:00');
      await act(() => vi.advanceTimersByTimeAsync(2000));
      expect(screen.getByRole('status')).toHaveTextContent('Recording 0:02');
      await act(() => userEvent.click(screen.getByRole('button', { name: 'Stop' })));

      stream.tracks.forEach((t) => expect(t.stop).toHaveBeenCalled());
      expect(screen.queryByLabelText('Camera preview')).toBeNull();
      expect(screen.getByLabelText('Your recording')).toHaveAttribute('src', 'blob:preview');
      expect(screen.getByText(/Watch it back before using it \(0:02/)).toBeInTheDocument();
      expect(onUse).not.toHaveBeenCalled();

      await userEvent.click(screen.getByRole('button', { name: 'Discard' }));
      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview');
      expect(screen.queryByLabelText('Your recording')).toBeNull();
      expect(screen.getByRole('button', { name: 'Record a video' })).toBeInTheDocument();
      expect(onUse).not.toHaveBeenCalled();
    });

    it('uploads the container it recorded: WebM stays WebM, MP4 only where recorded as MP4', async () => {
      const cases = [
        [['video/webm;codecs=vp8,opus', 'video/mp4'], 'video/webm', 'webm'],
        [['video/mp4'], 'video/mp4', 'mp4'],
      ] as const;
      for (const [supported, type, ext] of cases) {
        withDevices(async () => fakeStream(), [...supported]);
        const onUse = vi.fn();
        const { unmount } = renderWithClient(<Recorder kind="VIDEO" onUse={onUse} />);
        await recordVideo();
        await userEvent.click(screen.getByRole('button', { name: 'Use this recording' }));
        const file = onUse.mock.calls[0][0] as File;
        expect(file.type).toBe(type);
        expect(file.name).toMatch(new RegExp(`\\.${ext}$`));
        unmount();
      }
    });

    it('"Record again" frees the old preview and opens the camera again', async () => {
      const getUserMedia = vi.fn(async () => fakeStream());
      withDevices(getUserMedia);
      renderWithClient(<Recorder kind="VIDEO" onUse={vi.fn()} />);
      await recordVideo();
      await userEvent.click(screen.getByRole('button', { name: 'Record again' }));
      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview');
      expect(getUserMedia).toHaveBeenCalledTimes(2);
      expect(await screen.findByRole('button', { name: 'Start recording' })).toBeInTheDocument();
    });

    it('Cancel and leaving the page release the camera', async () => {
      const first = fakeStream();
      const second = fakeStream();
      withDevices(vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second));
      const { unmount } = renderWithClient(<Recorder kind="VIDEO" onUse={vi.fn()} />);
      await userEvent.click(screen.getByRole('button', { name: 'Record a video' }));
      await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
      first.tracks.forEach((t) => expect(t.stop).toHaveBeenCalled());

      await userEvent.click(screen.getByRole('button', { name: 'Record a video' }));
      await userEvent.click(await screen.findByRole('button', { name: 'Start recording' }));
      unmount(); // mid-recording
      second.tracks.forEach((t) => expect(t.stop).toHaveBeenCalled());
    });

    it('explains denied access calmly; uploading a file stays possible', async () => {
      withDevices(async () => {
        throw new DOMException('Permission denied by system', 'NotAllowedError');
      });
      routeFetch({ 'GET /messages/m1/media': json(200, []) });
      renderWithClient(<MediaManager scope={scope} kinds={['VIDEO']} editable />);
      await screen.findByText('Nothing added yet.');
      await userEvent.click(screen.getByRole('button', { name: 'Record a video' }));
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Access to your camera and microphone was not allowed');
      expect(alert).not.toHaveTextContent('Permission denied by system');
      expect(screen.getByRole('button', { name: 'Add a video' })).toBeEnabled();
    });

    it('explains a missing camera, and a camera that stops (permission revoked)', async () => {
      const stream = fakeStream();
      withDevices(vi.fn().mockRejectedValueOnce(new DOMException('', 'NotFoundError')).mockResolvedValueOnce(stream));
      renderWithClient(<Recorder kind="VIDEO" onUse={vi.fn()} />);
      await userEvent.click(screen.getByRole('button', { name: 'Record a video' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('No camera and microphone was found');

      await userEvent.click(screen.getByRole('button', { name: 'Record a video' }));
      await screen.findByRole('button', { name: 'Start recording' });
      act(() => stream.tracks[0].onended?.());
      expect(await screen.findByRole('alert')).toHaveTextContent('stopped. Please try again');
      stream.tracks.forEach((t) => expect(t.stop).toHaveBeenCalled());
    });

    it('refuses a recording over the video limit before any upload request', async () => {
      withDevices(async () => fakeStream());
      const RealFile = File;
      vi.stubGlobal(
        'File',
        class extends RealFile {
          get size() {
            return 100 * 1024 * 1024 + 1;
          }
        },
      );
      const onUse = vi.fn();
      renderWithClient(<Recorder kind="VIDEO" onUse={onUse} />);
      await recordVideo();
      expect(screen.getByRole('alert')).toHaveTextContent('larger than 100 MB. Please record a shorter one.');
      expect(screen.getByRole('button', { name: 'Use this recording' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Record again' })).toBeEnabled();
      expect(onUse).not.toHaveBeenCalled();
    });

    it('"Use this recording" goes through the normal VIDEO upload, reaches READY, then shows the signed preview', async () => {
      withDevices(async () => fakeStream());
      let media: MediaAsset[] = [];
      const api = routeFetch({
        'GET /messages/m1/media': () => json(200, media),
        'POST /messages/m1/media/upload-url': json(201, uploadTarget),
        'POST /messages/m1/media/a9/complete': () => {
          media = [asset({ id: 'a9', kind: 'VIDEO', originalFileName: 'recording.webm', mimeType: 'video/webm' })];
          return json(200, media[0]);
        },
        'GET /messages/m1/media/a9/access-url': json(200, { url: 'https://media.test/v?ik-s=1', expiresAt: '2030-01-01T00:00:00Z' }),
      });
      const puts = fakeStorage(200);
      renderWithClient(<MediaManager scope={scope} kinds={['VIDEO']} editable />);
      await screen.findByText('Nothing added yet.');
      await recordVideo();
      await userEvent.click(screen.getByRole('button', { name: 'Use this recording' }));

      await screen.findByRole('button', { name: 'Watch' });
      expect(api.called('POST', '/messages/m1/media/upload-url')[0].body).toMatchObject({
        kind: 'VIDEO',
        mimeType: 'video/webm',
        sizeBytes: 5,
      });
      expect(((puts[0].body as FormData).get('file') as File).name).toMatch(/^recording-.*\.webm$/);
      expect(api.called('POST', '/messages/m1/media/a9/complete')[0].body).toEqual({ providerFileId: FAKE_PROVIDER_FILE_ID });
      // The local preview is gone and freed; the READY video plays from a signed URL.
      expect(screen.queryByLabelText('Your recording')).toBeNull();
      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview');
      expect(screen.getByRole('button', { name: 'Record a video' })).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Watch' }));
      expect(await screen.findByLabelText('Play recording.webm')).toHaveAttribute('src', 'https://media.test/v?ik-s=1');
    });

    it('a failed upload keeps the recording and offers "Try again"', async () => {
      withDevices(async () => fakeStream());
      const api = routeFetch({
        'GET /messages/m1/media': json(200, []),
        'POST /messages/m1/media/upload-url': json(201, uploadTarget),
      });
      fakeStorage(0);
      renderWithClient(<MediaManager scope={scope} kinds={['VIDEO']} editable />);
      await screen.findByText('Nothing added yet.');
      await recordVideo();
      await userEvent.click(screen.getByRole('button', { name: 'Use this recording' }));
      expect(await screen.findByText(/Upload failed/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
      expect(screen.getByLabelText('Your recording')).toBeInTheDocument();
      expect(api.called('POST', '/messages/m1/media/a9/complete')).toHaveLength(0);
    });
  });
});
