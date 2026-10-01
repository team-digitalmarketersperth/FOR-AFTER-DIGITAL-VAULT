import { AccountStatus } from '@/components/portals/trusted-contact';

export const metadata = { title: 'Account' };

export default async function Page({ params }: PageProps<'/trusted-contact/accounts/[trustedContactId]'>) {
  const { trustedContactId } = await params;
  return <AccountStatus id={trustedContactId} />;
}
