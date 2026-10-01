import { ReportForm } from '@/components/portals/trusted-contact';

export const metadata = { title: 'Submit a death report' };

export default async function Page({ params }: PageProps<'/trusted-contact/accounts/[trustedContactId]/report'>) {
  const { trustedContactId } = await params;
  return <ReportForm id={trustedContactId} />;
}
