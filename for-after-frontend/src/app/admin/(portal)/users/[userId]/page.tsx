import { UserDetail } from '@/components/admin/users';

export const metadata = { title: 'User · Admin' };

export default async function Page({ params }: PageProps<'/admin/users/[userId]'>) {
  const { userId } = await params;
  return <UserDetail id={userId} />;
}
