'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { isApiError, type ApiError } from '@/lib/api/errors';
import { uploadToProvider, type AccessUrl } from '@/lib/api/media';
import {
  checkEvidenceFile,
  deathVerificationApi,
  type Evidence,
  invitationApi,
  recipientApi,
  recipientAuthApi,
  trustedContactApi,
  trustedContactAuthApi,
  type CaseStatusForReporter,
  type CustomerCaseStatus,
  type DeathReportInput,
  type DeathReportReceipt,
  type InvitationView,
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

/** SMS step 1: mobile (E.164) → generic message, same for any mobile. */
export function useRequestSmsCode(portal: Portal) {
  return useMutation<{ message: string }, ApiError, string>({
    mutationKey: [portal, 'sign-in', 'request-sms'],
    mutationFn: (mobile) => AUTH[portal].requestSmsOtp(mobile),
  });
}

/** SMS step 2: mobile + code → the same portal session as email. */
export function useVerifySmsCode(portal: Portal) {
  const qc = useQueryClient();
  return useMutation<PortalMe, ApiError, { mobile: string; code: string }>({
    mutationKey: [portal, 'sign-in', 'verify-sms'],
    mutationFn: ({ mobile, code }) => AUTH[portal].verifySmsOtp(mobile, code),
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

// ─── Trusted Contact evidence (Phase 19A) ───────────────────────────────────

export const useEvidence = (trustedContactId: string) =>
  useQuery<Evidence[], ApiError>({
    queryKey: portalKeys.evidence(trustedContactId),
    queryFn: ({ signal }) => trustedContactApi.evidence(trustedContactId, signal),
  });

export type EvidenceUploadState =
  | { phase: 'idle' }
  | { phase: 'uploading'; fileName: string; progress: number }
  | { phase: 'confirming'; fileName: string }
  | { phase: 'done'; fileName: string }
  | { phase: 'failed'; fileName: string; message: string };

/**
 * upload-url → direct upload to the private provider (with progress) →
 * complete (the server's checks and malware scan) → READY. A finished file
 * is "ready for review", never "verified": evidence decides nothing.
 */
export function useEvidenceUpload(trustedContactId: string) {
  const qc = useQueryClient();
  const [state, setState] = useState<EvidenceUploadState>({ phase: 'idle' });
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);

  const upload = useCallback(
    async (file: File) => {
      const problem = checkEvidenceFile(file);
      if (problem) return setState({ phase: 'failed', fileName: file.name, message: problem });
      const controller = new AbortController();
      abortRef.current = controller;
      setState({ phase: 'uploading', fileName: file.name, progress: 0 });
      try {
        const target = await trustedContactApi.requestEvidenceUpload(trustedContactId, file);
        const providerFileId = await uploadToProvider(target.upload, file, {
          signal: controller.signal,
          onProgress: (progress) => setState({ phase: 'uploading', fileName: file.name, progress }),
        });
        setState({ phase: 'confirming', fileName: file.name });
        await trustedContactApi.completeEvidence(trustedContactId, target.mediaAssetId, providerFileId);
        setState({ phase: 'done', fileName: file.name });
      } catch (error) {
        // A cancelled or abandoned upload is retired by the server's cleanup.
        setState(
          controller.signal.aborted
            ? { phase: 'idle' }
            : {
                phase: 'failed',
                fileName: file.name,
                message: isApiError(error) ? error.message : 'The upload did not finish. Please try again.',
              },
        );
      } finally {
        abortRef.current = null;
        // The case may have closed meanwhile: refresh the list and the status.
        void qc.invalidateQueries({ queryKey: portalKeys.caseStatus(trustedContactId) });
      }
    },
    [qc, trustedContactId],
  );
  const cancel = useCallback(() => abortRef.current?.abort(), []);
  return { state, upload, cancel };
}

/**
 * Opens one READY file in a new tab through a short-lived signed URL, fetched
 * on click and never cached. The tab is opened first (inside the click) so
 * pop-up blockers allow it, then pointed at the URL.
 */
export function useOpenSignedFile(fetchUrl: (id: string) => Promise<AccessUrl>) {
  return useMutation<void, ApiError, string>({
    mutationFn: async (id) => {
      const tab = window.open('', '_blank');
      try {
        const { url } = await fetchUrl(id);
        if (tab) {
          tab.opener = null;
          tab.location.href = url;
        } else {
          window.open(url, '_blank', 'noopener');
        }
      } catch (error) {
        tab?.close();
        throw error;
      }
    },
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

// ─── Trusted Contact invitation (Phase 10) ─────────────────────────────────

/** What the emailed link is for. Not cached beyond the page: the token is a credential. */
export const useInvitation = (token: string) =>
  useQuery<InvitationView, ApiError>({
    queryKey: ['trusted-contact', 'invitation', token],
    queryFn: () => invitationApi.view(token),
    enabled: !!token,
    gcTime: 0,
    retry: false,
  });

/** Accept or decline. The answer replaces the view; no session is created. */
export function useAnswerInvitation(token: string) {
  const qc = useQueryClient();
  return useMutation<InvitationView, ApiError, 'accept' | 'decline'>({
    mutationFn: (answer) => invitationApi[answer](token),
    onSuccess: (view) => qc.setQueryData(['trusted-contact', 'invitation', token], view),
    gcTime: 0,
  });
}
