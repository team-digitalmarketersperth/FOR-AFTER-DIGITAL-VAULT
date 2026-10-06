import { AuthHeading } from '@/components/auth/auth-heading';
import { ResetPasswordForm } from '@/components/auth/account-links';

export const metadata = { title: 'Choose a new password' };

export default async function ResetPasswordPage({ searchParams }: PageProps<'/reset-password'>) {
  const { token } = await searchParams;
  return (
    <>
      <AuthHeading
        title={<>Choose a new <em>password</em></>}
        description="Once it's saved, you'll be signed out everywhere and can sign in again."
      />
      <ResetPasswordForm token={typeof token === 'string' ? token : undefined} />
    </>
  );
}
