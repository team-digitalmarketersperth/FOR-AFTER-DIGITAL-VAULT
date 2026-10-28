'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { Page } from '@/lib/api/admin';
import { activityApi, type ActivityItem } from '@/lib/api/activity';
import type { ApiError } from '@/lib/api/errors';
import { queryKeys } from '@/lib/query/query-client';

/**
 * The Customer's own history. Changes are made on other pages, so the query
 * is always stale and every visit refetches it (like the dashboard readiness).
 */
export const useActivity = (page: number, limit: number) =>
  useQuery<Page<ActivityItem>, ApiError>({
    queryKey: queryKeys.activity(page, limit),
    queryFn: ({ signal }) => activityApi.list(page, limit, signal),
    staleTime: 0,
    placeholderData: keepPreviousData,
  });
