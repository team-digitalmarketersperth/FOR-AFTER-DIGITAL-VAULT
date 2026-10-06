import { AuthHeading } from '@/components/auth/auth-heading';
import { VerifyEmail } from '@/components/auth/account-links';

export const metadata = { title: 'Verify your email' };

// Reached from the emailed link, signed in or not (GuestGate lets it through).
export default async function VerifyEmailPage({ searchParams }: PageProps<'/verify-email'>) {
  const { token } = await searchParams;
  return (
    <>
      <AuthHeading
        title={<>Verify your <em>email</em></>}
        description="One moment while we confirm your email address."
      />
      <VerifyEmail token={typeof token === 'string' ? token : undefined} />
    </>
  );
}
