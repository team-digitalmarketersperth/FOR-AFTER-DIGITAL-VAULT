import { Queues } from '@/components/admin/queues';
import { DEAD_LETTER_QUEUES, DEAD_LETTER_STATUSES } from '@/lib/api/admin';
import { enumParam, pageParam, textParam } from '@/lib/admin';

export const metadata = { title: 'Queues · Admin' };

// ?queue= is only used if the API's own summary lists that name.
export default async function Page({ searchParams }: PageProps<'/admin/system/queues'>) {
  const p = await searchParams;
  return (
    <Queues
      filters={{
        queue: textParam(p.queue, 100),
        page: pageParam(p.page),
        dlQueue: enumParam(p.dlQueue, DEAD_LETTER_QUEUES),
        dlStatus: enumParam(p.dlStatus, [...DEAD_LETTER_STATUSES, 'ALL'] as const),
        dlPage: p.dlPage === undefined ? undefined : pageParam(p.dlPage),
      }}
    />
  );
}
