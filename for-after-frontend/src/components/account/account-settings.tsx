'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { KeyRound, Lock } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { FormError, PasswordField, TextField } from '@/components/shared/form-field';
import { PageHeader } from '@/components/shared/page-header';
import { Spinner } from '@/components/shared/states';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  useCancelEmailChange,
  useChangePassword,
  useCurrentUser,
  useRequestEmailChange,
  useResendEmailChange,
  useUpdateProfile,
} from '@/hooks/use-auth';
import { useUnsavedChanges } from '@/hooks/use-unsaved-changes';
import type { CurrentUser } from '@/lib/api/auth';
import { formatMonthYear, fullName, humanize, initials } from '@/lib/format';
import {
  changeEmailSchema,
  changePasswordSchema,
  PASSWORD_HINT,
  profileSchema,
  type ChangeEmailValues,
  type ChangePasswordValues,
  type ProfileValues,
} from '@/schemas/auth';

/**
 * FE-9. Rendered inside CustomerGate, so /auth/me is already loaded: the
 * gate owns the loading skeleton and the "couldn't load your account" + retry
 * state, and this page always has real data.
 */
export function AccountSettings() {
  const { data: user } = useCurrentUser();
  if (!user) return null;
  return (
    <div className="max-w-[1120px]">
      <PageHeader
        eyebrow="Account"
        title={
          <>
            Account <em>settings</em>
          </>
        }
        description="Your personal details and the security of your account, kept quietly in one place."
      />

      <div className="grid grid-cols-[minmax(0,1fr)] gap-8 xl:grid-cols-[minmax(0,1.85fr)_minmax(0,1fr)] xl:items-start xl:gap-12">
        <ProfileForm user={user} />
        <ProfileSummary user={user} />
      </div>

      <section aria-labelledby="security-heading" className="mt-16 border-t border-border pt-12 lg:mt-20 lg:pt-14">
        <div className="mb-8 grid gap-2">
          <h2 id="security-heading" className="text-[32px] leading-tight">
            Security
          </h2>
          <p className="max-w-xl text-foreground-muted">
            Protect access to the memories and messages you&apos;ve preserved.
          </p>
        </div>
        <div className="flex flex-col gap-6 rounded-xl border border-border bg-surface p-6 sm:flex-row sm:items-center sm:justify-between sm:p-8">
          <div className="flex items-start gap-4">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-primary-soft text-primary">
              <KeyRound aria-hidden strokeWidth={1.5} className="size-5" />
            </span>
            <div className="grid gap-1">
              <h3 className="font-sans text-base font-semibold">Password</h3>
              <p className="text-[15px] text-foreground-muted">
                Keep your password private and unique to For After.
              </p>
            </div>
          </div>
          <ChangePasswordDialog />
        </div>
      </section>
    </div>
  );
}

function ProfileForm({ user }: { user: CurrentUser }) {
  const update = useUpdateProfile();
  const form = useForm<ProfileValues>({
    resolver: zodResolver(profileSchema),
    defaultValues: { firstName: user.firstName, lastName: user.lastName },
  });
  const { errors, isDirty } = form.formState;
  useUnsavedChanges(isDirty);

  const onSubmit = form.handleSubmit((values) => {
    if (update.isPending) return;
    update.mutate(values, {
      // The saved (trimmed) values become the new baseline: Save disables again.
      onSuccess: (saved) => {
        form.reset({ firstName: saved.firstName, lastName: saved.lastName });
        toast.success('Changes saved');
      },
    });
  });

  return (
    <section aria-labelledby="profile-heading" className="rounded-xl border border-border bg-surface">
      <form noValidate onSubmit={onSubmit}>
        <div className="grid gap-8 p-6 sm:p-10">
          <div className="grid gap-2">
            <p className="eyebrow">Your profile</p>
            <h2 id="profile-heading" className="text-[32px] leading-tight">
              Personal details
            </h2>
            <p className="text-foreground-muted">Keep the details connected to your account up to date.</p>
          </div>

          <FormError error={update.error} />
          <fieldset disabled={update.isPending} className="grid gap-6 sm:grid-cols-2">
            <legend className="sr-only">Your name</legend>
            <TextField
              id="firstName"
              label="First name"
              autoComplete="given-name"
              error={errors.firstName?.message}
              {...form.register('firstName')}
            />
            <TextField
              id="lastName"
              label="Last name"
              autoComplete="family-name"
              error={errors.lastName?.message}
              {...form.register('lastName')}
            />
          </fieldset>

          {/* Read-only here: a change goes through a link sent to the new address (Phase 08). */}
          <div className="flex flex-col gap-4 rounded-lg bg-surface-muted px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
            <dl className="grid min-w-0 gap-1.5">
              <dt className="flex items-center gap-2 text-sm font-medium">
                Email address
                <Lock aria-hidden strokeWidth={1.5} className="size-3.5 text-foreground-muted" />
              </dt>
              <dd className="text-[15px] break-all">{user.email}</dd>
              <dd className="text-sm text-foreground-muted">Used to sign in to For After.</dd>
            </dl>
            <ChangeEmailDialog />
          </div>
        </div>

        <div className="flex justify-end border-t border-border px-6 py-5 sm:px-10">
          <Button type="submit" className="w-full sm:w-auto" disabled={!isDirty || update.isPending}>
            {update.isPending && <Spinner />}
            {update.isPending ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      </form>
    </section>
  );
}

/** Only what /auth/me returns: the saved name, email, status and join date. */
function ProfileSummary({ user }: { user: CurrentUser }) {
  return (
    <aside
      aria-label="Account summary"
      className="flex flex-col gap-6 rounded-xl border border-border bg-surface-muted p-6 sm:flex-row sm:items-center sm:p-8 xl:flex-col xl:items-stretch xl:p-10"
    >
      <div className="flex min-w-0 items-center gap-5 sm:flex-1 xl:flex-col xl:items-start xl:gap-6">
        <span
          aria-hidden
          className="flex size-16 shrink-0 items-center justify-center rounded-full border border-primary/25 bg-surface font-heading text-2xl text-primary xl:size-20 xl:text-3xl"
        >
          {initials(user)}
        </span>
        <div className="min-w-0 xl:w-full">
          <p className="font-heading text-[26px] leading-tight break-words">{fullName(user)}</p>
          <p className="mt-1 truncate text-sm text-foreground-muted" title={user.email}>
            {user.email}
          </p>
        </div>
      </div>
      <dl className="grid shrink-0 grid-cols-2 gap-x-8 gap-y-5 border-t border-border pt-6 text-sm sm:border-t-0 sm:border-l sm:pt-0 sm:pl-8 xl:grid-cols-1 xl:border-t xl:border-l-0 xl:pt-6 xl:pl-0">
        <div className="grid gap-1">
          <dt className="eyebrow">Account</dt>
          <dd className="text-[15px]">{humanize(user.status)}</dd>
        </div>
        <div className="grid gap-1">
          <dt className="eyebrow">Member since</dt>
          <dd className="text-[15px]">{formatMonthYear(user.createdAt)}</dd>
        </div>
      </dl>
    </aside>
  );
}

const EMPTY_PASSWORDS: ChangePasswordValues = { currentPassword: '', newPassword: '', confirmNewPassword: '' };

function ChangePasswordDialog() {
  const change = useChangePassword();
  const [open, setOpen] = useState(false);
  const form = useForm<ChangePasswordValues>({
    resolver: zodResolver(changePasswordSchema),
    defaultValues: EMPTY_PASSWORDS,
  });
  const { errors } = form.formState;

  // Passwords never outlive the dialog: closing clears fields and any error.
  const onOpenChange = (next: boolean) => {
    if (change.isPending) return;
    setOpen(next);
    if (!next) {
      form.reset(EMPTY_PASSWORDS);
      change.reset();
    }
  };

  const onSubmit = form.handleSubmit(({ currentPassword, newPassword }) => {
    if (change.isPending) return;
    // Only the two fields the API takes; the confirmation stays here.
    change.mutate(
      { currentPassword, newPassword },
      {
        onSuccess: () => {
          form.reset(EMPTY_PASSWORDS);
          setOpen(false);
          toast.success('Password updated. Other devices have been signed out.');
        },
        onError: () => form.resetField('currentPassword'),
      },
    );
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline" className="w-full shrink-0 sm:w-auto">
          Change password
        </Button>
      </DialogTrigger>
      <DialogContent
        // Scrolls inside the viewport when a phone keyboard takes half the screen.
        className="max-h-[calc(100dvh-2rem)] gap-6 overflow-y-auto rounded-xl bg-surface p-7 sm:max-w-md sm:p-8"
        showCloseButton={false}
      >
        <DialogHeader className="gap-3">
          <DialogTitle className="text-[28px] leading-tight font-normal">Change password</DialogTitle>
          <DialogDescription className="text-[15px] leading-relaxed text-foreground-muted">
            Choose a strong password you don&apos;t use elsewhere. You&apos;ll stay signed in here, and other
            devices will be signed out.
          </DialogDescription>
        </DialogHeader>
        <form noValidate onSubmit={onSubmit} className="grid gap-6">
          <FormError error={change.error} />
          <fieldset disabled={change.isPending} className="grid gap-5">
            <legend className="sr-only">Passwords</legend>
            <PasswordField
              id="currentPassword"
              label="Current password"
              autoComplete="current-password"
              error={errors.currentPassword?.message}
              {...form.register('currentPassword')}
            />
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
          <DialogFooter className="mx-0 mb-0 flex-col-reverse gap-3 rounded-none border-0 bg-transparent p-0 sm:flex-row">
            <Button type="button" variant="outline" disabled={change.isPending} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={change.isPending}>
              {change.isPending && <Spinner />}
              {change.isPending ? 'Updating…' : 'Update password'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const EMPTY_EMAIL_CHANGE: ChangeEmailValues = { newEmail: '', currentPassword: '' };

/**
 * Phase 08. Nothing changes here: the API emails a link to the new address and
 * the account's email changes only when that link is used (then every session
 * ends, so the Customer signs in again). The dialog lives inside the profile
 * form in the React tree, so its submit must not bubble to that form.
 */
function ChangeEmailDialog() {
  const request = useRequestEmailChange();
  const resend = useResendEmailChange();
  const cancel = useCancelEmailChange();
  const [open, setOpen] = useState(false);
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);
  const form = useForm<ChangeEmailValues>({
    resolver: zodResolver(changeEmailSchema),
    defaultValues: EMPTY_EMAIL_CHANGE,
  });
  const { errors } = form.formState;
  const busy = request.isPending || resend.isPending || cancel.isPending;

  // The password never outlives the dialog.
  const onOpenChange = (next: boolean) => {
    if (busy) return;
    setOpen(next);
    if (!next) {
      form.reset(EMPTY_EMAIL_CHANGE);
      request.reset();
      resend.reset();
      cancel.reset();
      setPendingEmail(null);
    }
  };

  const submit = form.handleSubmit((values) => {
    if (request.isPending) return;
    request.mutate(values, {
      onSuccess: ({ pendingEmail }) => {
        form.reset(EMPTY_EMAIL_CHANGE);
        setPendingEmail(pendingEmail);
      },
      onError: () => form.resetField('currentPassword'),
    });
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" className="w-full shrink-0 sm:w-auto">
          Change email
        </Button>
      </DialogTrigger>
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] gap-6 overflow-y-auto rounded-xl bg-surface p-7 sm:max-w-md sm:p-8"
        showCloseButton={false}
      >
        {pendingEmail ? (
          <>
            <DialogHeader className="gap-3">
              <DialogTitle className="text-[28px] leading-tight font-normal">Verification email sent</DialogTitle>
              <DialogDescription className="text-[15px] leading-relaxed text-foreground-muted">
                We&apos;ve sent a verification link to <strong className="font-semibold text-foreground">{pendingEmail}</strong>.
                Your email stays the same until you open it. The link expires in 24 hours.
              </DialogDescription>
            </DialogHeader>
            <FormError error={resend.error ?? cancel.error} />
            {resend.isSuccess && <p className="text-sm text-foreground-muted">A new link is on its way.</p>}
            <DialogFooter className="mx-0 mb-0 flex-col-reverse gap-3 rounded-none border-0 bg-transparent p-0 sm:flex-row">
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => cancel.mutate(undefined, { onSuccess: () => onOpenChange(false) })}
              >
                {cancel.isPending && <Spinner />}
                Cancel request
              </Button>
              <Button type="button" variant="outline" disabled={busy || resend.isSuccess} onClick={() => resend.mutate()}>
                {resend.isPending && <Spinner />}
                Resend link
              </Button>
              <Button type="button" disabled={busy} onClick={() => onOpenChange(false)}>
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader className="gap-3">
              <DialogTitle className="text-[28px] leading-tight font-normal">Change email</DialogTitle>
              <DialogDescription className="text-[15px] leading-relaxed text-foreground-muted">
                We&apos;ll send a link to your new address. Once you open it, your email changes and you&apos;ll
                sign in again with the new one.
              </DialogDescription>
            </DialogHeader>
            <form
              noValidate
              onSubmit={(event) => {
                event.stopPropagation();
                void submit(event);
              }}
              className="grid gap-6"
            >
              <FormError error={request.error} />
              <fieldset disabled={request.isPending} className="grid gap-5">
                <legend className="sr-only">New email</legend>
                <TextField
                  id="newEmail"
                  label="New email"
                  type="email"
                  autoComplete="email"
                  inputMode="email"
                  error={errors.newEmail?.message}
                  {...form.register('newEmail')}
                />
                <PasswordField
                  id="emailChangePassword"
                  label="Current password"
                  autoComplete="current-password"
                  error={errors.currentPassword?.message}
                  {...form.register('currentPassword')}
                />
              </fieldset>
              <DialogFooter className="mx-0 mb-0 flex-col-reverse gap-3 rounded-none border-0 bg-transparent p-0 sm:flex-row">
                <Button type="button" variant="outline" disabled={request.isPending} onClick={() => onOpenChange(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={request.isPending}>
                  {request.isPending && <Spinner />}
                  {request.isPending ? 'Sending…' : 'Send verification'}
                </Button>
              </DialogFooter>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
