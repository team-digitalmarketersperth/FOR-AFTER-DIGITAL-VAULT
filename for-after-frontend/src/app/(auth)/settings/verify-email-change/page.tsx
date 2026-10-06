import { AuthHeading } from '@/components/auth/auth-heading';
import { VerifyEmailChange } from '@/components/auth/account-links';

export const metadata = { title: 'Confirm your new email' };

// Phase 08. In the (auth) group so it opens without a session; GuestGate lets a
// signed-in browser through too. /settings itself stays in (dashboard).
export default async function VerifyEmailChangePage({
  searchParams,
}: PageProps<'/settings/verify-email-change'>) {
  const { token } = await searchParams;
  return (
    <>
      <AuthHeading
        title={<>Confirm your new <em>email</em></>}
        description="One moment while we update the email address on your account."
      />
      <VerifyEmailChange token={typeof token === 'string' ? token : undefined} />
    </>
  );
}
