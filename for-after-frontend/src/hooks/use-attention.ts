'use client';

import { useQuery } from '@tanstack/react-query';
import { attentionApi, type Attention } from '@/lib/api/attention';
import type { ApiError } from '@/lib/api/errors';
import { queryKeys } from '@/lib/query/query-client';

/**
 * "Needs your attention". Like readiness, every fix happens on another page
 * (or in someone else's inbox), so the query is always stale: each return to
 * the dashboard, or to the tab, refetches it and resolved items disappear.
 */
export const useAttention = () =>
  useQuery<Attention, ApiError>({
    queryKey: queryKeys.attention,
    queryFn: ({ signal }) => attentionApi.get(signal),
    staleTime: 0,
  });
