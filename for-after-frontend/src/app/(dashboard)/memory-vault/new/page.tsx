import { NewMemory } from '@/components/memory-vault/memories';
import { isMemoryCategory } from '@/lib/api/memory-vault';

export const metadata = { title: 'Save a memory' };

export default async function Page({ searchParams }: PageProps<'/memory-vault/new'>) {
  const { category } = await searchParams;
  return <NewMemory category={isMemoryCategory(category) ? category : undefined} />;
}
