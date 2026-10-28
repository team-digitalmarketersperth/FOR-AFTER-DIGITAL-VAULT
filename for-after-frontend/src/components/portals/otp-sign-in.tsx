'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { MailCheck, MessageSquareText } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { PORTALS } from '@/components/portals/portal-shell';
import { CodeField } from '@/components/shared/code-field';
import { FormError, TextField } from '@/components/shared/form-field';
import { Spinner } from '@/components/shared/states';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { useRequestCode, useRequestSmsCode, useVerifyCode, useVerifySmsCode } from '@/hooks/use-portals';
import type { Portal } from '@/lib/query/query-client';
import { cn } from '@/lib/utils';

// UX pause before "send a new code"; the API's own rate limit is authoritative.
const RESEND_AFTER_SECONDS = 30;

const emailSchema = z.object({
  email: z.string().trim().min(1, 'Enter your email address.').pipe(z.email('Enter a valid email address.')),
});

// ponytail: a short list for where Recipients are expected; a number typed with
// its own "+country code" works for anywhere else.
const COUNTRIES = [
  { dial: '+61', name: 'Australia' },
  { dial: '+64', name: 'New Zealand' },
  { dial: '+91', name: 'India' },
  { dial: '+44', name: 'United Kingdom' },
  { dial: '+1', name: 'United States / Canada' },
];

/** Country code + national number → E.164 (the API checks it again). */
export const toE164 = (dial: string, number: string) => {
  const digits = number.replace(/[\s().-]/g, '');
  // A leading 0 is the national trunk prefix (0412 → +61 412).
  return digits.startsWith('+') ? digits : dial + digits.replace(/^0/, '');
};
const E164 = /^\+[1-9]\d{6,14}$/;

const mobileSchema = z
  .object({ dial: z.string(), number: z.string().trim().min(1, 'Enter your mobile number.') })
  .refine((v) => E164.test(toE164(v.dial, v.number)), {
    path: ['number'],
    message: 'Enter a valid mobile number.',
  });

/** Shown after sending: +61 ••• ••• 678, never the full number. */
const maskMobile = (mobile: string, dial: string) =>
  `${mobile.startsWith(dial) ? dial : mobile.slice(0, 3)} ••• ••• ${mobile.slice(-3)}`;

type Channel = 'email' | 'sms';
type Sent =
  | { channel: 'email'; id: string; email: string; message: string; sentAt: number }
  | { channel: 'sms'; mobile: string; masked: string; message: string; sentAt: number };

/**
 * Email (or, for Recipients, mobile) → 6-digit code, for either portal. The
 * challenge id lives only in this component's state (never storage or the
 * URL); the code is never stored, logged or pre-filled. Whether the email or
 * mobile has access is never revealed: the API answers every request the same
 * way and we show its message. Both ways end in the same portal session.
 */
export function OtpSignIn({
  portal,
  intro,
  sms = false,
}: {
  portal: Portal;
  intro: ReactNode | ((channel: Channel) => ReactNode);
  /** Offer "Mobile" (SMS code through Twilio Verify) next to email. */
  sms?: boolean;
}) {
  const router = useRouter();
  const [channel, setChannel] = useState<Channel>('email');
  const [sent, setSent] = useState<Sent | null>(null);
  const request = useRequestCode(portal);
  const requestSms = useRequestSmsCode(portal);
  const form = useForm<z.infer<typeof emailSchema>>({ resolver: zodResolver(emailSchema), defaultValues: { email: '' } });

  const send = (email: string) =>
    request.mutate(email, {
      onSuccess: (c) => setSent({ channel: 'email', id: c.challengeId, email, message: c.message, sentAt: Date.now() }),
    });
  const sendSms = (mobile: string, masked: string) =>
    requestSms.mutate(mobile, {
      onSuccess: (r) => setSent({ channel: 'sms', mobile, masked, message: r.message, sentAt: Date.now() }),
    });

  if (!sent) {
    return (
      <div className="grid gap-8">
        {typeof intro === 'function' ? intro(channel) : intro}
        {sms && (
          <ChannelSwitch
            value={channel}
            onChange={(next) => {
              request.reset();
              requestSms.reset();
              setChannel(next);
            }}
          />
        )}
        {channel === 'sms' ? (
          <MobileForm pending={requestSms.isPending} error={requestSms.error} onSend={sendSms} />
        ) : (
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
        )}
      </div>
    );
  }

  return (
    <CodeStep
      key={sent.sentAt}
      portal={portal}
      sent={sent}
      resending={request.isPending || requestSms.isPending}
      resendError={request.error ?? requestSms.error}
      onResend={() => (sent.channel === 'sms' ? sendSms(sent.mobile, sent.masked) : send(sent.email))}
      onChange={() => {
        request.reset();
        requestSms.reset();
        setSent(null);
      }}
      onSignedIn={() => router.replace(PORTALS[portal].home)}
    />
  );
}

/**
 * Two toggle buttons (aria-pressed): Tab reaches both, the pressed one is announced.
 * Styled as quiet editorial navigation: text on a hairline, the active choice
 * marked by a maroon underline the width of its word (not by colour alone).
 */
function ChannelSwitch({ value, onChange }: { value: Channel; onChange: (channel: Channel) => void }) {
  return (
    <div role="group" aria-label="Sign in with" className="flex gap-10 border-b border-[#D8D0C7]">
      {(
        [
          ['email', 'Email'],
          ['sms', 'Mobile'],
        ] as const
      ).map(([channel, label]) => (
        <button
          key={channel}
          type="button"
          aria-pressed={value === channel}
          onClick={() => onChange(channel)}
          className={cn(
            // -mb-px: the underline sits on the hairline, not below it.
            'relative -mb-px cursor-pointer rounded-[2px] pt-1 pb-3 text-[15px] tracking-[0.01em] transition-colors duration-200 outline-none',
            // outline-none also clears the style, so focus sets it back to solid.
            'focus-visible:outline-1 focus-visible:outline-solid focus-visible:outline-offset-4 focus-visible:outline-[#632F3B]',
            'after:absolute after:inset-x-0 after:bottom-0 after:h-[1.5px] after:origin-left after:bg-[#632F3B] after:transition-transform after:duration-300 motion-reduce:after:transition-none',
            value === channel
              ? 'font-medium text-[#632F3B] after:scale-x-100'
              : 'font-normal text-foreground-muted after:scale-x-0 hover:text-foreground-secondary',
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function MobileForm({
  pending,
  error,
  onSend,
}: {
  pending: boolean;
  error: Parameters<typeof FormError>[0]['error'];
  onSend: (mobile: string, masked: string) => void;
}) {
  const form = useForm<z.infer<typeof mobileSchema>>({
    resolver: zodResolver(mobileSchema),
    defaultValues: { dial: COUNTRIES[0].dial, number: '' },
  });
  const numberError = form.formState.errors.number?.message;

  return (
    <form
      noValidate
      onSubmit={form.handleSubmit(({ dial, number }) => {
        if (pending) return;
        const mobile = toE164(dial, number);
        onSend(mobile, maskMobile(mobile, dial));
      })}
      className="grid gap-5"
    >
      <FormError error={error} />
      <fieldset disabled={pending} className="grid gap-2">
        <Label htmlFor="mobile">Mobile number</Label>
        <div className="grid grid-cols-[minmax(0,9.5rem)_1fr] gap-2">
          <select
            aria-label="Country code"
            className="h-11 min-w-0 rounded-sm border border-input bg-surface px-2.5 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/15"
            {...form.register('dial')}
          >
            {COUNTRIES.map((c) => (
              <option key={c.dial} value={c.dial}>
                {c.dial} {c.name}
              </option>
            ))}
          </select>
          <input
            id="mobile"
            type="tel"
            inputMode="tel"
            autoComplete="tel-national"
            placeholder="412 345 678"
            aria-invalid={numberError ? true : undefined}
            aria-describedby={numberError ? 'mobile-error' : undefined}
            className="h-11 w-full min-w-0 rounded-sm border border-input bg-surface px-3.5 text-base text-foreground outline-none placeholder:text-foreground-muted focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/15 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/15"
            {...form.register('number')}
          />
        </div>
        {numberError && (
          <p id="mobile-error" className="text-sm text-danger">
            {numberError}
          </p>
        )}
      </fieldset>
      <Button type="submit" size="lg" className="w-full" disabled={pending}>
        {pending && <Spinner />}
        Text me a code
      </Button>
      <p className="text-sm text-foreground-muted">
        By continuing, you agree to receive a verification code by SMS at the mobile number provided. Message and
        carrier rates may apply.
      </p>
    </form>
  );
}

function CodeStep({
  portal,
  sent,
  resending,
  resendError,
  onResend,
  onChange,
  onSignedIn,
}: {
  portal: Portal;
  sent: Sent;
  resending: boolean;
  resendError: Parameters<typeof FormError>[0]['error'];
  onResend: () => void;
  onChange: () => void;
  onSignedIn: () => void;
}) {
  const verify = useVerifyCode(portal);
  const verifySms = useVerifySmsCode(portal);
  const pending = verify.isPending || verifySms.isPending;
  const [code, setCode] = useState('');
  const [invalid, setInvalid] = useState(false);
  const [wait, setWait] = useState(RESEND_AFTER_SECONDS);
  const isSms = sent.channel === 'sms';

  useEffect(() => {
    const timer = setInterval(() => {
      const left = RESEND_AFTER_SECONDS - Math.floor((Date.now() - sent.sentAt) / 1000);
      setWait(Math.max(0, left));
      if (left <= 0) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [sent.sentAt]);

  const submit = () => {
    if (pending) return;
    if (!/^\d{6}$/.test(code)) {
      setInvalid(true);
      return;
    }
    // Either way the code is cleared: it is single use.
    const done = { onSuccess: () => { setCode(''); onSignedIn(); }, onError: () => setCode('') };
    if (sent.channel === 'sms') verifySms.mutate({ mobile: sent.mobile, code }, done);
    else verify.mutate({ challengeId: sent.id, code }, done);
  };

  const Icon = isSms ? MessageSquareText : MailCheck;
  return (
    <div className="grid gap-8">
      <div className="flex gap-4 rounded-xl bg-primary-soft p-5">
        <Icon aria-hidden strokeWidth={1.5} className="mt-0.5 size-5 shrink-0 text-primary" />
        <div className="grid gap-1 text-[15px]">
          {isSms && <p className="font-semibold text-foreground">Check your phone</p>}
          <p role="status">{sent.message}</p>
          <p className="text-foreground-muted">
            Sent to{' '}
            <span className="font-medium text-foreground-secondary">{isSms ? sent.masked : sent.email}</span>. The
            code expires after a few minutes.
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
        <FormError error={verify.error ?? verifySms.error ?? resendError} />
        <CodeField
          value={code}
          disabled={pending}
          error={invalid ? `Enter the 6 digits from the ${isSms ? 'text message' : 'email'}.` : undefined}
          onChange={(digits) => {
            setInvalid(false);
            setCode(digits);
          }}
        />
        <Button type="submit" size="lg" className="w-full" disabled={pending}>
          {pending && <Spinner />}
          Sign in
        </Button>
      </form>

      <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <button
          type="button"
          onClick={onChange}
          className="rounded-sm text-foreground-muted underline-offset-4 outline-none hover:underline focus-visible:outline-2 focus-visible:outline-ring"
        >
          {isSms ? 'Use a different mobile number' : 'Use a different email'}
        </button>
        {wait > 0 ? (
          <span className="text-foreground-muted" aria-live="polite">
            {isSms ? "Didn't receive it? " : ''}You can ask for a new code in {wait}s
          </span>
        ) : (
          <Button type="button" variant="link" disabled={resending} onClick={onResend}>
            {resending && <Spinner />}
            {isSms ? 'Resend code' : 'Send a new code'}
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
