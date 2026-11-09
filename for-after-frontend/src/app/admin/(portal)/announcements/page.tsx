import { AnnouncementList } from '@/components/admin/announcements';
import { pageParam } from '@/lib/admin';

export const metadata = { title: 'Notification centre · Admin' };

export default async function Page({ searchParams }: PageProps<'/admin/announcements'>) {
  const { page } = await searchParams;
  return <AnnouncementList page={pageParam(page)} />;
}
