import { SecurityDetail } from '@/components/admin/security-activity';

export const metadata = { title: 'Security event · Admin' };

export default async function Page({ params }: PageProps<'/admin/security/[reference]'>) {
  const { reference } = await params;
  return <SecurityDetail reference={reference} />;
}
