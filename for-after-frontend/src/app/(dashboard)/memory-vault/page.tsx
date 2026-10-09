import { MemoryList } from '@/components/memory-vault/memories';
import { isMemoryCategory, SEARCH_MAX, TAG_NAME_MAX } from '@/lib/api/memory-vault';

export const metadata = { title: 'Memory Vault' };

const text = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

// ?category=FAMILY&tag=travel&search=italy&page=2 (anything invalid is ignored).
export default async function Page({ searchParams }: PageProps<'/memory-vault'>) {
  const { category, tag, search, page } = await searchParams;
  const n = Number(page);
  return (
    <MemoryList
      filters={{
        category: isMemoryCategory(category) ? category : undefined,
        tag: text(tag, TAG_NAME_MAX),
        search: text(search, SEARCH_MAX),
        page: Number.isInteger(n) && n > 1 ? n : undefined,
      }}
    />
  );
}
