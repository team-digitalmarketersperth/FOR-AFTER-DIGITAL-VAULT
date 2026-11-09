import { ActivityHistory } from '@/components/activity/activity';

export const metadata = { title: 'Activity' };

// ?page=2 (anything invalid is page 1).
export default async function Page({ searchParams }: PageProps<'/settings/activity'>) {
  const { page } = await searchParams;
  const n = Number(page);
  return <ActivityHistory page={Number.isInteger(n) && n > 1 ? n : 1} />;
}
