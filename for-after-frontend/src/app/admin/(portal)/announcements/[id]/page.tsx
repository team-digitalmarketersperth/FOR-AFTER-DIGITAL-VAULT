import { AnnouncementEditor } from '@/components/admin/announcements';

export const metadata = { title: 'Edit announcement · Admin' };

export default async function Page({ params }: PageProps<'/admin/announcements/[id]'>) {
  const { id } = await params;
  return <AnnouncementEditor id={id} />;
}
