import { SafetyNoticeDetail } from '@/components/admin/deliveries';

export const metadata = { title: 'Safety notice · Admin' };

export default async function Page({ params }: PageProps<'/admin/deliveries/safety-notices/[reference]'>) {
  const { reference } = await params;
  return <SafetyNoticeDetail reference={reference} />;
}
