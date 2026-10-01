import { MemoryList } from '@/components/memory-vault/memories';
import { isMemoryCategory } from '@/lib/api/memory-vault';

export const metadata = { title: 'Memory Vault' };

export default async function Page({ searchParams }: PageProps<'/memory-vault'>) {
  const { category } = await searchParams;
  return <MemoryList category={isMemoryCategory(category) ? category : undefined} />;
}
