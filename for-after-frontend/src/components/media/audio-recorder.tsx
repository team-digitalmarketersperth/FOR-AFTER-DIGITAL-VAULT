'use client';

import { Mic, RotateCcw, Square, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';

// Browser formats the backend accepts (audio/webm, audio/mp4), best first.
// Chrome/Firefox/Edge record WebM/Opus; Safari records MP4/AAC.
const CANDIDATES = [
  { recorder: 'audio/webm;codecs=opus', upload: 'audio/webm', ext: 'webm' },
  { recorder: 'audio/webm', upload: 'audio/webm', ext: 'webm' },
  { recorder: 'audio/mp4', upload: 'audio/mp4', ext: 'm4a' },
] as const;

type Format = (typeof CANDIDATES)[number];

/** null when this browser cannot record a format the backend will accept. */
export function pickFormat(): Format | null {
  if (typeof window === 'undefined' || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    return null;
  }
  return CANDIDATES.find((c) => MediaRecorder.isTypeSupported(c.recorder)) ?? null;
}

type State =
  | { phase: 'idle' }
  | { phase: 'starting' }
  | { phase: 'recording'; seconds: number }
  | { phase: 'recorded'; file: File; url: string; seconds: number }
  | { phase: 'error'; message: string };

const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

function micError(error: unknown) {
  const name = error instanceof DOMException ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Microphone access was not allowed. You can allow it in your browser’s site settings, then try again.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return 'No microphone was found. Connect one, or upload an audio file instead.';
  }
  if (name === 'NotReadableError') {
    return 'Your microphone is being used by another app. Close it and try again.';
  }
  return 'Recording could not start. You can upload an audio file instead.';
}

/**
 * Records in the browser only after an explicit click. Nothing is uploaded
 * until the person listens back and chooses "Use this recording".
 */
export function AudioRecorder({ onUse, disabled }: { onUse: (file: File) => void; disabled?: boolean }) {
  const [format] = useState(pickFormat);
  const [state, setState] = useState<State>({ phase: 'idle' });
  const stream = useRef<MediaStream | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const url = useRef<string | null>(null);

  const releaseMic = () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
  };
  const revoke = () => {
    if (url.current) URL.revokeObjectURL(url.current);
    url.current = null;
  };

  // Unmount: stop recording, release the microphone, free the preview.
  useEffect(
    () => () => {
      if (recorder.current?.state === 'recording') {
        recorder.current.ondataavailable = null;
        recorder.current.onstop = null;
        recorder.current.stop();
      }
      releaseMic();
      revoke();
    },
    [],
  );

  if (!format) {
    return (
      <p className="rounded-md bg-surface-muted px-4 py-3 text-sm text-foreground-secondary">
        Recording isn&apos;t available in this browser. You can upload an audio file instead.
      </p>
    );
  }

  const start = async () => {
    setState({ phase: 'starting' });
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      releaseMic();
      setState({ phase: 'error', message: micError(error) });
      return;
    }
    const chunks: Blob[] = [];
    const rec = new MediaRecorder(stream.current, { mimeType: format.recorder });
    recorder.current = rec;
    let seconds = 0;
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => {
      releaseMic();
      // Uploaded with the plain MIME type the backend allowlists.
      const file = new File(chunks, `recording-${new Date().toISOString().slice(0, 16).replace(':', '')}.${format.ext}`, {
        type: format.upload,
      });
      revoke();
      url.current = URL.createObjectURL(file);
      setState({ phase: 'recorded', file, url: url.current, seconds });
    };
    rec.start();
    setState({ phase: 'recording', seconds: 0 });
    timer.current = setInterval(() => {
      seconds += 1;
      setState({ phase: 'recording', seconds });
    }, 1000);
  };

  const stop = () => recorder.current?.stop();
  const discard = () => {
    revoke();
    setState({ phase: 'idle' });
  };

  return (
    <div className="grid gap-4 rounded-lg border border-border bg-surface-muted p-5">
      {state.phase === 'recording' ? (
        <div className="flex flex-wrap items-center gap-4">
          <span role="status" className="inline-flex items-center gap-2 font-medium text-danger">
            <span aria-hidden className="size-2.5 animate-pulse rounded-full bg-danger" />
            Recording <span className="tabular-nums">{clock(state.seconds)}</span>
          </span>
          <Button type="button" variant="outline" onClick={stop}>
            <Square aria-hidden strokeWidth={1.5} className="size-4 fill-current" />
            Stop
          </Button>
        </div>
      ) : state.phase === 'recorded' ? (
        <div className="grid gap-4">
          <p className="text-sm text-foreground-secondary">
            Listen back before using it ({clock(state.seconds)}).
          </p>
          <audio controls src={state.url} className="w-full" aria-label="Your recording" />
          <div className="flex flex-wrap gap-3">
            <Button type="button" disabled={disabled} onClick={() => onUse(state.file)}>
              <Upload aria-hidden strokeWidth={1.5} />
              Use this recording
            </Button>
            <Button type="button" variant="ghost" onClick={discard}>
              <RotateCcw aria-hidden strokeWidth={1.5} />
              Discard
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-4">
          <Button type="button" variant="outline" disabled={disabled || state.phase === 'starting'} onClick={start}>
            <Mic aria-hidden strokeWidth={1.5} />
            {state.phase === 'starting' ? 'Waiting for microphone…' : 'Record your voice'}
          </Button>
          <span className="text-sm text-foreground-muted">Your microphone is only used while recording.</span>
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
