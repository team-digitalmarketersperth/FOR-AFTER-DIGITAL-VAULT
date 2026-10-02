import { AuditDetail } from '@/components/admin/audit-logs';

export const metadata = { title: 'Audit event · Admin' };

export default async function Page({ params }: PageProps<'/admin/audit-logs/[auditLogId]'>) {
  const { auditLogId } = await params;
  return <AuditDetail id={auditLogId} />;
}
