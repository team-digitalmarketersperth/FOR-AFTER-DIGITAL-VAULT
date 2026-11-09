'use client';

import { useQuery } from '@tanstack/react-query';
import { deliveryTimelineApi, type DeliveryTimeline } from '@/lib/api/delivery-timeline';
import type { ApiError } from '@/lib/api/errors';
import { queryKeys } from '@/lib/query/query-client';

/**
 * Read-only plan. Schedules change on other pages (and releases happen in the
 * background), so like readiness it is always stale: each visit refetches.
 */
export const useDeliveryTimeline = () =>
  useQuery<DeliveryTimeline, ApiError>({
    queryKey: queryKeys.deliveryTimeline,
    queryFn: ({ signal }) => deliveryTimelineApi.get(signal),
    staleTime: 0,
  });
