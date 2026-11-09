import { SupportDetail } from '@/components/support/support';

export const metadata = { title: 'Support request' };

export default async function Page({ params }: PageProps<'/support/[id]'>) {
  const { id } = await params;
  return <SupportDetail id={id} />;
}
