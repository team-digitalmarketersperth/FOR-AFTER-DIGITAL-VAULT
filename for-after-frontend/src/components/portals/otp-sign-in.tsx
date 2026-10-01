'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { MailCheck } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { PORTALS } from '@/components/portals/portal-shell';
import { FormError, TextField } from '@/components/shared/form-field';
import { Spinner } from '@/components/shared/states';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useRequestCode, useVerifyCode } from '@/hooks/use-portals';
import type { Portal } from '@/lib/query/query-client';

// UX pause before "send a new code"; the API's own rate limit is authoritative.
const RESEND_AFTER_SECONDS = 30;

const emailSchema = z.object({
  email: z.string().trim().min(1, 'Enter your email address.').pipe(z.email('Enter a valid email address.')),
});

/**
 * Email → 6-digit code, for either portal. The challenge id lives only in this
 * component's state (never storage or the URL); the code is never stored,
 * logged or pre-filled. Whether the email has access is never revealed: the
 * API answers every request the same way and we show its message.
 */
export function OtpSignIn({ portal, intro }: { portal: Portal; intro: ReactNode }) {
  const router = useRouter();
  const [challenge, setChallenge] = useState<{ id: string; email: string; message: string; sentAt: number } | null>(null);
  const request = useRequestCode(portal);
  const form = useForm<z.infer<typeof emailSchema>>({ resolver: zodResolver(emailSchema), defaultValues: { email: '' } });

  const send = (email: string) =>
    request.mutate(email, {
      onSuccess: (c) => setChallenge({ id: c.challengeId, email, message: c.message, sentAt: Date.now() }),
    });

  if (!challenge) {
    return (
      <div className="grid gap-8">
        {intro}
        <form
          noValidate
          onSubmit={form.handleSubmit((v) => !request.isPending && send(v.email.trim()))}
          className="grid gap-5"
        >
          <FormError error={request.error} />
          <fieldset disabled={request.isPending} className="grid gap-5">
            <TextField
              id="email"
              label="Email"
              type="email"
              inputMode="email"
              autoComplete="email"
              error={form.formState.errors.email?.message}
              {...form.register('email')}
            />
          </fieldset>
          <Button type="submit" size="lg" className="w-full" disabled={request.isPending}>
            {request.isPending && <Spinner />}
            Send me a code
          </Button>
        </form>
      </div>
    );
  }

  return (
    <CodeStep
      key={challenge.id}
      portal={portal}
      challenge={challenge}
      resending={request.isPending}
      resendError={request.error}
      onResend={() => send(challenge.email)}
      onChangeEmail={() => {
        request.reset();
        setChallenge(null);
      }}
      onSignedIn={() => router.replace(PORTALS[portal].home)}
    />
  );
}

function CodeStep({
  portal,
  challenge,
  resending,
  resendError,
  onResend,
  onChangeEmail,
  onSignedIn,
}: {
  portal: Portal;
  challenge: { id: string; email: string; message: string; sentAt: number };
  resending: boolean;
  resendError: Parameters<typeof FormError>[0]['error'];
  onResend: () => void;
  onChangeEmail: () => void;
  onSignedIn: () => void;
}) {
  const verify = useVerifyCode(portal);
  const [code, setCode] = useState('');
  const [invalid, setInvalid] = useState(false);
  const [wait, setWait] = useState(RESEND_AFTER_SECONDS);

  useEffect(() => {
    const timer = setInterval(() => {
      const left = RESEND_AFTER_SECONDS - Math.floor((Date.now() - challenge.sentAt) / 1000);
      setWait(Math.max(0, left));
      if (left <= 0) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [challenge.sentAt]);

  const submit = () => {
    if (verify.isPending) return;
    if (!/^\d{6}$/.test(code)) {
      setInvalid(true);
      return;
    }
    verify.mutate(
      { challengeId: challenge.id, code },
      // Either way the code is cleared: it is single use.
      { onSuccess: () => { setCode(''); onSignedIn(); }, onError: () => setCode('') },
    );
  };

  return (
    <div className="grid gap-8">
      <div className="flex gap-4 rounded-xl bg-primary-soft p-5">
        <MailCheck aria-hidden strokeWidth={1.5} className="mt-0.5 size-5 shrink-0 text-primary" />
        <div className="grid gap-1 text-[15px]">
          <p role="status">{challenge.message}</p>
          <p className="text-foreground-muted">
            Sent to <span className="font-medium text-foreground-secondary">{challenge.email}</span>. The code expires
            after a few minutes.
          </p>
        </div>
      </div>

      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="grid gap-5"
      >
        <FormError error={verify.error ?? resendError} />
        <div className="grid gap-2">
          <Label htmlFor="code">6-digit code</Label>
          <Input
            id="code"
            name="code"
            // One field (not six boxes): paste, autofill and screen readers just work.
            inputMode="numeric"
            autoComplete="one-time-code"
            // No maxLength: it would cut a pasted "123 456" before the spaces are
            // stripped. onChange keeps the first 6 digits instead.
            pattern="\d{6}"
            autoFocus
            value={code}
            aria-invalid={invalid ? true : undefined}
            aria-describedby={invalid ? 'code-error' : undefined}
            disabled={verify.isPending}
            onChange={(e) => {
              setInvalid(false);
              // Keep digits only, so "123 456" or "123-456" pastes cleanly.
              setCode(e.target.value.replace(/\D/g, '').slice(0, 6));
            }}
            className="h-14 text-center font-mono text-2xl tracking-[0.5em]"
          />
          {invalid && (
            <p id="code-error" className="text-sm text-danger">
              Enter the 6 digits from the email.
            </p>
          )}
        </div>
        <Button type="submit" size="lg" className="w-full" disabled={verify.isPending}>
          {verify.isPending && <Spinner />}
          Sign in
        </Button>
      </form>

      <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <button
          type="button"
          onClick={onChangeEmail}
          className="rounded-sm text-foreground-muted underline-offset-4 outline-none hover:underline focus-visible:outline-2 focus-visible:outline-ring"
        >
          Use a different email
        </button>
        {wait > 0 ? (
          <span className="text-foreground-muted" aria-live="polite">
            You can ask for a new code in {wait}s
          </span>
        ) : (
          <Button type="button" variant="link" disabled={resending} onClick={onResend}>
            Send a new code
          </Button>
        )}
      </div>
    </div>
  );
}

/** Shown under both portal sign-ins so nobody lands in the wrong one. */
export function WrongPlaceNote() {
  return (
    <p className="text-sm text-foreground-muted">
      Have your own For After account?{' '}
      <Link href="/login" className="rounded-sm font-semibold text-primary underline underline-offset-4 outline-none focus-visible:outline-2 focus-visible:outline-ring">
        Sign in here instead
      </Link>
    </p>
  );
}
