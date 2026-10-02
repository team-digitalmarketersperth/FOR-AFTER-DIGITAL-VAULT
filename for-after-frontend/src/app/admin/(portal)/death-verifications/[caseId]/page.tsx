import { CaseDetail } from '@/components/admin/death-verifications';

export const metadata = { title: 'Death verification case · Admin' };

export default async function Page({ params }: PageProps<'/admin/death-verifications/[caseId]'>) {
  const { caseId } = await params;
  return <CaseDetail id={caseId} />;
}
