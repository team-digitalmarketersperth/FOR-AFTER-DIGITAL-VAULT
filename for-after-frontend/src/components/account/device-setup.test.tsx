import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { customer, json, renderWithClient, routeFetch } from '@/test/utils';
import { DeviceChecks, DeviceSetupPrompt } from './device-setup';

// Mocked browser APIs only: no real camera, microphone, sound or notification is used.
const fakeStream = () => {
  const tracks = [{ stop: vi.fn(), onended: null as null | (() => void) }];
  return { getTracks: () => tracks, tracks } as unknown as MediaStream & { tracks: typeof tracks };
};
const domError = (name: string) => new DOMException('browser text', name);

let permissionState: PermissionState | 'unsupported' = 'unsupported';
const setDevices = (getUserMedia?: (c: MediaStreamConstraints) => Promise<MediaStream>) =>
  Object.defineProperty(navigator, 'mediaDevices', {
    value: getUserMedia ? { getUserMedia } : undefined,
    configurable: true,
  });

class FakeAudioContext {
  static made = 0;
  currentTime = 0;
  destination = {};
  closed = false;
  osc: { frequency: { value: number }; onended: null | (() => void); start: () => void; stop: () => void; connect: (n: unknown) => unknown } | null =
    null;
  constructor() {
    FakeAudioContext.made++;
    contexts.push(this);
  }
  resume = vi.fn(async () => undefined);
  close = vi.fn(async () => {
    this.closed = true;
  });
  createGain = () => ({ gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }, connect: (n: unknown) => n });
  createOscillator = () => (this.osc = { frequency: { value: 0 }, onended: null, start: vi.fn(), stop: vi.fn(), connect: (n: unknown) => n });
  createAnalyser = () => ({ fftSize: 0, getByteTimeDomainData: vi.fn(), connect: vi.fn() });
  createMediaStreamSource = () => ({ connect: vi.fn() });
}
let contexts: FakeAudioContext[] = [];

const requestPermission = vi.fn();
beforeEach(() => {
  contexts = [];
  FakeAudioContext.made = 0;
  permissionState = 'unsupported';
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
  Object.defineProperty(navigator, 'permissions', {
    value: {
      query: vi.fn(async () =>
        permissionState === 'unsupported'
          ? Promise.reject(new TypeError('unsupported name'))
          : { state: permissionState, addEventListener: vi.fn(), removeEventListener: vi.fn() },
      ),
    },
    configurable: true,
  });
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal('Notification', Object.assign(function Notification() {}, { permission: 'granted', requestPermission }));
  localStorage.clear();
});
afterEach(() => setDevices(undefined));

describe('DeviceChecks', () => {
  it('asks the browser for nothing on render, and every row starts honest', async () => {
    const getUserMedia = vi.fn(async () => fakeStream());
    setDevices(getUserMedia);
    renderWithClient(<DeviceChecks />);
    expect(screen.getByRole('button', { name: 'Check camera' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check microphone' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Play test sound' })).toBeInTheDocument();
    expect(screen.getAllByText('Not checked')).toHaveLength(3);
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(FakeAudioContext.made).toBe(0); // no autoplay, no audio graph
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('camera: asks for video only on click, shows a muted local preview, and stops it on finish', async () => {
    const stream = fakeStream();
    const getUserMedia = vi.fn(async () => stream);
    setDevices(getUserMedia);
    renderWithClient(<DeviceChecks />);
    await userEvent.click(screen.getByRole('button', { name: 'Check camera' }));
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(getUserMedia).toHaveBeenCalledWith({ video: true });
    const preview = await screen.findByLabelText(/Camera preview, shown on this device only/);
    expect((preview as HTMLVideoElement).muted).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Finish check' }));
    expect(stream.tracks[0].stop).toHaveBeenCalled();
    expect(screen.getByText('Working. Checked just now and turned off.')).toBeInTheDocument();
  });

  it('microphone: asks for audio only, never plays it back, and releases it when the page closes', async () => {
    const stream = fakeStream();
    const getUserMedia = vi.fn(async () => stream);
    setDevices(getUserMedia);
    const { unmount } = renderWithClient(<DeviceChecks />);
    await userEvent.click(screen.getByRole('button', { name: 'Check microphone' }));
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(await screen.findByText('Say something to see the level move.')).toBeInTheDocument();
    expect(contexts).toHaveLength(1);
    unmount();
    expect(stream.tracks[0].stop).toHaveBeenCalled();
    expect(contexts[0].close).toHaveBeenCalled();
  });

  it('stops tracks from a request that resolves after cancel or after leaving', async () => {
    let resolve!: (s: MediaStream) => void;
    const late = fakeStream();
    setDevices(vi.fn(() => new Promise<MediaStream>((r) => (resolve = r))));
    renderWithClient(<DeviceChecks />);
    await userEvent.click(screen.getByRole('button', { name: 'Check camera' }));
    expect(screen.getByText(/Waiting for your browser/)).toBeInTheDocument();
    // The rest of the page stays usable while the browser asks.
    expect(screen.getByRole('button', { name: 'Check microphone' })).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await act(async () => resolve(late));
    expect(late.tracks[0].stop).toHaveBeenCalled();
    expect(screen.queryByLabelText(/Camera preview/)).toBeNull();

    const late2 = fakeStream();
    const { unmount } = renderWithClient(<DeviceChecks />);
    await userEvent.click(screen.getAllByRole('button', { name: 'Check camera' })[1]);
    unmount();
    await act(async () => resolve(late2));
    expect(late2.tracks[0].stop).toHaveBeenCalled();
  });

  it.each([
    ['NotFoundError', 'No camera found'],
    ['NotReadableError', 'In use by another app'],
    ['NotAllowedError', 'Not allowed'],
    ['TypeError', 'Couldn’t start'],
  ])('camera %s → "%s", with a way to try again', async (name, status) => {
    setDevices(vi.fn(async () => Promise.reject(domError(name))));
    renderWithClient(<DeviceChecks />);
    await userEvent.click(screen.getByRole('button', { name: 'Check camera' }));
    expect(await screen.findByText(status)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check again' })).toBeInTheDocument();
    expect(screen.queryByText(/browser text/)).toBeNull();
  });

  it('says "blocked" only when the browser reports the permission as denied, and explains site settings', async () => {
    permissionState = 'denied';
    setDevices(vi.fn(async () => Promise.reject(domError('NotAllowedError'))));
    renderWithClient(<DeviceChecks />);
    expect((await screen.findAllByText('Blocked in this browser')).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/open your browser’s site settings/).length).toBeGreaterThan(0);
  });

  it('unsupported browser or insecure page: no device buttons at all', () => {
    setDevices(undefined);
    renderWithClient(<DeviceChecks />);
    expect(screen.getAllByText('Not available in this browser.')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Check camera' })).toBeNull();
    Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true });
    renderWithClient(<DeviceChecks />);
    expect(screen.getAllByText('This needs a secure (https) connection.')).toHaveLength(2);
  });

  it('sound: plays a tone only on click, can be stopped, and handles a refused playback', async () => {
    setDevices(undefined);
    renderWithClient(<DeviceChecks />);
    await userEvent.click(screen.getByRole('button', { name: 'Play test sound' }));
    expect(contexts[0].osc?.start).toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Stop sound' }));
    expect(contexts[0].close).toHaveBeenCalled();
    expect(screen.getByText('Not checked')).toBeInTheDocument();
  });

  it('sound: a refused playback shows calm guidance', async () => {
    setDevices(undefined);
    vi.stubGlobal(
      'AudioContext',
      class extends FakeAudioContext {
        resume = vi.fn(async () => Promise.reject(new Error('refused')));
      },
    );
    renderWithClient(<DeviceChecks />);
    await userEvent.click(screen.getByRole('button', { name: 'Play test sound' }));
    expect(await screen.findByText(/The test sound couldn’t play/)).toBeInTheDocument();
    expect(contexts[0].close).toHaveBeenCalled();
  });

  it('offers only camera, microphone and sound: no browser-notification row', () => {
    setDevices(vi.fn(async () => fakeStream()));
    renderWithClient(<DeviceChecks />);
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual([
      'Camera',
      'Microphone',
      'Sound',
    ]);
    expect(screen.queryByText(/notification/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /notification/i })).toBeNull();
  });
});

describe('DeviceSetupPrompt', () => {
  it('"Set up later" hides it for this account only, and keeps no permission claim', async () => {
    routeFetch({ 'GET /auth/me': json(200, customer) });
    const first = renderWithClient(<DeviceSetupPrompt />);
    expect(await screen.findByRole('heading', { name: /Set up your For After experience/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Set up later' }));
    expect(screen.queryByRole('heading', { name: /Set up your For After/ })).toBeNull();
    expect(localStorage.getItem('for-after:device-setup:u1')).toBe('later');
    first.unmount();

    // Same account again: stays hidden.
    renderWithClient(<DeviceSetupPrompt />);
    await act(async () => {});
    expect(screen.queryByRole('heading', { name: /Set up your For After/ })).toBeNull();
  });

  it('another account on the same browser still sees its own prompt; "Done" is remembered too', async () => {
    localStorage.setItem('for-after:device-setup:u1', 'done');
    routeFetch({ 'GET /auth/me': json(200, { ...customer, id: 'u2' }) });
    renderWithClient(<DeviceSetupPrompt />);
    expect(await screen.findByRole('heading', { name: /Set up your For After experience/ })).toBeInTheDocument();
    expect(screen.queryByText(/notification/i)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(localStorage.getItem('for-after:device-setup:u2')).toBe('done');
    // Finishing needs no notification permission and never asks for it.
    expect(requestPermission).not.toHaveBeenCalled();
  });
});
