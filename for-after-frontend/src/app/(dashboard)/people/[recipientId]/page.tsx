import { RecipientDetail } from '@/components/people/recipients';

export const metadata = { title: 'People I Love' };

export default async function Page({ params }: PageProps<'/people/[recipientId]'>) {
  const { recipientId } = await params;
  return <RecipientDetail id={recipientId} />;
}
