import Link from 'next/link';
import { AuthHeading } from '@/components/auth/auth-heading';
import { RegisterForm } from '@/components/auth/register-form';

export const metadata = { title: 'Create your account' };

export default function RegisterPage() {
  return (
    <>
      <AuthHeading
        title={<>Create your <em>account</em></>}
        description="A private space for the things that matter most."
      />
      <RegisterForm />
      <p className="mt-8 text-sm text-foreground-muted">
        Already have an account?{' '}
        <Link href="/login" className="rounded-sm font-semibold text-primary underline underline-offset-4 outline-none focus-visible:outline-2 focus-visible:outline-ring">
          Sign in
        </Link>
      </p>
    </>
  );
}
