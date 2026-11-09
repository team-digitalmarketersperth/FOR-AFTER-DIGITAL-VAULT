'use client';

import { Camera, Mic, Volume2, type LucideIcon } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useCurrentUser } from '@/hooks/use-auth';

export const DEVICE_SETUP_HREF = '/settings/devices';

// Only the person's choice to hide the dashboard prompt, per account and per browser
// (device checks are per browser anyway). Never a claim that a permission is granted.
// shortcut: browser storage, so another browser shows the prompt once more; move to the API if that matters.
const dismissKey = (userId: string) => `for-after:device-setup:${userId}`;
const readDismissed = (userId: string) => {
  try {
    return !!localStorage.getItem(dismissKey(userId));
  } catch {
    return false;
  }
};

/** Dashboard prompt: shown until the person chooses "Set up later" or "Done" in this browser. */
export function DeviceSetupPrompt() {
  const { data: user } = useCurrentUser();
  // Per account: another person signing in on this browser still sees their own prompt.
  const [hiddenFor, setHiddenFor] = useState<string | null>(null);
  // The shell renders only in the browser after the session check, so storage is readable here.
  if (!user || hiddenFor === user.id || readDismissed(user.id)) return null;
  const close = (choice: 'later' | 'done') => {
    try {
      localStorage.setItem(dismissKey(user.id), choice);
    } catch {
      // Storage blocked: hide it for now; it may show again next visit.
    }
    setHiddenFor(user.id);
    toast('You can change these anytime in Account settings, under Devices.');
  };
  return (
    <section aria-labelledby="device-setup-heading" className="rounded-xl border border-border bg-surface p-6 sm:p-10">
      <DeviceSetupIntro headingId="device-setup-heading" />
      <DeviceChecks />
      <div className="mt-8 flex flex-wrap gap-3">
        <Button onClick={() => close('done')}>Done</Button>
        <Button variant="ghost" onClick={() => close('later')}>
          Set up later
        </Button>
      </div>
    </section>
  );
}

export function DeviceSetupIntro({ headingId, as: Heading = 'h2' }: { headingId: string; as?: 'h1' | 'h2' }) {
  return (
    <div className="mb-8 grid gap-2">
      <p className="eyebrow">Optional</p>
      <Heading id={headingId} className="text-3xl sm:text-[34px] sm:leading-tight">
        Set up your For After <em>experience</em>
      </Heading>
      <p className="max-w-2xl text-foreground-muted">
        Choose the features you&apos;d like to use. You can change these settings later. Nothing is recorded, saved or
        uploaded during these checks.
      </p>
    </div>
  );
}

/** The three rows. Each asks the browser for one thing, only when its own button is pressed. */
export function DeviceChecks() {
  return (
    <ul className="grid gap-4">
      <li>
        <MediaCheck kind="camera" />
      </li>
      <li>
        <MediaCheck kind="microphone" />
      </li>
      <li>
        <SoundCheck />
      </li>
    </ul>
  );
}

function Row({
  icon: Icon,
  title,
  purpose,
  status,
  action,
  children,
}: {
  icon: LucideIcon;
  title: string;
  purpose: string;
  status: string;
  action: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="grid gap-4 rounded-lg border border-border bg-background p-5 sm:p-6">
      <div className="flex flex-wrap items-start gap-4">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-primary-soft text-primary">
          <Icon aria-hidden strokeWidth={1.5} className="size-5" />
        </span>
        <div className="grid min-w-0 flex-1 basis-56 gap-1">
          <h3 className="text-xl leading-tight">{title}</h3>
          <p className="text-sm text-foreground-muted">{purpose}</p>
          <p role="status" className="text-sm font-medium text-foreground-secondary">
            <span className="sr-only">{title}: </span>
            {status}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">{action}</div>
      </div>
      {children}
    </div>
  );
}

type Permission = 'granted' | 'denied' | 'prompt' | null; // null = cannot tell
type Phase =
  | { at: 'idle' }
  | { at: 'pending' }
  | { at: 'live'; stream: MediaStream }
  | { at: 'checked' }
  | { at: 'error'; status: string; help: string };

const MEDIA = {
  camera: {
    title: 'Camera',
    purpose: 'Used when you record a video message. The check shows a preview on this device only.',
    constraints: { video: true },
    action: 'Check camera',
  },
  microphone: {
    title: 'Microphone',
    purpose: 'Used when you record your voice or a video. The check shows a sound level only; nothing is played back.',
    constraints: { audio: true },
    action: 'Check microphone',
  },
} as const;
type MediaKind = keyof typeof MEDIA;

const SITE_SETTINGS =
  'To change this, open your browser’s site settings for For After (often the icon beside the web address) and allow it, then try again.';

// Calm, specific wording; the browser's own error text is never shown.
export function mediaError(kind: MediaKind, error: unknown, permission: Permission) {
  const name = error instanceof DOMException ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    // NotAllowedError also covers a closed prompt or a system-level block, so only say "blocked" when the browser says so.
    return permission === 'denied'
      ? { status: 'Blocked in this browser', help: SITE_SETTINGS }
      : {
          status: 'Not allowed',
          help: `Access to your ${kind} wasn’t allowed. If you closed the browser’s question, you can try again. It may also be turned off in your device’s privacy settings. ${SITE_SETTINGS}`,
        };
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return { status: `No ${kind} found`, help: `Connect a ${kind}, then try again.` };
  }
  if (name === 'NotReadableError' || name === 'AbortError') {
    return { status: 'In use by another app', help: `Close any other app using your ${kind}, then try again.` };
  }
  return { status: 'Couldn’t start', help: 'Please try again.' };
}

/** null when this page can't use the device at all (no API, or not a secure connection). */
function mediaUnavailable() {
  if (typeof window === 'undefined') return null;
  if (!window.isSecureContext) return 'This needs a secure (https) connection.';
  if (!navigator.mediaDevices?.getUserMedia) return 'Not available in this browser.';
  return null;
}

// Read-only: the Permissions API never prompts. Unsupported names (e.g. Firefox, Safari) reject → null.
function usePermission(name: MediaKind, refreshKey: unknown): Permission {
  const [state, setState] = useState<Permission>(null);
  useEffect(() => {
    let status: PermissionStatus | null = null;
    let alive = true;
    const update = () => {
      if (alive && status) setState(status.state as Permission);
    };
    navigator.permissions
      ?.query({ name: name as PermissionName })
      .then((s) => {
        status = s;
        update();
        s.addEventListener('change', update);
      })
      .catch(() => alive && setState(null));
    return () => {
      alive = false;
      status?.removeEventListener('change', update);
    };
  }, [name, refreshKey]);
  return state;
}

const stopAll = (stream: MediaStream | null | undefined) => stream?.getTracks().forEach((t) => t.stop());

function MediaCheck({ kind }: { kind: MediaKind }) {
  const media = MEDIA[kind];
  const [unavailable] = useState(mediaUnavailable);
  const [phase, setPhase] = useState<Phase>({ at: 'idle' });
  const permission = usePermission(kind, phase.at);
  // Bumped on every start/stop/unmount: a request that resolves later stops its tracks at once.
  const attempt = useRef(0);
  const live = useRef<MediaStream | null>(null);

  useEffect(
    () => () => {
      attempt.current++;
      stopAll(live.current);
    },
    [],
  );

  const start = async () => {
    const mine = ++attempt.current;
    setPhase({ at: 'pending' });
    try {
      const stream = await navigator.mediaDevices.getUserMedia(media.constraints);
      if (mine !== attempt.current) return stopAll(stream);
      live.current = stream;
      // Unplugged or revoked mid-check.
      stream.getTracks().forEach((t) => (t.onended = () => mine === attempt.current && finish()));
      setPhase({ at: 'live', stream });
    } catch (error) {
      if (mine !== attempt.current) return;
      setPhase({ at: 'error', ...mediaError(kind, error, permission) });
    }
  };
  const finish = (to: Phase = { at: 'checked' }) => {
    attempt.current++;
    stopAll(live.current);
    live.current = null;
    setPhase(to);
  };

  const status = unavailable
    ? unavailable
    : phase.at === 'pending'
      ? 'Waiting for your browser… Answer its question to continue.'
      : phase.at === 'live'
        ? kind === 'camera'
          ? 'Working. Your camera is on for this check only.'
          : 'Your microphone is on for this check only.'
        : phase.at === 'checked'
          ? 'Working. Checked just now and turned off.'
          : phase.at === 'error'
            ? phase.status
            : permission === 'granted'
              ? 'Allowed in this browser'
              : permission === 'denied'
                ? 'Blocked in this browser'
                : 'Not checked';

  const action = unavailable ? null : phase.at === 'pending' ? (
    <Button variant="outline" onClick={() => finish({ at: 'idle' })}>
      Cancel
    </Button>
  ) : phase.at === 'live' ? (
    <Button variant="outline" onClick={() => finish()}>
      Finish check
    </Button>
  ) : (
    <Button variant="outline" onClick={start}>
      {phase.at === 'error' || phase.at === 'checked' ? 'Check again' : media.action}
    </Button>
  );

  return (
    <Row icon={kind === 'camera' ? Camera : Mic} title={media.title} purpose={media.purpose} status={status} action={action}>
      {phase.at === 'error' && <p className="text-sm text-foreground-secondary">{phase.help}</p>}
      {phase.at === 'idle' && permission === 'denied' && !unavailable && (
        <p className="text-sm text-foreground-secondary">{SITE_SETTINGS}</p>
      )}
      {phase.at === 'live' &&
        (kind === 'camera' ? (
          <video
            ref={(v) => {
              if (v && v.srcObject !== phase.stream) v.srcObject = phase.stream;
            }}
            autoPlay
            muted
            playsInline
            aria-label="Camera preview, shown on this device only. Nothing is recorded."
            className="aspect-video max-h-72 w-full max-w-md rounded-md bg-black object-contain"
          />
        ) : (
          <InputLevel stream={phase.stream} />
        ))}
    </Row>
  );
}

const audioContextClass = () =>
  typeof window === 'undefined'
    ? undefined
    : (window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);

/** A local level meter. The analyser is never connected to the speakers. */
function InputLevel({ stream }: { stream: MediaStream }) {
  const [level, setLevel] = useState(0);
  const [heard, setHeard] = useState(false);
  const [Ctx] = useState(audioContextClass);
  useEffect(() => {
    if (!Ctx) return;
    const ctx = new Ctx();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const data = new Uint8Array(analyser.fftSize);
    let frame = 0;
    const tick = () => {
      analyser.getByteTimeDomainData(data);
      let peak = 0;
      for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
      const pct = Math.min(100, Math.round((peak / 128) * 160));
      setLevel(pct);
      if (pct > 12) setHeard(true);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      void ctx.close().catch(() => undefined);
    };
  }, [stream, Ctx]);

  if (!Ctx) return <p className="text-sm text-foreground-secondary">Your microphone is connected.</p>;
  return (
    <div className="grid max-w-md gap-2">
      <div aria-hidden className="h-2 overflow-hidden rounded-full bg-brand-lilac-grey">
        <div className="h-full rounded-full bg-primary transition-[width] duration-75" style={{ width: `${level}%` }} />
      </div>
      <p aria-live="polite" className="text-sm text-foreground-secondary">
        {heard ? 'Sound detected. Your microphone is working.' : 'Say something to see the level move.'}
      </p>
    </div>
  );
}

function SoundCheck() {
  const [Ctx] = useState(audioContextClass);
  const [state, setState] = useState<'idle' | 'playing' | 'played' | 'failed'>('idle');
  const ctx = useRef<AudioContext | null>(null);

  const stop = (next: typeof state = 'idle') => {
    const c = ctx.current;
    ctx.current = null;
    void c?.close().catch(() => undefined);
    setState(next);
  };
  useEffect(
    () => () => {
      void ctx.current?.close().catch(() => undefined);
      ctx.current = null;
    },
    [],
  );

  // A short, quiet tone made on this device: no file, no autoplay (only from a click).
  const play = async () => {
    stop('playing');
    try {
      const c = new Ctx!();
      ctx.current = c;
      await c.resume();
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.frequency.value = 523.25;
      gain.gain.setValueAtTime(0.0001, c.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.08, c.currentTime + 0.05);
      gain.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 1.2);
      osc.connect(gain).connect(c.destination);
      osc.onended = () => ctx.current === c && stop('played');
      osc.start();
      osc.stop(c.currentTime + 1.25);
    } catch {
      stop('failed');
    }
  };

  const status = !Ctx
    ? 'Not available in this browser.'
    : {
        idle: 'Not checked',
        playing: 'Playing a short test sound…',
        played: 'Played. If you didn’t hear it, check your volume and which speakers or headphones are selected.',
        failed: 'The test sound couldn’t play. Check your volume, then try again.',
      }[state];

  return (
    <Row
      icon={Volume2}
      title="Sound"
      purpose="So you can hear voice and video messages. Plays a brief, quiet tone through your current speakers."
      status={status}
      action={
        !Ctx ? null : state === 'playing' ? (
          <Button variant="outline" onClick={() => stop()}>
            Stop sound
          </Button>
        ) : (
          <Button variant="outline" onClick={play}>
            Play test sound
          </Button>
        )
      }
    />
  );
}
