import { UserList } from '@/components/admin/users';
import { USER_ROLES, USER_STATUSES } from '@/lib/api/admin';
import { enumParam, pageParam, textParam } from '@/lib/admin';

export const metadata = { title: 'Users · Admin' };

export default async function Page({ searchParams }: PageProps<'/admin/users'>) {
  const p = await searchParams;
  return (
    <UserList
      filters={{
        page: pageParam(p.page),
        search: textParam(p.search, 254),
        status: enumParam(p.status, USER_STATUSES),
        role: enumParam(p.role, USER_ROLES),
      }}
    />
  );
}
