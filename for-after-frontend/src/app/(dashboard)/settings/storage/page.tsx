import { StorageManager } from '@/components/account/storage-manager';
import { STORAGE_SORTS, STORAGE_SOURCES, type StorageFilters } from '@/lib/api/media';

export const metadata = { title: 'Storage' };

const oneOf = <T extends string>(values: readonly T[], v: unknown) =>
  values.includes(v as T) ? (v as T) : undefined;

// ?type=PHOTO&source=MEMORY_VAULT&sort=created_desc&page=2 (anything invalid is ignored).
export default async function Page({ searchParams }: PageProps<'/settings/storage'>) {
  const { type, source, sort, page } = await searchParams;
  const n = Number(page);
  const filters: StorageFilters = {
    type: oneOf(['PHOTO', 'AUDIO', 'VIDEO'] as const, type),
    source: oneOf(STORAGE_SOURCES, source),
    // Largest first is the default and stays out of the URL.
    sort: oneOf(STORAGE_SORTS, sort) === 'size_desc' ? undefined : oneOf(STORAGE_SORTS, sort),
    page: Number.isInteger(n) && n > 1 ? n : undefined,
  };
  return <StorageManager filters={filters} />;
}
