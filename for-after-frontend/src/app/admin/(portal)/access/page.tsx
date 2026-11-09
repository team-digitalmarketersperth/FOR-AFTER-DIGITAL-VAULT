import { AdminAccessList } from '@/components/admin/admin-access';
import { USER_STATUSES } from '@/lib/api/admin';
import { enumParam, pageParam, textParam } from '@/lib/admin';

export const metadata = { title: 'Admin access · Admin' };

export default async function Page({ searchParams }: PageProps<'/admin/access'>) {
  const p = await searchParams;
  return (
    <AdminAccessList
      filters={{
        page: pageParam(p.page),
        search: textParam(p.search, 254),
        role: enumParam(p.role, ['ADMIN', 'SUPER_ADMIN'] as const),
        status: enumParam(p.status, USER_STATUSES),
        mfa: enumParam(p.mfa, ['enrolled', 'not_enrolled'] as const),
      }}
    />
  );
}
