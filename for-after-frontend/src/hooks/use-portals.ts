'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isApiError, type ApiError } from '@/lib/api/errors';
import {
  deathVerificationApi,
  recipientApi,
  recipientAuthApi,
  trustedContactApi,
  trustedContactAuthApi,
  type CaseStatusForReporter,
  type CustomerCaseStatus,
  type DeathReportInput,
  type DeathReportReceipt,
  type OtpChallenge,
  type PortalMe,
  type ReleasedMessage,
  type ReleasedMessageDetail,
  type TrustedAccount,
} from '@/lib/api/portals';
import { portalKeys, queryKeys, resetPortalCache, type Portal } from '@/lib/query/query-client';

const AUTH = { recipient: recipientAuthApi, 'trusted-contact': trustedContactAuthApi } as const;

/**
 * The portal's own session, from its own /me route (never the Customer's
 * /auth/me). 401 → null ("signed out"), like the Customer session.
 */
export function usePortalSession(portal: Portal) {
  return useQuery<PortalMe | null, ApiError>({
    queryKey: portalKeys.me(portal),
    queryFn: async ({ signal }) => {
      try {
        return await AUTH[portal].me(signal);
      } catch (error) {
        if (isApiError(error) && error.kind === 'unauthenticated') return null;
        throw error;
      }
    },
  });
}

/** Step 1: email → challenge. The response is the same for any email. */
export function useRequestCode(portal: Portal) {
  return useMutation<OtpChallenge, ApiError, string>({
    mutationKey: [portal, 'sign-in', 'request'],
    mutationFn: (email) => AUTH[portal].requestOtp(email),
  });
}

/**
 * Step 2: challenge + code → session cookie (set by the API). Anything cached
 * for this portal from an earlier person is dropped first. gcTime 0 keeps the
 * code out of the mutation cache once the form is gone.
 */
export function useVerifyCode(portal: Portal) {
  const qc = useQueryClient();
  return useMutation<PortalMe, ApiError, { challengeId: string; code: string }>({
    mutationKey: [portal, 'sign-in', 'verify'],
    mutationFn: ({ challengeId, code }) => AUTH[portal].verifyOtp(challengeId, code),
    onSuccess: (me) => resetPortalCache(qc, portal, me),
    gcTime: 0,
  });
}

/** Ends only this portal's session; other For After sessions are untouched. */
export function usePortalLogout(portal: Portal) {
  const qc = useQueryClient();
  return useMutation<void, ApiError, void>({
    mutationKey: [portal, 'logout'],
    mutationFn: () => AUTH[portal].logout(),
    onSuccess: () => resetPortalCache(qc, portal),
  });
}

// ─── Recipient ──────────────────────────────────────────────────────────────

export const useReleasedMessages = () =>
  useQuery<ReleasedMessage[], ApiError>({
    queryKey: portalKeys.releasedMessages,
    queryFn: ({ signal }) => recipientApi.messages(signal),
  });

export const useReleasedMessage = (id: string) =>
  useQuery<ReleasedMessageDetail, ApiError>({
    queryKey: portalKeys.releasedMessage(id),
    queryFn: ({ signal }) => recipientApi.message(id, signal),
  });

// ─── Trusted Contact ────────────────────────────────────────────────────────

export const useTrustedAccounts = () =>
  useQuery<TrustedAccount[], ApiError>({
    queryKey: portalKeys.accounts,
    queryFn: ({ signal }) => trustedContactApi.accounts(signal),
  });

export const useCaseStatus = (trustedContactId: string) =>
  useQuery<CaseStatusForReporter, ApiError>({
    queryKey: portalKeys.caseStatus(trustedContactId),
    queryFn: ({ signal }) => trustedContactApi.status(trustedContactId, signal),
  });

export function useDeathReport(trustedContactId: string) {
  const qc = useQueryClient();
  return useMutation<DeathReportReceipt, ApiError, DeathReportInput>({
    mutationKey: ['trusted-contact', 'report'],
    mutationFn: (input) => trustedContactApi.report(trustedContactId, input),
    // Refresh after a success or a 409 (someone else's report may have opened
    // the case, or it closed): the status on screen must match the server.
    // Not awaited: the refreshed status unmounts the form, and the caller's
    // mutate() callbacks (confirmation + redirect) never run after an unmount.
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: portalKeys.accounts });
    },
    gcTime: 0,
  });
}

// ─── Customer safety (Step 15) ──────────────────────────────────────────────

/** The Customer's own case; normal refresh only (no polling). */
export const useCustomerDeathVerification = () =>
  useQuery<CustomerCaseStatus, ApiError>({
    queryKey: queryKeys.deathVerification,
    queryFn: ({ signal }) => deathVerificationApi.me(signal),
  });

export function useConfirmAlive() {
  const qc = useQueryClient();
  return useMutation<CustomerCaseStatus, ApiError, void>({
    mutationFn: () => deathVerificationApi.confirmAlive(),
    onSuccess: (status) => qc.setQueryData(queryKeys.deathVerification, status),
    // A 409 means the case closed meanwhile (e.g. an admin decision): re-read it.
    onError: () => qc.invalidateQueries({ queryKey: queryKeys.deathVerification }),
  });
}
