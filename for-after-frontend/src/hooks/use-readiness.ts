'use client';

import { useQuery } from '@tanstack/react-query';
import type { ApiError } from '@/lib/api/errors';
import { readinessApi, type Readiness } from '@/lib/api/readiness';
import { queryKeys } from '@/lib/query/query-client';

/**
 * The dashboard's setup progress. Every change happens on another page (or as
 * a direct upload), so instead of invalidating from a dozen mutations the
 * query is always stale: each return to the dashboard refetches it.
 */
export const useReadiness = () =>
  useQuery<Readiness, ApiError>({
    queryKey: queryKeys.readiness,
    queryFn: ({ signal }) => readinessApi.get(signal),
    staleTime: 0,
  });
