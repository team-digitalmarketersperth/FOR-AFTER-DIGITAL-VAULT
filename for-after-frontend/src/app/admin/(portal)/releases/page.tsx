import { DATE, ReleaseList } from '@/components/admin/releases';
import { RELEASE_SORTS, RELEASE_STATUSES, RELEASE_TRIGGERS } from '@/lib/api/admin';
import { enumParam, pageParam, textParam, UUID } from '@/lib/admin';

export const metadata = { title: 'Releases · Admin' };

export default async function Page({ searchParams }: PageProps<'/admin/releases'>) {
  const p = await searchParams;
  const date = (v: string | undefined) => (v && DATE.test(v) ? v : undefined);
  const id = (v: string | undefined) => (v && UUID.test(v) ? v : undefined);
  return (
    <ReleaseList
      filters={{
        page: pageParam(p.page),
        status: enumParam(p.status, RELEASE_STATUSES),
        triggerType: enumParam(p.triggerType, RELEASE_TRIGGERS),
        pastDue: p.pastDue === 'true' ? 'true' : undefined,
        reference: id(textParam(p.reference, 36)),
        accountId: id(textParam(p.accountId, 36)),
        from: date(textParam(p.from)),
        to: date(textParam(p.to)),
        sort: enumParam(p.sort, RELEASE_SORTS),
        dir: enumParam(p.dir, ['asc', 'desc'] as const),
      }}
    />
  );
}
