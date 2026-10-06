import Link from 'next/link';
import { AuthHeading } from '@/components/auth/auth-heading';
import { ForgotPasswordForm } from '@/components/auth/account-links';

export const metadata = { title: 'Reset your password' };

export default function ForgotPasswordPage() {
  return (
    <>
      <AuthHeading
        title={<>Forgotten your <em>password?</em></>}
        description="Enter the email you use for For After and we'll send you a link to choose a new one."
      />
      <ForgotPasswordForm />
      <p className="mt-8 text-sm text-foreground-muted">
        Remembered it?{' '}
        <Link href="/login" className="rounded-sm font-semibold text-primary underline underline-offset-4 outline-none focus-visible:outline-2 focus-visible:outline-ring">
          Sign in
        </Link>
      </p>
    </>
  );
}
