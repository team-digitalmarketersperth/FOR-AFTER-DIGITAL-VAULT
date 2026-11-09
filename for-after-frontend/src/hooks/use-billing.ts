'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { billingApi, type BillingStatus, type PlanKey } from '@/lib/api/billing';
import type { ApiError } from '@/lib/api/errors';
import { queryKeys } from '@/lib/query/query-client';

/** Always fresh: access can change from a webhook at any time. */
export const useBilling = (refetchInterval?: number | false) =>
  useQuery<BillingStatus, ApiError>({
    queryKey: queryKeys.billing,
    queryFn: ({ signal }) => billingApi.status(signal),
    staleTime: 0,
    refetchInterval,
  });

export function useStartTrial() {
  const qc = useQueryClient();
  return useMutation<BillingStatus, ApiError, void>({
    mutationFn: () => billingApi.startTrial(),
    onSuccess: (status) => qc.setQueryData(queryKeys.billing, status),
  });
}

/** Leaves for Stripe-hosted pages; access only changes once Stripe tells the server. */
export function useBillingRedirect(kind: 'checkout' | 'portal') {
  return useMutation<{ url: string }, ApiError, PlanKey | void>({
    mutationFn: (plan) => (kind === 'checkout' ? billingApi.checkout(plan as PlanKey) : billingApi.portal()),
    onSuccess: ({ url }) => window.location.assign(url),
  });
}
