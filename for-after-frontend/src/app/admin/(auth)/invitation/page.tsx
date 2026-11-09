import { ResetPasswordForm } from '@/components/auth/account-links';

export const metadata = { title: 'Set your admin password' };

// The link from an admin invitation email. Public: there is no admin session yet.
export default async function Page({ searchParams }: PageProps<'/admin/invitation'>) {
  const { token } = await searchParams;
  return (
    <div className="grid gap-6">
      <div className="grid gap-2">
        <h1 className="text-[32px] leading-tight">Set your password</h1>
        <p className="text-foreground-muted">Choose a password for your For After admin account.</p>
      </div>
      <ResetPasswordForm admin token={typeof token === 'string' ? token : undefined} />
    </div>
  );
}
