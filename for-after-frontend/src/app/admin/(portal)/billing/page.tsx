import { DATE } from '@/components/admin/audit-logs';
import { AdminBillingList } from '@/components/admin/billing';
import { BILLING_FILTERS } from '@/lib/api/admin';
import { enumParam, pageParam, textParam, UUID } from '@/lib/admin';

export const metadata = { title: 'Subscriptions & payments · Admin' };

export default async function Page({ searchParams }: PageProps<'/admin/billing'>) {
  const p = await searchParams;
  const date = (v: string | undefined) => (v && DATE.test(v) ? v : undefined);
  const account = textParam(p.accountId);
  const sub = textParam(p.subscriptionReference, 110);
  return (
    <AdminBillingList
      filters={{
        page: pageParam(p.page),
        state: enumParam(p.state, BILLING_FILTERS),
        plan: enumParam(p.plan, ['monthly', 'annual', 'unknown'] as const),
        accountId: account && UUID.test(account) ? account : undefined,
        subscriptionReference: sub && /^sub_[A-Za-z0-9]+$/.test(sub) ? sub : undefined,
        from: date(textParam(p.from)),
        to: date(textParam(p.to)),
      }}
    />
  );
}
