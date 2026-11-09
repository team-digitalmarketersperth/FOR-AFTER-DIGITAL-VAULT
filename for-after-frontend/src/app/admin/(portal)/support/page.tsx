import { DATE } from '@/components/admin/audit-logs';
import { AdminSupportList } from '@/components/admin/support';
import { enumParam, pageParam, textParam, UUID } from '@/lib/admin';
import { SUPPORT_CATEGORIES, SUPPORT_STATUSES } from '@/lib/api/support';

export const metadata = { title: 'Support · Admin' };

export default async function Page({ searchParams }: PageProps<'/admin/support'>) {
  const p = await searchParams;
  const date = (v: string | undefined) => (v && DATE.test(v) ? v : undefined);
  const uuid = (v: string | undefined) => (v && UUID.test(v) ? v : undefined);
  return (
    <AdminSupportList
      filters={{
        page: pageParam(p.page),
        status: enumParam(p.status, SUPPORT_STATUSES),
        category: enumParam(p.category, SUPPORT_CATEGORIES),
        reference: uuid(textParam(p.reference)),
        accountId: uuid(textParam(p.accountId)),
        from: date(textParam(p.from)),
        to: date(textParam(p.to)),
      }}
    />
  );
}
