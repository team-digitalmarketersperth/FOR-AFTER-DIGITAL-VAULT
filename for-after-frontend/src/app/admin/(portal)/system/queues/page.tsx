import { Queues } from '@/components/admin/queues';
import { pageParam, textParam } from '@/lib/admin';

export const metadata = { title: 'Queues · Admin' };

// ?queue= is only used if the API's own summary lists that name.
export default async function Page({ searchParams }: PageProps<'/admin/system/queues'>) {
  const p = await searchParams;
  return <Queues filters={{ queue: textParam(p.queue, 100), page: pageParam(p.page) }} />;
}
