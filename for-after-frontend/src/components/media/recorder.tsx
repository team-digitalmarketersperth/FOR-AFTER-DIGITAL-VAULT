'use client';

import { Circle, Mic, RotateCcw, Square, Upload, Video, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { checkFile, MAX_BYTES } from '@/lib/api/media';
import { formatBytes } from '@/lib/format';

// Per kind: what to ask the browser for, and the recording formats the backend
// accepts (recorder type → the plain type uploaded; same container, no renaming),
// best first. Chrome/Firefox/Edge record WebM; Safari records MP4.
const SETUP = {
  AUDIO: {
    constraints: { audio: true },
    formats: [
      { recorder: 'audio/webm;codecs=opus', upload: 'audio/webm', ext: 'webm' },
      { recorder: 'audio/webm', upload: 'audio/webm', ext: 'webm' },
      { recorder: 'audio/mp4', upload: 'audio/mp4', ext: 'm4a' },
    ],
    device: 'microphone',
    other: 'an audio file',
    record: 'Record your voice',
    hint: 'Your microphone is only used while recording.',
    review: 'Listen back before using it',
  },
  VIDEO: {
    // The front camera on phones; the default camera elsewhere.
    constraints: { audio: true, video: { facingMode: 'user' } },
    formats: [
      { recorder: 'video/webm;codecs=vp9,opus', upload: 'video/webm', ext: 'webm' },
      { recorder: 'video/webm;codecs=vp8,opus', upload: 'video/webm', ext: 'webm' },
      { recorder: 'video/webm', upload: 'video/webm', ext: 'webm' },
      { recorder: 'video/mp4', upload: 'video/mp4', ext: 'mp4' },
    ],
    device: 'camera and microphone',
    other: 'a video file',
    record: 'Record a video',
    hint: 'Your camera and microphone are only used while this recorder is open.',
    review: 'Watch it back before using it',
  },
} as const;

type Kind = keyof typeof SETUP;
type Format = (typeof SETUP)[Kind]['formats'][number];

/** null when this browser cannot record a format the backend will accept. */
export function pickFormat(kind: Kind): Format | null {
  if (typeof window === 'undefined' || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    return null;
  }
  return SETUP[kind].formats.find((c) => MediaRecorder.isTypeSupported(c.recorder)) ?? null;
}

type State =
  | { phase: 'idle' }
  | { phase: 'starting' }
  | { phase: 'ready' } // VIDEO only: live camera, not yet recording
  | { phase: 'recording'; seconds: number; bytes: number }
  | { phase: 'recorded'; file: File; url: string; seconds: number; problem: string | null }
  | { phase: 'error'; message: string };

const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

// Calm, specific wording; the browser's own error text is never shown.
function deviceError(kind: Kind, error: unknown) {
  const { device, other } = SETUP[kind];
  const name = error instanceof DOMException ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return `Access to your ${device} was not allowed. You can allow it in your browser’s site settings, then try again, or upload ${other} instead.`;
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return `No ${device} was found. Connect one, or upload ${other} instead.`;
  }
  if (name === 'NotReadableError') {
    return `Your ${device} is being used by another app. Close it and try again.`;
  }
  return `Recording could not start. You can upload ${other} instead.`;
}

/**
 * Records in the browser only after an explicit click. Nothing is uploaded
 * until the person plays it back and chooses "Use this recording"; the file
 * then goes through the normal upload (onUse). Kept in memory only. Video asks
 * for camera and microphone together, so a video always has sound.
 */
export function Recorder({ kind, onUse, disabled }: { kind: Kind; onUse: (file: File) => void; disabled?: boolean }) {
  const setup = SETUP[kind];
  const [format] = useState(() => pickFormat(kind));
  const [state, setState] = useState<State>({ phase: 'idle' });
  const stream = useRef<MediaStream | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const url = useRef<string | null>(null);

  const release = () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
  };
  const revoke = () => {
    if (url.current) URL.revokeObjectURL(url.current);
    url.current = null;
  };

  // Unmount (incl. leaving the page): stop recording, release the devices, free the preview.
  useEffect(
    () => () => {
      if (recorder.current?.state === 'recording') {
        recorder.current.ondataavailable = null;
        recorder.current.onstop = null;
        recorder.current.stop();
      }
      release();
      revoke();
    },
    [],
  );

  if (!format) {
    return (
      <p className="rounded-md bg-surface-muted px-4 py-3 text-sm text-foreground-secondary">
        Recording isn&apos;t available in this browser. You can upload {setup.other} instead.
      </p>
    );
  }

  const record = () => {
    const chunks: Blob[] = [];
    const rec = new MediaRecorder(stream.current!, { mimeType: format.recorder });
    recorder.current = rec;
    let seconds = 0;
    let bytes = 0;
    rec.ondataavailable = (e) => {
      if (!e.data.size) return;
      chunks.push(e.data);
      bytes += e.data.size;
    };
    rec.onstop = () => {
      release();
      // Uploaded with the plain MIME type the backend allowlists.
      const file = new File(chunks, `recording-${new Date().toISOString().slice(0, 16).replace(':', '')}.${format.ext}`, {
        type: format.upload,
      });
      revoke();
      url.current = URL.createObjectURL(file);
      setState({ phase: 'recorded', file, url: url.current, seconds, problem: checkFile(kind, file) });
    };
    // Data every second, so the size so far can be shown.
    rec.start(1000);
    setState({ phase: 'recording', seconds: 0, bytes: 0 });
    timer.current = setInterval(() => {
      seconds += 1;
      setState({ phase: 'recording', seconds, bytes });
    }, 1000);
  };

  const open = async () => {
    revoke();
    setState({ phase: 'starting' });
    try {
      stream.current = await navigator.mediaDevices.getUserMedia(setup.constraints);
    } catch (error) {
      release();
      setState({ phase: 'error', message: deviceError(kind, error) });
      return;
    }
    // Permission revoked or device unplugged: keep what was recorded, else explain.
    stream.current.getTracks().forEach((t) => {
      t.onended = () => {
        if (recorder.current?.state === 'recording') return recorder.current.stop();
        release();
        setState({ phase: 'error', message: `Your ${setup.device} stopped. Please try again.` });
      };
    });
    if (kind === 'VIDEO') setState({ phase: 'ready' });
    else record();
  };

  const stop = () => recorder.current?.stop();
  const close = () => {
    release();
    revoke();
    setState({ phase: 'idle' });
  };

  const live = state.phase === 'ready' || state.phase === 'recording';
  return (
    <div className="grid gap-4 rounded-lg border border-border bg-surface-muted p-5">
      {kind === 'VIDEO' && live && (
        <video
          ref={(v) => {
            if (v && v.srcObject !== stream.current) v.srcObject = stream.current;
          }}
          autoPlay
          muted
          playsInline
          aria-label="Camera preview"
          className="aspect-video max-h-[60vh] w-full rounded-md bg-black object-contain"
        />
      )}
      {state.phase === 'ready' ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" onClick={record}>
            <Circle aria-hidden strokeWidth={1.5} className="size-4 fill-current" />
            Start recording
          </Button>
          <Button type="button" variant="ghost" onClick={close}>
            <X aria-hidden strokeWidth={1.5} />
            Cancel
          </Button>
          <span role="status" className="text-sm text-foreground-secondary">
            Camera and microphone on. Not recording yet.
          </span>
        </div>
      ) : state.phase === 'recording' ? (
        <div className="flex flex-wrap items-center gap-4">
          <span role="status" className="inline-flex items-center gap-2 font-medium text-danger">
            <span aria-hidden className="size-2.5 animate-pulse rounded-full bg-danger" />
            Recording <span className="tabular-nums">{clock(state.seconds)}</span>
            {kind === 'VIDEO' && (
              <span className="font-normal text-foreground-secondary tabular-nums">
                · {formatBytes(state.bytes)} of {formatBytes(MAX_BYTES[kind])}
              </span>
            )}
          </span>
          <Button type="button" variant="outline" onClick={stop}>
            <Square aria-hidden strokeWidth={1.5} className="size-4 fill-current" />
            Stop
          </Button>
        </div>
      ) : state.phase === 'recorded' ? (
        <div className="grid gap-4">
          <p className="text-sm text-foreground-secondary">
            {setup.review} ({clock(state.seconds)}, {formatBytes(state.file.size)}).
          </p>
          {kind === 'VIDEO' ? (
            <video
              controls
              playsInline
              src={state.url}
              aria-label="Your recording"
              className="aspect-video max-h-[60vh] w-full rounded-md bg-black object-contain"
            />
          ) : (
            <audio controls src={state.url} className="w-full" aria-label="Your recording" />
          )}
          {state.problem && (
            <p role="alert" className="text-sm text-danger">
              {state.problem} Please record a shorter one.
            </p>
          )}
          <div className="flex flex-wrap gap-3">
            <Button type="button" disabled={disabled || Boolean(state.problem)} onClick={() => onUse(state.file)}>
              <Upload aria-hidden strokeWidth={1.5} />
              Use this recording
            </Button>
            <Button type="button" variant="outline" disabled={disabled} onClick={open}>
              <RotateCcw aria-hidden strokeWidth={1.5} />
              Record again
            </Button>
            <Button type="button" variant="ghost" disabled={disabled} onClick={close}>
              <X aria-hidden strokeWidth={1.5} />
              Discard
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-4">
          <Button type="button" variant="outline" disabled={disabled || state.phase === 'starting'} onClick={open}>
            {kind === 'VIDEO' ? <Video aria-hidden strokeWidth={1.5} /> : <Mic aria-hidden strokeWidth={1.5} />}
            {state.phase === 'starting' ? `Waiting for your ${setup.device}…` : setup.record}
          </Button>
          <span className="text-sm text-foreground-muted">{setup.hint}</span>
        </div>
      )}
      {state.phase === 'error' && (
        <p role="alert" className="text-sm text-danger">
          {state.message}
        </p>
      )}
    </div>
  );
}
