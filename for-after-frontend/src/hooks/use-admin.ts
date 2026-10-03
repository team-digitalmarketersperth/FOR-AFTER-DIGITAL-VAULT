'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  adminApi,
  adminAuthApi,
  type AdminDashboard,
  type AdminMe,
  type AdminUser,
  type AdminUserDetail,
  type AuditFilters,
  type AuditLog,
  type CaseFilters,
  type DeathCaseDetail,
  type DeathCaseSummary,
  type FailedJob,
  type Page,
  type QueueSummary,
  type RecoveryVerified,
  type RejectInput,
  type TotpConfirmed,
  type TotpSetup,
  type UserFilters,
  type VerifyInput,
} from '@/lib/api/admin';
import { authApi, isAdminMfaChallenge, type AdminMfaChallenge, type LoginInput } from '@/lib/api/auth';
import { ApiError, isApiError } from '@/lib/api/errors';
import { adminKeys, dropAdminData, resetAdminCache, resetPrivateCache } from '@/lib/query/query-client';

// ─── Session ────────────────────────────────────────────────────────────────

/**
 * GET /admin-auth/me is the only source of truth (never /auth/me, never local
 * state). 401 → null ("signed out"); if a session was showing, the server ended
 * it (idle timeout, suspension, …), so its data goes and sign-in says why.
 * A Customer session is never sent here (separate cookie), so a signed-in
 * Customer just sees the admin sign-in; a 403 still stays an error.
 */
export function useAdminSession() {
  const qc = useQueryClient();
  return useQuery<AdminMe | null, ApiError>({
    queryKey: adminKeys.me,
    queryFn: async ({ signal }) => {
      try {
        return await adminAuthApi.me(signal);
      } catch (error) {
        if (!isApiError(error) || error.kind !== 'unauthenticated') throw error;
        if (qc.getQueryData(adminKeys.me)) {
          dropAdminData(qc);
          qc.setQueryData(adminKeys.expired, true);
        }
        return null;
      }
    },
  });
}

/** Memory only (never storage or the URL); lost on refresh, like the challenge's 5-minute life. */
export type StoredChallenge = AdminMfaChallenge & { email: string };

export type AdminLoginResult = { kind: 'mfa'; challenge: StoredChallenge } | { kind: 'not_admin' };

/**
 * Password step. An admin gets a challenge and no session. A Customer's
 * correct password does create a Customer session (it replaces any Customer
 * session in this browser), which the admin portal doesn't want, so it is
 * ended again straight away and the Customer cache follows.
 */
export function useAdminLogin() {
  const qc = useQueryClient();
  return useMutation<AdminLoginResult, ApiError, LoginInput>({
    mutationKey: ['admin', 'sign-in', 'password'],
    mutationFn: async (input) => {
      const result = await authApi.login(input);
      if (!isAdminMfaChallenge(result)) {
        await authApi.logout().catch(() => undefined);
        await resetPrivateCache(qc, null);
        await resetAdminCache(qc, null);
        return { kind: 'not_admin' };
      }
      const challenge = { ...result, email: input.email };
      qc.setQueryData(adminKeys.challenge, challenge);
      return { kind: 'mfa', challenge };
    },
    gcTime: 0,
  });
}

/** A 200 from a second-factor route is not proof of a session (cookies may be blocked): /me is. */
async function startAdminSession(qc: QueryClient) {
  const me = await adminAuthApi.me().catch(() => null);
  if (!me) {
    throw new ApiError(
      'unauthenticated',
      401,
      "We couldn't start your session. Please check that cookies are allowed for this site and try again.",
    );
  }
  await resetAdminCache(qc, me);
  return me;
}

export function useTotpSetup() {
  return useMutation<TotpSetup, ApiError, string>({
    mutationKey: ['admin', 'sign-in', 'setup'],
    mutationFn: (challengeId) => adminAuthApi.setup(challengeId),
    // The secret is shown once; keep it out of the mutation cache afterwards.
    gcTime: 0,
  });
}

/**
 * Enrollment confirm. The session exists from here, but /me is fetched (and
 * the portal opened) only after the recovery codes have been acknowledged.
 */
export function useTotpConfirm() {
  return useMutation<TotpConfirmed, ApiError, { challengeId: string; code: string }>({
    mutationKey: ['admin', 'sign-in', 'confirm'],
    mutationFn: ({ challengeId, code }) => adminAuthApi.confirm(challengeId, code),
    gcTime: 0,
  });
}

export function useStartAdminSession() {
  const qc = useQueryClient();
  return useMutation<AdminMe, ApiError, void>({
    mutationKey: ['admin', 'sign-in', 'session'],
    mutationFn: () => startAdminSession(qc),
  });
}

export function useTotpVerify() {
  const qc = useQueryClient();
  return useMutation<AdminMe, ApiError, { challengeId: string; code: string }>({
    mutationKey: ['admin', 'sign-in', 'verify'],
    mutationFn: async ({ challengeId, code }) => {
      await adminAuthApi.verify(challengeId, code);
      return startAdminSession(qc);
    },
    gcTime: 0,
  });
}

export function useRecoveryVerify() {
  const qc = useQueryClient();
  return useMutation<{ me: AdminMe; remaining: number }, ApiError, { challengeId: string; recoveryCode: string }>({
    mutationKey: ['admin', 'sign-in', 'recovery'],
    mutationFn: async ({ challengeId, recoveryCode }) => {
      const result: RecoveryVerified = await adminAuthApi.recover(challengeId, recoveryCode);
      return { me: await startAdminSession(qc), remaining: result.remainingRecoveryCodes };
    },
    gcTime: 0,
  });
}

export function useAdminLogout() {
  const qc = useQueryClient();
  return useMutation<unknown, ApiError, void>({
    mutationKey: ['admin', 'logout'],
    mutationFn: () => adminAuthApi.logout(),
    onSuccess: () => resetAdminCache(qc, null),
  });
}

// ─── Data ───────────────────────────────────────────────────────────────────

export const useAdminDashboard = () =>
  useQuery<AdminDashboard, ApiError>({
    queryKey: adminKeys.dashboard,
    queryFn: ({ signal }) => adminApi.dashboard(signal),
  });

// Paged lists keep the previous page on screen while the next one loads.
export const useAdminUsers = (f: UserFilters) =>
  useQuery<Page<AdminUser>, ApiError>({
    queryKey: adminKeys.userList(f),
    queryFn: ({ signal }) => adminApi.users(f, signal),
    placeholderData: keepPreviousData,
  });

export const useAdminUser = (id: string) =>
  useQuery<AdminUserDetail, ApiError>({
    queryKey: adminKeys.user(id),
    queryFn: ({ signal }) => adminApi.user(id, signal),
  });

export const useDeathCases = (f: CaseFilters) =>
  useQuery<Page<DeathCaseSummary>, ApiError>({
    queryKey: adminKeys.caseList(f),
    queryFn: ({ signal }) => adminApi.cases(f, signal),
    placeholderData: keepPreviousData,
  });

export const useDeathCase = (id: string) =>
  useQuery<DeathCaseDetail, ApiError>({
    queryKey: adminKeys.case(id),
    queryFn: ({ signal }) => adminApi.case(id, signal),
  });

export const useAuditLogs = (f: AuditFilters) =>
  useQuery<Page<AuditLog>, ApiError>({
    queryKey: adminKeys.auditList(f),
    queryFn: ({ signal }) => adminApi.auditLogs(f, signal),
    placeholderData: keepPreviousData,
  });

export const useAuditLog = (id: string) =>
  useQuery<AuditLog, ApiError>({
    queryKey: adminKeys.auditLog(id),
    queryFn: ({ signal }) => adminApi.auditLog(id, signal),
  });

export const useQueues = () =>
  useQuery<QueueSummary[], ApiError>({
    queryKey: adminKeys.queues,
    queryFn: ({ signal }) => adminApi.queues(signal),
  });

export const useFailedJobs = (queue: string | undefined, page: number) =>
  useQuery<Page<FailedJob>, ApiError>({
    queryKey: adminKeys.failedJobs(queue ?? '', page),
    queryFn: ({ signal }) => adminApi.failedJobs(queue!, page, signal),
    enabled: !!queue,
    placeholderData: keepPreviousData,
  });

// ─── Actions ────────────────────────────────────────────────────────────────

/**
 * Every admin write refreshes what it can have changed: counts on the
 * dashboard, the lists, and the audit log (each action writes an audit row).
 * Settled, not success: a 409 means the server state moved, so re-read it too.
 */
const refresh = (qc: QueryClient, ...keys: (readonly unknown[])[]) =>
  Promise.all(
    [...keys, adminKeys.dashboard, adminKeys.auditLogs].map((queryKey) => qc.invalidateQueries({ queryKey })),
  );

export function useSuspendUser(id: string) {
  const qc = useQueryClient();
  return useMutation<AdminUser, ApiError, string>({
    mutationKey: ['admin', 'users', 'suspend'],
    mutationFn: (reason) => adminApi.suspend(id, reason),
    onSettled: () => refresh(qc, adminKeys.users),
  });
}

export function useReactivateUser(id: string) {
  const qc = useQueryClient();
  return useMutation<AdminUser, ApiError, string | null>({
    mutationKey: ['admin', 'users', 'reactivate'],
    mutationFn: (reason) => adminApi.reactivate(id, reason),
    onSettled: () => refresh(qc, adminKeys.users),
  });
}

/** Verifying also makes the account holder PASSED, so users refresh too. */
export function useVerifyDeath(id: string) {
  const qc = useQueryClient();
  return useMutation<DeathCaseDetail, ApiError, VerifyInput>({
    mutationKey: ['admin', 'death-verifications', 'verify'],
    mutationFn: (input) => adminApi.verify(id, input),
    onSettled: () => refresh(qc, adminKeys.cases, adminKeys.users),
  });
}

export function useRejectDeath(id: string) {
  const qc = useQueryClient();
  return useMutation<DeathCaseDetail, ApiError, RejectInput>({
    mutationKey: ['admin', 'death-verifications', 'reject'],
    mutationFn: (input) => adminApi.reject(id, input),
    onSettled: () => refresh(qc, adminKeys.cases, adminKeys.users),
  });
}

export function useRetryJob() {
  const qc = useQueryClient();
  return useMutation<unknown, ApiError, { queue: string; jobId: string }>({
    mutationKey: ['admin', 'queues', 'retry'],
    mutationFn: ({ queue, jobId }) => adminApi.retry(queue, jobId),
    onSettled: () => refresh(qc, adminKeys.queues),
  });
}
