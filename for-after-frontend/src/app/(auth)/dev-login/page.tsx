import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AuthHeading } from '@/components/auth/auth-heading';
import { LoginForm } from '@/components/auth/login-form';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { API_BASE_URL, isDevLoginEnabled } from '@/lib/env';

export const metadata = { title: 'Development sign-in' };

// FE-7. src/proxy.ts answers 404 for this route in production builds; the
// notFound() below is the second line of defence. It uses the real POST
// /auth/login: no shortcuts, no stored credentials.
export default function DevLoginPage() {
  if (!isDevLoginEnabled()) notFound();
  return (
    <>
      <AuthHeading title={<>Development <em>sign-in</em></>} description="Local testing only." />
      <Alert className="mb-6 border-border bg-primary-soft">
        <AlertTitle>Development only</AlertTitle>
        <AlertDescription>
          <p>
            Signs in through the real API at <code className="break-all">{API_BASE_URL}</code>.
            Use a local test account; nothing is stored here.
          </p>
        </AlertDescription>
      </Alert>
      <LoginForm />
      <p className="mt-8 text-sm text-foreground-muted">
        Need a local account?{' '}
        <Link href="/register" className="rounded-sm font-semibold text-primary underline underline-offset-4 outline-none focus-visible:outline-2 focus-visible:outline-ring">
          Register one
        </Link>
      </p>
    </>
  );
}
