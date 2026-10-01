import Link from 'next/link';
import { LoginForm } from '@/components/auth/login-form';
import { AuthHeading } from '@/components/auth/auth-heading';
import { Alert, AlertDescription } from '@/components/ui/alert';

export const metadata = { title: 'Sign in' };

export default async function LoginPage({ searchParams }: PageProps<'/login'>) {
  const { registered } = await searchParams;
  return (
    <>
      <AuthHeading
        title={<>Welcome <em>back</em></>}
        description="Sign in to continue to your private space."
      />
      {registered === '1' && (
        <Alert className="mb-6 border-border bg-primary-soft">
          <AlertDescription>Your account has been created. Please sign in.</AlertDescription>
        </Alert>
      )}
      <LoginForm />
      <p className="mt-8 text-sm text-foreground-muted">
        New to For After?{' '}
        <Link href="/register" className="rounded-sm font-semibold text-primary underline underline-offset-4 outline-none focus-visible:outline-2 focus-visible:outline-ring">
          Create an account
        </Link>
      </p>
    </>
  );
}
