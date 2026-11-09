import { DATE } from '@/components/admin/audit-logs';
import { SecurityList } from '@/components/admin/security-activity';
import { SECURITY_ACTOR_TYPES, SECURITY_CATEGORIES, SECURITY_OUTCOMES } from '@/lib/api/admin';
import { enumParam, pageParam, textParam, UUID } from '@/lib/admin';

export const metadata = { title: 'Security activity · Admin' };

export default async function Page({ searchParams }: PageProps<'/admin/security'>) {
  const p = await searchParams;
  const date = (v: string | undefined) => (v && DATE.test(v) ? v : undefined);
  const uuid = (v: string | undefined) => (v && UUID.test(v) ? v : undefined);
  return (
    <SecurityList
      filters={{
        page: pageParam(p.page),
        category: enumParam(p.category, SECURITY_CATEGORIES),
        outcome: enumParam(p.outcome, SECURITY_OUTCOMES),
        actorType: enumParam(p.actorType, SECURITY_ACTOR_TYPES),
        reference: uuid(textParam(p.reference)),
        accountId: uuid(textParam(p.accountId)),
        from: date(textParam(p.from)),
        to: date(textParam(p.to)),
      }}
    />
  );
}
