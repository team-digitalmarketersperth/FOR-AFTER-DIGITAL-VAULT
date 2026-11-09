import { SupportList } from '@/components/support/support';

export const metadata = { title: 'Help & support' };

// ?page=2 (anything invalid is page 1).
export default async function Page({ searchParams }: PageProps<'/support'>) {
  const { page } = await searchParams;
  const n = Number(page);
  return <SupportList page={Number.isInteger(n) && n > 1 ? n : 1} />;
}
