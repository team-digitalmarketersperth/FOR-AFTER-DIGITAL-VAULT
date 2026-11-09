'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  adminAccountApi,
  type OwnAdminAccount,
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
  type DeadLetter,
  type DeadLetterFilters,
  type DeliveryFilters,
  type DeliveryPage,
  type FailedJob,
  type Page,
  type QueueSummary,
  type RecoveryVerified,
  type RejectInput,
  type ReleaseEmailDetail,
  type ReleaseDetail,
  type ReleaseFilters,
  type ReleasePage,
  type SafetyNoticeDetail,
  type CreateIpBlockInput,
  type IpBlock,
  type IpBlockFilters,
  type IpBlockPage,
  type SecurityEvent,
  type SecurityFilters,
  type SecurityPage,
  type StorageAsset,
  type StorageAssetFilters,
  type StoragePage,
  type SystemHealth,
  type BillingFilters,
  type BillingPage,
  type AdminAccessFilters,
  type AdminAccount,
  type CreateAdminInput,
  type InvitationResult,
  type AdminAccountDetail,
  type AiFilters,
  type AiOperations,
  type AdminSupportFilters,
  type AdminSupportRequest,
  type AdminSupportSummary,
  type TotpConfirmed,
  type TotpSetup,
  type UserFilters,
  type VerifyInput,
} from '@/lib/api/admin';
import { authApi, isAdminMfaChallenge, type AdminMfaChallenge, type ChangePasswordInput, type LoginInput } from '@/lib/api/auth';
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

// ─── Own account (Account settings) ─────────────────────────────────────────

const accountKey = ['admin', 'own-account'] as const;

export const useOwnAdminAccount = () =>
  useQuery<OwnAdminAccount, ApiError>({ queryKey: accountKey, queryFn: ({ signal }) => adminAccountApi.get(signal) });

/** On success the header identity (GET /admin-auth/me cache) shows the new name at once. */
export function useUpdateAdminProfile() {
  const qc = useQueryClient();
  return useMutation<{ firstName: string; lastName: string }, ApiError, { firstName: string; lastName: string }>({
    mutationFn: adminAccountApi.updateProfile,
    onSuccess: (name) => {
      qc.setQueryData<AdminMe | null>(adminKeys.me, (me) => (me ? { ...me, ...name } : me));
      void qc.invalidateQueries({ queryKey: accountKey });
    },
  });
}

/** Same input/output as the Customer hook, so the shared password dialog can use it. */
export function useChangeAdminPassword() {
  const qc = useQueryClient();
  return useMutation<{ success: true }, ApiError, ChangePasswordInput>({
    mutationFn: adminAccountApi.changePassword,
    gcTime: 0,
    onSuccess: () => void qc.invalidateQueries({ queryKey: accountKey }),
  });
}

export const useSendAdminVerification = () =>
  useMutation<{ sent: true }, ApiError, void>({ mutationFn: () => adminAccountApi.sendVerification() });

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

// Releases (read-only): the previous page stays on screen while the next loads,
// and a failed refetch keeps the last good data (the page says it is stale).
export const useAdminReleases = (f: ReleaseFilters) =>
  useQuery<ReleasePage, ApiError>({
    queryKey: adminKeys.releaseList(f),
    queryFn: ({ signal }) => adminApi.releases(f, signal),
    placeholderData: keepPreviousData,
  });

export const useAdminRelease = (reference: string) =>
  useQuery<ReleaseDetail, ApiError>({
    queryKey: adminKeys.release(reference),
    queryFn: ({ signal }) => adminApi.release(reference, signal),
  });

// Deliveries (read-only): same keep-previous / stale-on-failure behaviour as Releases.
export const useAdminDeliveries = (f: DeliveryFilters) =>
  useQuery<DeliveryPage, ApiError>({
    queryKey: adminKeys.deliveryList(f),
    queryFn: ({ signal }) => adminApi.deliveries(f, signal),
    placeholderData: keepPreviousData,
  });

export const useReleaseEmail = (reference: string) =>
  useQuery<ReleaseEmailDetail, ApiError>({
    queryKey: adminKeys.delivery('release_email', reference),
    queryFn: ({ signal }) => adminApi.releaseEmail(reference, signal),
  });

export const useSafetyNotice = (reference: string) =>
  useQuery<SafetyNoticeDetail, ApiError>({
    queryKey: adminKeys.delivery('safety_notice', reference),
    queryFn: ({ signal }) => adminApi.safetyNotice(reference, signal),
  });

// System Health: manual refresh only (no polling); a failed refetch keeps the
// last result, which the page marks as stale.
export const useSystemHealth = () =>
  useQuery<SystemHealth, ApiError>({
    queryKey: adminKeys.systemHealth,
    queryFn: ({ signal }) => adminApi.systemHealth(signal),
  });

// Security Activity: manual refresh only; the previous page stays while the
// next loads, and a failed refetch keeps the last result (shown as stale).
export const useSecurityEvents = (f: SecurityFilters) =>
  useQuery<SecurityPage, ApiError>({
    queryKey: adminKeys.securityList(f),
    queryFn: ({ signal }) => adminApi.securityEvents(f, signal),
    placeholderData: keepPreviousData,
  });

export const useSecurityEvent = (reference: string) =>
  useQuery<SecurityEvent, ApiError>({
    queryKey: adminKeys.securityEvent(reference),
    queryFn: ({ signal }) => adminApi.securityEvent(reference, signal),
  });

export const useIpBlocks = (f: IpBlockFilters) =>
  useQuery<IpBlockPage, ApiError>({
    queryKey: ['admin', 'security', 'ip-blocks', f],
    queryFn: ({ signal }) => adminApi.ipBlocks(f, signal),
    placeholderData: keepPreviousData,
  });

export function useCreateIpBlock() {
  const qc = useQueryClient();
  return useMutation<IpBlock, ApiError, CreateIpBlockInput>({
    mutationFn: adminApi.createIpBlock,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin', 'security'] }),
  });
}

export function useRevokeIpBlock() {
  const qc = useQueryClient();
  return useMutation<IpBlock, ApiError, string>({
    mutationFn: adminApi.revokeIpBlock,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin', 'security'] }),
  });
}

// Storage & scans: same refresh behaviour as Security activity.
export const useStorageAssets = (f: StorageAssetFilters) =>
  useQuery<StoragePage, ApiError>({
    queryKey: adminKeys.storageList(f),
    queryFn: ({ signal }) => adminApi.storageAssets(f, signal),
    placeholderData: keepPreviousData,
  });

export const useStorageAsset = (reference: string) =>
  useQuery<StorageAsset, ApiError>({
    queryKey: adminKeys.storageAsset(reference),
    queryFn: ({ signal }) => adminApi.storageAsset(reference, signal),
  });

// Support inbox (Step 7). Each command's response is the new detail.
export const useAdminSupportList = (f: AdminSupportFilters) =>
  useQuery<Page<AdminSupportSummary>, ApiError>({
    queryKey: adminKeys.supportList(f),
    queryFn: ({ signal }) => adminApi.supportRequests(f, signal),
    placeholderData: keepPreviousData,
  });

export const useAdminSupportRequest = (id: string) =>
  useQuery<AdminSupportRequest, ApiError>({
    queryKey: adminKeys.supportRequest(id),
    queryFn: ({ signal }) => adminApi.supportRequest(id, signal),
  });

function useSupportCommand<I>(id: string, run: (id: string, input: I) => Promise<AdminSupportRequest>) {
  const qc = useQueryClient();
  return useMutation<AdminSupportRequest, ApiError, I>({
    mutationFn: (input) => run(id, input),
    onSuccess: (request) => {
      qc.setQueryData(adminKeys.supportRequest(id), request);
      void qc.invalidateQueries({ queryKey: [...adminKeys.supportRequests, 'list'] });
    },
  });
}
export const useSupportReply = (id: string) => useSupportCommand(id, adminApi.supportReply);
export const useSupportNote = (id: string) => useSupportCommand(id, adminApi.supportNote);
export const useSupportStatus = (id: string) => useSupportCommand(id, adminApi.supportStatus);

// AI operations: manual refresh only (no polling); a failed refetch keeps the
// last result, which the page marks as possibly out of date.
export const useAiOperations = (f: AiFilters) =>
  useQuery<AiOperations, ApiError>({
    queryKey: adminKeys.aiOperations(f),
    queryFn: ({ signal }) => adminApi.aiOperations(f, signal),
    placeholderData: keepPreviousData,
  });

// Admin access: read-only.
export const useAdminAccounts = (f: AdminAccessFilters) =>
  useQuery<Page<AdminAccount>, ApiError>({
    queryKey: adminKeys.adminAccounts(f),
    queryFn: ({ signal }) => adminApi.adminAccounts(f, signal),
    placeholderData: keepPreviousData,
  });

/** Create admin (SUPER_ADMIN; the API checks role and recent two-factor). */
export function useCreateAdmin() {
  const qc = useQueryClient();
  return useMutation<InvitationResult, ApiError, CreateAdminInput>({
    mutationFn: adminApi.createAdmin,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin', 'access'] }),
  });
}

export function useResendAdminInvitation(id: string) {
  const qc = useQueryClient();
  return useMutation<InvitationResult, ApiError, void>({
    mutationFn: () => adminApi.resendAdminInvitation(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin', 'access'] }),
  });
}

export const useAdminAccount = (id: string) =>
  useQuery<AdminAccountDetail, ApiError>({
    queryKey: adminKeys.adminAccount(id),
    queryFn: ({ signal }) => adminApi.adminAccount(id, signal),
  });

// Subscriptions & payments: read-only, SUPER_ADMIN only (the API returns 403 otherwise).
export const useBillingAccounts = (f: BillingFilters) =>
  useQuery<BillingPage, ApiError>({
    queryKey: adminKeys.billingAccounts(f),
    queryFn: ({ signal }) => adminApi.billingAccounts(f, signal),
    placeholderData: keepPreviousData,
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

export const useDeadLetters = (f: DeadLetterFilters) =>
  useQuery<Page<DeadLetter>, ApiError>({
    queryKey: adminKeys.deadLetters(f),
    queryFn: ({ signal }) => adminApi.deadLetters(f, signal),
    placeholderData: keepPreviousData,
  });

export const useDeadLetter = (id: string, enabled = true) =>
  useQuery<DeadLetter, ApiError>({
    queryKey: adminKeys.deadLetter(id),
    queryFn: ({ signal }) => adminApi.deadLetter(id, signal),
    enabled,
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

/** Re-queues an OPEN dead letter; the worker still decides everything. */
export function useRetryDeadLetter() {
  const qc = useQueryClient();
  return useMutation<DeadLetter, ApiError, string>({
    mutationKey: ['admin', 'dead-letters', 'retry'],
    mutationFn: (id) => adminApi.retryDeadLetter(id),
    onSettled: () => refresh(qc, adminKeys.queues),
  });
}
