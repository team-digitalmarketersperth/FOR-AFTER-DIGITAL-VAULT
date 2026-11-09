'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Page } from '@/lib/api/admin';
import type { ApiError } from '@/lib/api/errors';
import {
  supportApi,
  type SupportRequest,
  type SupportRequestInput,
  type SupportSummary,
  type SupportTextInput,
} from '@/lib/api/support';
import { queryKeys } from '@/lib/query/query-client';

// Replies arrive from the support team, so every visit refetches (no polling).
export const useSupportRequests = (page: number) =>
  useQuery<Page<SupportSummary>, ApiError>({
    queryKey: queryKeys.supportPage(page),
    queryFn: ({ signal }) => supportApi.list(page, signal),
    staleTime: 0,
    placeholderData: keepPreviousData,
  });

export const useSupportRequest = (id: string) =>
  useQuery<SupportRequest, ApiError>({
    queryKey: queryKeys.supportRequest(id),
    queryFn: ({ signal }) => supportApi.get(id, signal),
    staleTime: 0,
  });

/** Success only after the API confirmed the row; the response becomes the detail. */
export function useCreateSupportRequest() {
  const qc = useQueryClient();
  return useMutation<SupportRequest, ApiError, SupportRequestInput>({
    mutationFn: supportApi.create,
    onSuccess: (request) => {
      qc.setQueryData(queryKeys.supportRequest(request.id), request);
      void qc.invalidateQueries({ queryKey: queryKeys.supportRequests, exact: false });
    },
  });
}

export function useSupportFollowUp(id: string) {
  const qc = useQueryClient();
  return useMutation<SupportRequest, ApiError, SupportTextInput>({
    mutationFn: (input) => supportApi.followUp(id, input),
    onSuccess: (request) => {
      qc.setQueryData(queryKeys.supportRequest(id), request);
      void qc.invalidateQueries({ queryKey: ['support', 'page'] });
    },
  });
}
