import { AuditList, DATE } from '@/components/admin/audit-logs';
import { AUDIT_EVENT_TYPES } from '@/lib/api/admin';
import { enumParam, pageParam, textParam, UUID } from '@/lib/admin';

export const metadata = { title: 'Audit logs · Admin' };

export default async function Page({ searchParams }: PageProps<'/admin/audit-logs'>) {
  const p = await searchParams;
  const date = (v: string | undefined) => (v && DATE.test(v) ? v : undefined);
  const actor = textParam(p.actorUserId);
  const subjectType = textParam(p.subjectType, 50);
  return (
    <AuditList
      filters={{
        page: pageParam(p.page),
        eventType: enumParam(p.eventType, AUDIT_EVENT_TYPES),
        actorUserId: actor && UUID.test(actor) ? actor : undefined,
        subjectType: subjectType && /^[A-Za-z]+$/.test(subjectType) ? subjectType : undefined,
        subjectId: textParam(p.subjectId),
        from: date(textParam(p.from)),
        to: date(textParam(p.to)),
      }}
    />
  );
}
