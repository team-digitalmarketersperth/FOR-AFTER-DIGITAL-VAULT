import { DATE } from '@/components/admin/audit-logs';
import { StorageList } from '@/components/admin/storage';
import { ASSET_KINDS, DELETION_STATES, STORAGE_ASSET_SOURCES, UPLOAD_STATES } from '@/lib/api/admin';
import { enumParam, pageParam, textParam, UUID } from '@/lib/admin';

export const metadata = { title: 'Storage & scans · Admin' };

export default async function Page({ searchParams }: PageProps<'/admin/storage'>) {
  const p = await searchParams;
  const date = (v: string | undefined) => (v && DATE.test(v) ? v : undefined);
  const uuid = (v: string | undefined) => (v && UUID.test(v) ? v : undefined);
  return (
    <StorageList
      filters={{
        page: pageParam(p.page),
        source: enumParam(p.source, STORAGE_ASSET_SOURCES),
        uploadState: enumParam(p.uploadState, UPLOAD_STATES),
        deletion: enumParam(p.deletion, DELETION_STATES),
        kind: enumParam(p.kind, ASSET_KINDS),
        reference: uuid(textParam(p.reference)),
        accountId: uuid(textParam(p.accountId)),
        from: date(textParam(p.from)),
        to: date(textParam(p.to)),
      }}
    />
  );
}
