import { CaseList } from '@/components/admin/death-verifications';
import { CASE_STATUSES } from '@/lib/api/portals';
import { enumParam, pageParam } from '@/lib/admin';

export const metadata = { title: 'Death verification · Admin' };

export default async function Page({ searchParams }: PageProps<'/admin/death-verifications'>) {
  const p = await searchParams;
  return <CaseList filters={{ page: pageParam(p.page), status: enumParam(p.status, CASE_STATUSES) }} />;
}
