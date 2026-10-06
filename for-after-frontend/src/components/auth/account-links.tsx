'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import Link from 'next/link';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { FormError, PasswordField, TextField } from '@/components/shared/form-field';
import { Spinner } from '@/components/shared/states';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  useConfirmEmailChange,
  useForgotPassword,
  useResendVerification,
  useResetPassword,
  useVerifyEmail,
} from '@/hooks/use-auth';
import type { ApiError } from '@/lib/api/errors';
import {
  emailOnlySchema,
  PASSWORD_HINT,
  resetPasswordSchema,
  type EmailOnlyValues,
  type ResetPasswordValues,
} from '@/schemas/auth';

// Phase 04: the pages behind the emailed links. Every answer about an email
// address is the API's generic one, so nothing here reveals whether an account
// exists. The API's rate limits stay authoritative; the cooldown is courtesy.

/** The backend's one answer for a wrong, expired, used or superseded link. */
const INVALID_LINK = 'This link is invalid or has expired.';
const isInvalidLink = (error: ApiError | null) =>
  error?.kind === 'validation' && error.message === INVALID_LINK;
const RESEND_COOLDOWN_S = 60;

const linkClass =
  'rounded-sm font-semibold text-primary underline underline-offset-4 outline-none focus-visible:outline-2 focus-visible:outline-ring';

function Notice({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div role="status" className="grid gap-3 rounded-2xl border border-border bg-primary-soft px-6 py-5">
      <p className="font-heading text-2xl leading-tight">{title}</p>
      <div className="text-[15px] text-foreground-muted">{children}</div>
    </div>
  );
}

export function VerifyEmail({ token }: { token?: string }) {
  const verify = useVerifyEmail();
  const started = useRef(false);

  useEffect(() => {
    // Once per page view (React may run effects twice in development).
    if (!token || started.current) return;
    started.current = true;
    verify.mutate(token);
  }, [token, verify]);

  if (token && (verify.isIdle || verify.isPending)) {
    return (
      <div role="status" className="flex items-center gap-3 py-6 text-foreground-muted">
        <Spinner className="size-5" />
        Verifying your email…
      </div>
    );
  }
  if (verify.isSuccess) {
    return (
      <div className="grid gap-6">
        <Notice title="Your email is verified">Thank you. You can carry on using For After.</Notice>
        <Button asChild size="lg" className="w-full">
          <Link href="/dashboard">Continue to For After</Link>
        </Button>
      </div>
    );
  }
  if (token && !isInvalidLink(verify.error)) {
    return (
      <div className="grid gap-5">
        <FormError error={verify.error} />
        <Button size="lg" className="w-full" onClick={() => verify.mutate(token)}>
          Try again
        </Button>
      </div>
    );
  }
  return (
    <div className="grid gap-8">
      <Notice title="This link can't be used">
        Verification links work once and expire after a while. Enter your email and we&apos;ll send a new one.
      </Notice>
      <ResendVerificationForm />
      <p className="text-sm text-foreground-muted">
        <Link href="/login" className={linkClass}>
          Back to sign in
        </Link>
      </p>
    </div>
  );
}

/** Resend form: the same answer for any address, then a short cooldown. */
export function ResendVerificationForm({ defaultEmail = '' }: { defaultEmail?: string }) {
  const resend = useResendVerification();
  const [cooldown, setCooldown] = useState(0);
  const form = useForm<EmailOnlyValues>({
    resolver: zodResolver(emailOnlySchema),
    defaultValues: { email: defaultEmail },
  });

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const onSubmit = form.handleSubmit(({ email }) => {
    if (resend.isPending || cooldown > 0) return;
    resend.mutate(email, { onSuccess: () => setCooldown(RESEND_COOLDOWN_S) });
  });

  return (
    <form onSubmit={onSubmit} noValidate className="grid gap-5">
      {resend.isSuccess && (
        <Alert className="border-border bg-primary-soft">
          <AlertDescription>{resend.data.message}</AlertDescription>
        </Alert>
      )}
      <FormError error={resend.error} />
      <TextField
        id="resend-email"
        label="Email"
        type="email"
        autoComplete="email"
        inputMode="email"
        disabled={resend.isPending}
        error={form.formState.errors.email?.message}
        {...form.register('email')}
      />
      <Button type="submit" variant="outline" size="lg" className="w-full" disabled={resend.isPending || cooldown > 0}>
        {resend.isPending && <Spinner />}
        {cooldown > 0 ? `Send again in ${cooldown}s` : 'Send a new verification link'}
      </Button>
    </form>
  );
}

export function ForgotPasswordForm() {
  const forgot = useForgotPassword();
  const form = useForm<EmailOnlyValues>({
    resolver: zodResolver(emailOnlySchema),
    defaultValues: { email: '' },
  });

  const onSubmit = form.handleSubmit(({ email }) => {
    if (!forgot.isPending) forgot.mutate(email);
  });

  if (forgot.isSuccess) {
    return (
      <div className="grid gap-6">
        <Notice title="Check your inbox">
          If an account exists for this email, we&apos;ve sent password reset instructions. The link works once and
          expires in 60 minutes.
        </Notice>
        <p className="text-sm text-foreground-muted">
          <Link href="/login" className={linkClass}>
            Back to sign in
          </Link>
        </p>
      </div>
    );
  }
  return (
    <form onSubmit={onSubmit} noValidate className="grid gap-5">
      <FormError error={forgot.error} />
      <TextField
        id="email"
        label="Email"
        type="email"
        autoComplete="email"
        inputMode="email"
        disabled={forgot.isPending}
        error={form.formState.errors.email?.message}
        {...form.register('email')}
      />
      <Button type="submit" size="lg" className="mt-1 w-full" disabled={forgot.isPending}>
        {forgot.isPending && <Spinner />}
        {forgot.isPending ? 'Sending…' : 'Send reset link'}
      </Button>
    </form>
  );
}

function ResetLinkInvalid() {
  return (
    <div className="grid gap-6">
      <Notice title="This link can't be used">
        Reset links work once and expire after 60 minutes. You can ask for a new one.
      </Notice>
      <Button asChild size="lg" className="w-full">
        <Link href="/forgot-password">Request a new link</Link>
      </Button>
    </div>
  );
}

export function ResetPasswordForm({ token }: { token?: string }) {
  const reset = useResetPassword();
  const form = useForm<ResetPasswordValues>({
    resolver: zodResolver(resetPasswordSchema),
    defaultValues: { newPassword: '', confirmNewPassword: '' },
  });
  const { errors } = form.formState;

  if (!token || isInvalidLink(reset.error)) return <ResetLinkInvalid />;
  if (reset.isSuccess) {
    return (
      <div className="grid gap-6">
        <Notice title="Your password has been reset">
          For your security, you&apos;ve been signed out everywhere. Sign in with your new password.
        </Notice>
        <Button asChild size="lg" className="w-full">
          <Link href="/login">Sign in</Link>
        </Button>
      </div>
    );
  }

  const onSubmit = form.handleSubmit(({ newPassword }) => {
    if (reset.isPending) return;
    reset.mutate({ token, newPassword }, { onError: () => form.resetField('confirmNewPassword') });
  });

  return (
    <form onSubmit={onSubmit} noValidate className="grid gap-5">
      <FormError error={reset.error} />
      <fieldset disabled={reset.isPending} className="grid gap-5">
        <PasswordField
          id="newPassword"
          label="New password"
          autoComplete="new-password"
          hint={PASSWORD_HINT}
          error={errors.newPassword?.message}
          {...form.register('newPassword')}
        />
        <PasswordField
          id="confirmNewPassword"
          label="Confirm new password"
          autoComplete="new-password"
          error={errors.confirmNewPassword?.message}
          {...form.register('confirmNewPassword')}
        />
      </fieldset>
      <Button type="submit" size="lg" className="mt-1 w-full" disabled={reset.isPending}>
        {reset.isPending && <Spinner />}
        {reset.isPending ? 'Saving…' : 'Set new password'}
      </Button>
    </form>
  );
}

/**
 * Phase 08: the link sent to the new address. Works signed in or not; on
 * success every session of the account has ended, so the private cache is
 * already cleared and the only way on is signing in with the new address.
 */
export function VerifyEmailChange({ token }: { token?: string }) {
  const confirm = useConfirmEmailChange();
  const started = useRef(false);

  useEffect(() => {
    if (!token || started.current) return;
    started.current = true;
    confirm.mutate(token);
  }, [token, confirm]);

  if (token && (confirm.isIdle || confirm.isPending)) {
    return (
      <div role="status" className="flex items-center gap-3 py-6 text-foreground-muted">
        <Spinner className="size-5" />
        Updating your email…
      </div>
    );
  }
  if (confirm.isSuccess) {
    return (
      <div className="grid gap-6">
        <Notice title="Email address updated">
          Please sign in again using your new email address. You&apos;ve been signed out everywhere.
        </Notice>
        <Button asChild size="lg" className="w-full">
          <Link href="/login">Sign in</Link>
        </Button>
      </div>
    );
  }
  if (confirm.error?.kind === 'conflict') {
    return (
      <div className="grid gap-6">
        <Notice title="That address is already in use">
          Another account now uses this email address, so your email hasn&apos;t changed. You can choose a different
          one in Account settings.
        </Notice>
        <Button asChild variant="outline" size="lg" className="w-full">
          <Link href="/settings">Back to Account settings</Link>
        </Button>
      </div>
    );
  }
  if (token && !isInvalidLink(confirm.error)) {
    return (
      <div className="grid gap-5">
        <FormError error={confirm.error} />
        <Button size="lg" className="w-full" onClick={() => confirm.mutate(token)}>
          Try again
        </Button>
      </div>
    );
  }
  return (
    <div className="grid gap-6">
      <Notice title="This link can't be used">
        Links to change your email work once and expire after 24 hours, and a newer request replaces an older one. Your
        email hasn&apos;t changed. You can start again from Account settings.
      </Notice>
      <Button asChild variant="outline" size="lg" className="w-full">
        <Link href="/settings">Back to Account settings</Link>
      </Button>
    </div>
  );
}
