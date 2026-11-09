import { DeliveryList } from '@/components/admin/deliveries';
import { DATE } from '@/components/admin/releases';
import {
  DELIVERY_CATEGORIES,
  ERROR_CATEGORIES,
  RELEASE_EMAIL_STATUSES,
  SAFETY_NOTICE_STATUSES,
} from '@/lib/api/admin';
import { enumParam, pageParam, textParam, UUID } from '@/lib/admin';

export const metadata = { title: 'Deliveries · Admin' };

export default async function Page({ searchParams }: PageProps<'/admin/deliveries'>) {
  const p = await searchParams;
  const category = enumParam(p.category, DELIVERY_CATEGORIES);
  const email = category !== 'safety_notice';
  const date = (v: string | undefined) => (v && DATE.test(v) ? v : undefined);
  const id = (v: string | undefined) => (v && UUID.test(v) ? v : undefined);
  return (
    <DeliveryList
      filters={{
        page: pageParam(p.page),
        category,
        // Status values depend on the category; release-email-only filters are dropped for safety notices.
        status: email ? enumParam(p.status, RELEASE_EMAIL_STATUSES) : enumParam(p.status, SAFETY_NOTICE_STATUSES),
        outcomeUncertain: email && p.outcomeUncertain === 'true' ? 'true' : undefined,
        errorCategory: email ? enumParam(p.errorCategory, ERROR_CATEGORIES) : undefined,
        reference: id(textParam(p.reference, 36)),
        releaseReference: email ? id(textParam(p.releaseReference, 36)) : undefined,
        from: date(textParam(p.from)),
        to: date(textParam(p.to)),
        sort: enumParam(p.sort, ['createdAt', 'updatedAt'] as const),
        dir: enumParam(p.dir, ['asc', 'desc'] as const),
      }}
    />
  );
}
