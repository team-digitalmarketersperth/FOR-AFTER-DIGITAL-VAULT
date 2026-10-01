'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { FormError, PasswordField, TextField } from '@/components/shared/form-field';
import { Spinner } from '@/components/shared/states';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useLogin } from '@/hooks/use-auth';
import { loginSchema, type LoginValues } from '@/schemas/auth';

export function LoginForm() {
  const router = useRouter();
  const login = useLogin();
  const form = useForm<LoginValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '' },
  });
  const { errors } = form.formState;

  const onSubmit = form.handleSubmit((values) => {
    if (login.isPending) return;
    login.mutate(values, {
      onSuccess: (result) => {
        if (result.kind === 'customer') router.replace('/dashboard');
        else form.resetField('password');
      },
      onError: () => form.resetField('password'),
    });
  });

  return (
    <form onSubmit={onSubmit} noValidate className="grid gap-5">
      {login.data?.kind === 'admin_mfa_required' && (
        <Alert>
          <AlertTitle>Administrator account</AlertTitle>
          <AlertDescription>
            This account requires administrator sign-in, which isn&apos;t
            available here.
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

      <Button type="submit" size="lg" className="mt-1 w-full" disabled={login.isPending}>
        {login.isPending && <Spinner />}
        {login.isPending ? 'Signing in…' : 'Sign in'}
      </Button>
    </form>
  );
}
