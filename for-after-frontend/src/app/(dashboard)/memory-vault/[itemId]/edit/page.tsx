import { EditMemory } from '@/components/memory-vault/memories';

export const metadata = { title: 'Edit memory' };

export default async function Page({ params }: PageProps<'/memory-vault/[itemId]/edit'>) {
  const { itemId } = await params;
  return <EditMemory id={itemId} />;
}
