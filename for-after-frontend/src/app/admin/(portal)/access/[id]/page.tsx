import { AdminAccessDetail } from '@/components/admin/admin-access';

export const metadata = { title: 'Administrator · Admin' };

export default async function Page({ params }: PageProps<'/admin/access/[id]'>) {
  const { id } = await params;
  return <AdminAccessDetail id={id} />;
}
