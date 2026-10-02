'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { Copy, KeyRound, ShieldCheck, Smartphone } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { QRCodeSVG } from 'qrcode.react';
import { useEffect, useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { ADMIN_HOME, ADMIN_LOGIN } from '@/components/admin/admin-shell';
import { linkClass } from '@/components/admin/admin-ui';
import { CodeField } from '@/components/shared/code-field';
import { FormError, PasswordField, TextField } from '@/components/shared/form-field';
import { Spinner } from '@/components/shared/states';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  useAdminLogin,
  useRecoveryVerify,
  useStartAdminSession,
  useTotpConfirm,
  useTotpSetup,
  useTotpVerify,
  type StoredChallenge,
} from '@/hooks/use-admin';
import { adminKeys } from '@/lib/query/query-client';
import { loginSchema, type LoginValues } from '@/schemas/auth';

export const MFA_SETUP = '/admin/mfa/setup';
export const MFA_VERIFY = '/admin/mfa/verify';

function Intro({ eyebrow = 'Admin Portal', title, children }: { eyebrow?: string; title: ReactNode; children?: ReactNode }) {
  return (
    <div className="grid gap-3">
      <p className="eyebrow">{eyebrow}</p>
      <h1 className="text-[40px] leading-[1.05]">{title}</h1>
      {children && <div className="text-foreground-muted">{children}</div>}
    </div>
  );
}

const StartAgain = ({ label = 'Start again' }: { label?: string }) => (
  <Link href={ADMIN_LOGIN} className={linkClass}>
    {label}
  </Link>
);

// ─── Password ───────────────────────────────────────────────────────────────

/**
 * Step 1 of 2. A correct admin password never opens the portal by itself: the
 * API answers with a TOTP challenge (no session), and this form moves on to
 * the second factor. Wrong password and unknown email get the same answer.
 */
export function AdminLoginForm() {
  const router = useRouter();
  const qc = useQueryClient();
  const login = useAdminLogin();
  // Set when the API ended a session (idle timeout, suspension, …). Read once.
  const [expired] = useState(() => !!qc.getQueryData(adminKeys.expired));
  useEffect(() => qc.removeQueries({ queryKey: adminKeys.expired }), [qc]);
  const form = useForm<LoginValues>({ resolver: zodResolver(loginSchema), defaultValues: { email: '', password: '' } });
  const { errors } = form.formState;

  const onSubmit = form.handleSubmit((values) => {
    if (login.isPending) return;
    login.mutate(values, {
      onSuccess: (result) => {
        form.resetField('password');
        if (result.kind === 'mfa') router.push(result.challenge.mfaSetupRequired ? MFA_SETUP : MFA_VERIFY);
      },
      onError: () => form.resetField('password'),
    });
  });

  return (
    <div className="grid gap-8">
      <Intro title={<>Sign in to <em>For After</em> admin</>}>
        For the For After team only. You&apos;ll confirm with your authenticator app after your password.
      </Intro>
      <form onSubmit={onSubmit} noValidate className="grid gap-5">
        {expired && (
          <Alert>
            <AlertTitle>Session ended</AlertTitle>
            <AlertDescription>Your admin session expired. Please sign in again.</AlertDescription>
          </Alert>
        )}
        {login.data?.kind === 'not_admin' && (
          <Alert>
            <AlertTitle>Not an administrator account</AlertTitle>
            <AlertDescription>
              <p>
                This account doesn&apos;t have administrator access.{' '}
                <Link href="/login" className={linkClass}>
                  Customer sign-in
                </Link>
              </p>
            </AlertDescription>
          </Alert>
        )}
        <FormError error={login.error} />
        <fieldset disabled={login.isPending} className="grid gap-5">
          <TextField
            id="email"
            label="Email"
            type="email"
            autoComplete="username"
            inputMode="email"
            error={errors.email?.message}
            {...form.register('email')}
          />
          <PasswordField
            id="password"
            label="Password"
            autoComplete="current-password"
            error={errors.password?.message}
            {...form.register('password')}
          />
        </fieldset>
        <Button type="submit" size="lg" className="w-full" disabled={login.isPending}>
          {login.isPending && <Spinner />}
          {login.isPending ? 'Checking…' : 'Continue'}
        </Button>
      </form>
    </div>
  );
}

// ─── Challenge ──────────────────────────────────────────────────────────────

/** The password step's challenge, from memory only. Refresh loses it on purpose. */
function useChallenge() {
  const qc = useQueryClient();
  const [challenge] = useState(() => qc.getQueryData<StoredChallenge>(adminKeys.challenge));
  return challenge;
}

function NoChallenge() {
  return (
    <div className="grid gap-6">
      <Intro title="Please sign in again">
        This step has expired or was interrupted. For your security it can&apos;t be resumed after a refresh.
      </Intro>
      <Button asChild size="lg">
        <Link href={ADMIN_LOGIN}>Back to sign in</Link>
      </Button>
    </div>
  );
}

const SIX_DIGITS = 'Enter the 6 digits shown in your authenticator app.';

// ─── First-time enrollment ──────────────────────────────────────────────────

/**
 * Password → setup (secret + otpauth URI, shown once) → first code → recovery
 * codes (shown once) → portal. Nothing here is stored anywhere: the secret and
 * codes live only in this component's memory and are gone when it unmounts.
 */
export function MfaSetup() {
  const challenge = useChallenge();
  const setup = useTotpSetup();
  const confirm = useTotpConfirm();
  const [code, setCode] = useState('');
  const [invalid, setInvalid] = useState(false);

  if (!challenge) return <NoChallenge />;
  if (!challenge.mfaSetupRequired) {
    return (
      <div className="grid gap-6">
        <Intro title="Two-factor is already set up" />
        <Button asChild size="lg">
          <Link href={MFA_VERIFY}>Enter your code</Link>
        </Button>
      </div>
    );
  }
  if (confirm.data) return <RecoveryCodes codes={confirm.data.recoveryCodes} />;

  const submit = () => {
    if (confirm.isPending || !setup.data) return;
    if (!/^\d{6}$/.test(code)) return setInvalid(true);
    confirm.mutate({ challengeId: challenge.challengeId, code }, { onSettled: () => setCode('') });
  };

  return (
    <div className="grid gap-8">
      <Intro eyebrow="Step 2 of 2 · First sign-in" title={<>Set up <em>two-factor</em> sign-in</>}>
        Every administrator signs in with a password and a code from an authenticator app (for example 1Password, Google
        Authenticator or Microsoft Authenticator).
      </Intro>

      {!setup.data ? (
        <div className="grid gap-5">
          <FormError error={setup.error} />
          <Button size="lg" disabled={setup.isPending} onClick={() => setup.mutate(challenge.challengeId)}>
            {setup.isPending ? <Spinner /> : <Smartphone aria-hidden strokeWidth={1.5} />}
            Set up my authenticator
          </Button>
          <p className="text-sm text-foreground-muted">
            <StartAgain label="Cancel and start again" />
          </p>
        </div>
      ) : (
        <>
          <section aria-labelledby="scan-heading" className="grid gap-5 rounded-xl border border-border bg-surface p-6">
            <h2 id="scan-heading" className="text-2xl">
              1. Add For After to your app
            </h2>
            <p className="text-[15px] text-foreground-secondary">Scan this QR code with your authenticator app.</p>
            {/* Rendered here in the browser: the secret is never sent to a QR service. */}
            <div className="mx-auto rounded-lg border border-border bg-white p-3">
              <QRCodeSVG
                value={setup.data.otpauthUri}
                size={184}
                level="M"
                role="img"
                aria-label="QR code for your authenticator app"
              />
            </div>
            <details className="group rounded-md bg-surface-muted p-4 text-sm">
              <summary className="cursor-pointer rounded-sm font-medium outline-none focus-visible:outline-2 focus-visible:outline-ring">
                Can&apos;t scan it? Enter a setup key instead
              </summary>
              <div className="mt-3 grid gap-3">
                <p className="text-foreground-muted">
                  Choose &ldquo;enter a setup key&rdquo; in your app, and use a time-based (TOTP) code. Treat this key like a
                  password: don&apos;t share it or keep it anywhere else.
                </p>
                <p className="font-mono text-base tracking-wider break-all select-all">
                  {setup.data.secret.match(/.{1,4}/g)?.join(' ')}
                </p>
                <CopyButton value={setup.data.secret} label="Copy setup key" />
              </div>
            </details>
          </section>

          <form
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
            className="grid gap-5"
          >
            <h2 className="text-2xl">2. Enter the code it shows</h2>
            <FormError error={confirm.error} />
            <CodeField
              value={code}
              disabled={confirm.isPending}
              error={invalid ? SIX_DIGITS : undefined}
              autoFocus={false}
              onChange={(digits) => {
                setInvalid(false);
                setCode(digits);
              }}
            />
            <Button type="submit" size="lg" disabled={confirm.isPending}>
              {confirm.isPending && <Spinner />}
              Confirm and continue
            </Button>
            <p className="text-sm text-foreground-muted">
              Code not accepted again and again? <StartAgain />
            </p>
          </form>
        </>
      )}
    </div>
  );
}

/**
 * Shown once, straight from the confirm response. Never stored (no storage,
 * no logs, no cache): leaving this screen is the last chance to save them.
 */
function RecoveryCodes({ codes }: { codes: string[] }) {
  const router = useRouter();
  const start = useStartAdminSession();
  const [saved, setSaved] = useState(false);
  return (
    <div className="grid gap-8">
      <Intro eyebrow="Two-factor is set up" title={<>Save your <em>recovery codes</em></>}>
        If you lose your authenticator, each of these codes lets you sign in once. This is the only time they&apos;ll be
        shown. Keep them somewhere safe and offline, like a password manager.
      </Intro>
      <section aria-labelledby="codes-heading" className="grid gap-4 rounded-xl border border-border bg-surface p-6">
        <h2 id="codes-heading" className="sr-only">
          Recovery codes
        </h2>
        <ol className="grid grid-cols-1 gap-2 font-mono text-[15px] sm:grid-cols-2">
          {codes.map((c) => (
            <li key={c} className="rounded-sm bg-surface-muted px-3 py-2 text-center tracking-wider">
              {c}
            </li>
          ))}
        </ol>
        <CopyButton value={codes.join('\n')} label="Copy all codes" />
      </section>
      <div className="grid gap-5">
        <label className="flex cursor-pointer items-start gap-3 text-[15px]">
          <input
            type="checkbox"
            checked={saved}
            onChange={(e) => setSaved(e.target.checked)}
            className="mt-1 size-4 accent-primary"
          />
          I&apos;ve saved these recovery codes somewhere safe.
        </label>
        <FormError error={start.error} />
        <Button
          size="lg"
          disabled={!saved || start.isPending}
          onClick={() => start.mutate(undefined, { onSuccess: () => router.replace(ADMIN_HOME) })}
        >
          {start.isPending && <Spinner />}
          Continue to the Admin Portal
        </Button>
      </div>
    </div>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="w-fit"
      onClick={() =>
        navigator.clipboard.writeText(value).then(
          () => toast('Copied'),
          () => toast("Couldn't copy. Select the text instead."),
        )
      }
    >
      <Copy aria-hidden strokeWidth={1.5} className="size-4" />
      {label}
    </Button>
  );
}

// ─── Returning admin ────────────────────────────────────────────────────────

const RECOVERY_CODE = /^(?:[A-Za-z0-9][\s-]?){16}$/;

/** Password → this: a TOTP code, or (lost device) one recovery code. */
export function MfaVerify() {
  const challenge = useChallenge();
  const router = useRouter();
  const verify = useTotpVerify();
  const recover = useRecoveryVerify();
  const [mode, setMode] = useState<'totp' | 'recovery'>('totp');
  const [code, setCode] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [invalid, setInvalid] = useState(false);

  if (!challenge) return <NoChallenge />;
  if (challenge.mfaSetupRequired) {
    return (
      <div className="grid gap-6">
        <Intro title="Two-factor isn't set up yet" />
        <Button asChild size="lg">
          <Link href={MFA_SETUP}>Set it up now</Link>
        </Button>
      </div>
    );
  }

  const pending = verify.isPending || recover.isPending;
  const submit = () => {
    if (pending) return;
    if (mode === 'totp') {
      if (!/^\d{6}$/.test(code)) return setInvalid(true);
      verify.mutate(
        { challengeId: challenge.challengeId, code },
        { onSuccess: () => router.replace(ADMIN_HOME), onSettled: () => setCode('') },
      );
    } else {
      if (!RECOVERY_CODE.test(recoveryCode.trim())) return setInvalid(true);
      recover.mutate(
        { challengeId: challenge.challengeId, recoveryCode: recoveryCode.trim() },
        {
          onSuccess: ({ remaining }) => {
            toast(`Signed in with a recovery code. ${remaining} left.`);
            router.replace(ADMIN_HOME);
          },
          onSettled: () => setRecoveryCode(''),
        },
      );
    }
  };
  const switchMode = () => {
    verify.reset();
    recover.reset();
    setInvalid(false);
    setMode(mode === 'totp' ? 'recovery' : 'totp');
  };

  return (
    <div className="grid gap-8">
      <Intro eyebrow="Step 2 of 2" title={<>Confirm it&apos;s <em>you</em></>}>
        {mode === 'totp' ? (
          <>Enter the 6-digit code from your authenticator app for {challenge.email}.</>
        ) : (
          <>Enter one of the recovery codes you saved when you set up two-factor. Each code works once.</>
        )}
      </Intro>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="grid gap-5"
      >
        <FormError error={mode === 'totp' ? verify.error : recover.error} />
        {mode === 'totp' ? (
          <CodeField
            value={code}
            disabled={pending}
            error={invalid ? SIX_DIGITS : undefined}
            onChange={(digits) => {
              setInvalid(false);
              setCode(digits);
            }}
          />
        ) : (
          <TextField
            id="recovery-code"
            label="Recovery code"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            autoFocus
            placeholder="XXXX-XXXX-XXXX-XXXX"
            className="font-mono tracking-wider"
            value={recoveryCode}
            disabled={pending}
            error={invalid ? 'Enter the 16-character recovery code, e.g. ABCD-EFGH-JKLM-NPQR.' : undefined}
            onChange={(e) => {
              setInvalid(false);
              setRecoveryCode(e.target.value);
            }}
          />
        )}
        <Button type="submit" size="lg" disabled={pending}>
          {pending ? <Spinner /> : <ShieldCheck aria-hidden strokeWidth={1.5} />}
          Verify and sign in
        </Button>
      </form>
      <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <button type="button" onClick={switchMode} className={`inline-flex items-center gap-2 ${linkClass}`}>
          <KeyRound aria-hidden strokeWidth={1.5} className="size-4" />
          {mode === 'totp' ? 'Lost your device? Use a recovery code' : 'Use my authenticator app instead'}
        </button>
        <StartAgain />
      </div>
    </div>
  );
}
