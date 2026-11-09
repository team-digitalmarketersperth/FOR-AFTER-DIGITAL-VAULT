import { AdminSupportDetail } from '@/components/admin/support';

export const metadata = { title: 'Support request · Admin' };

export default async function Page({ params }: PageProps<'/admin/support/[id]'>) {
  const { id } = await params;
  return <AdminSupportDetail id={id} />;
}
