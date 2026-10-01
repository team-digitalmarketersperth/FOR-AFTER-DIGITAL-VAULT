'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { FormError, PasswordField, TextField } from '@/components/shared/form-field';
import { Spinner } from '@/components/shared/states';
import { Button } from '@/components/ui/button';
import { useRegister } from '@/hooks/use-auth';
import { PASSWORD_HINT, registerSchema, type RegisterValues } from '@/schemas/auth';

export function RegisterForm() {
  const router = useRouter();
  const registerUser = useRegister();
  const form = useForm<RegisterValues>({
    resolver: zodResolver(registerSchema),
    defaultValues: { firstName: '', lastName: '', email: '', password: '' },
  });
  const { errors } = form.formState;

  const onSubmit = form.handleSubmit((values) => {
    if (registerUser.isPending) return;
    // POST /auth/register creates the account but no session, so the next step
    // is signing in. The flag carries no personal data.
    registerUser.mutate(values, {
      onSuccess: () => router.replace('/login?registered=1'),
    });
  });

  return (
    <form onSubmit={onSubmit} noValidate className="grid gap-5">
      <FormError error={registerUser.error} />

      <fieldset disabled={registerUser.isPending} className="grid gap-5">
        <div className="grid gap-5 sm:grid-cols-2">
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
        </div>
        <TextField
          id="email"
          label="Email"
          type="email"
          autoComplete="email"
          inputMode="email"
          error={errors.email?.message}
          {...form.register('email')}
        />
        <PasswordField
          id="password"
          label="Password"
          autoComplete="new-password"
          hint={PASSWORD_HINT}
          error={errors.password?.message}
          {...form.register('password')}
        />
      </fieldset>

      <Button type="submit" size="lg" className="mt-1 w-full" disabled={registerUser.isPending}>
        {registerUser.isPending && <Spinner />}
        {registerUser.isPending ? 'Creating your account…' : 'Create account'}
      </Button>
    </form>
  );
}
