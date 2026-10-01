import { EditTrustedContact } from '@/components/people/trusted-contacts';

export const metadata = { title: 'Edit trusted contact' };

export default async function Page({ params }: PageProps<'/trusted-contacts/[trustedContactId]/edit'>) {
  const { trustedContactId } = await params;
  return <EditTrustedContact id={trustedContactId} />;
}
