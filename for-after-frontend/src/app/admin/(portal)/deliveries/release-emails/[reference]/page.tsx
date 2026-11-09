import { ReleaseEmailDetail } from '@/components/admin/deliveries';

export const metadata = { title: 'Release email · Admin' };

export default async function Page({ params }: PageProps<'/admin/deliveries/release-emails/[reference]'>) {
  const { reference } = await params;
  return <ReleaseEmailDetail reference={reference} />;
}
