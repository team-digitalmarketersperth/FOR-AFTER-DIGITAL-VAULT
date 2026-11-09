import { StorageDetail } from '@/components/admin/storage';

export const metadata = { title: 'Stored-file record · Admin' };

export default async function Page({ params }: PageProps<'/admin/storage/[reference]'>) {
  const { reference } = await params;
  return <StorageDetail reference={reference} />;
}
