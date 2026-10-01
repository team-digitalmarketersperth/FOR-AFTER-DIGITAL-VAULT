import { MemoryDetail } from '@/components/memory-vault/memories';

export const metadata = { title: 'Memory' };

export default async function Page({ params }: PageProps<'/memory-vault/[itemId]'>) {
  const { itemId } = await params;
  return <MemoryDetail id={itemId} />;
}
