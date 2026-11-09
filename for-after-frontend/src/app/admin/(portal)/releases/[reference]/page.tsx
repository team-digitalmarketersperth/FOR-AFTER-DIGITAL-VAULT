import { ReleaseDetail } from '@/components/admin/releases';

export const metadata = { title: 'Release · Admin' };

export default async function Page({ params }: PageProps<'/admin/releases/[reference]'>) {
  const { reference } = await params;
  return <ReleaseDetail reference={reference} />;
}
