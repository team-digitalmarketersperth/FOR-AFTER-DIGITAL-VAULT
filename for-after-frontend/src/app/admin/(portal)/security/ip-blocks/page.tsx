import { IpBlockList } from '@/components/admin/ip-controls';
import { IP_BLOCK_STATUSES } from '@/lib/api/admin';
import { enumParam, pageParam } from '@/lib/admin';

export const metadata = { title: 'Temporary IP blocks · Admin' };

export default async function Page({ searchParams }: PageProps<'/admin/security/ip-blocks'>) {
  const p = await searchParams;
  return <IpBlockList filters={{ page: pageParam(p.page), status: enumParam(p.status, IP_BLOCK_STATUSES) }} />;
}
