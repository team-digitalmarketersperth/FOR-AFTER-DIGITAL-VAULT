import { EditRecipient } from '@/components/people/recipients';

export const metadata = { title: 'Edit person' };

export default async function Page({ params }: PageProps<'/people/[recipientId]/edit'>) {
  const { recipientId } = await params;
  return <EditRecipient id={recipientId} />;
}
