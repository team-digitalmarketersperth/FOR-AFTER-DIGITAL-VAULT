import { apiRequest } from './client';
import type { UserRole, UserStatus } from './auth';
import type { CaseStatus } from './portals';

// Admin portal (Step 16 backend: for-after-backend/docs/admin.md). Admins sign
// in with the Customer cookie (for_after_session), but only after a TOTP or
// recovery code: the password alone (POST /auth/login) returns a challenge and
// no session. Nothing here reads a cookie, and no response carries vault
// content, passwords, OTPs, TOTP secrets (except setup, once) or session ids.

export const ADMIN_ROLES: readonly UserRole[] = ['ADMIN', 'SUPER_ADMIN'];
export const USER_ROLES: readonly UserRole[] = ['CUSTOMER', 'ADMIN', 'SUPER_ADMIN'];
export const USER_STATUSES: readonly UserStatus[] = ['ACTIVE', 'SUSPENDED', 'PASSED', 'DELETED'];

/** GET /admin-auth/me, and the profile returned by every second-factor route. */
export type AdminMe = {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  role: UserRole;
  mfaEnabled: boolean;
  mfaVerified: boolean;
  mfaVerifiedAt: string | null;
};

export type TotpSetup = { secret: string; otpauthUri: string };
export type TotpConfirmed = AdminMe & { recoveryCodes: string[] };
export type RecoveryVerified = AdminMe & { remainingRecoveryCodes: number };

export type Pagination = { page: number; limit: number; total: number; pages: number };
export type Page<T> = { items: T[]; pagination: Pagination };

// ─── Dashboard ──────────────────────────────────────────────────────────────

export type AdminDashboard = {
  users: { total: number; active: number; suspended: number; passed: number; deleted: number };
  deathVerification: { pending: number; safeguardActive: number; readyForReview: number };
  /** null = Redis could not be read (not "zero failures"). */
  queues: { failed: number | null };
};

// ─── Users ──────────────────────────────────────────────────────────────────

export type AdminUser = {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  role: UserRole;
  status: UserStatus;
  createdAt: string;
  updatedAt: string;
};

/** Account metadata and counts only: never content. */
export type AdminUserDetail = AdminUser & {
  emailVerifiedAt: string | null;
  mfaEnabled: boolean;
  passedAt: string | null;
  deletedAt: string | null;
  counts: {
    recipientCount: number;
    trustedContactCount: number;
    messageCount: number;
    releasedMessageCount: number;
    memoryVaultCount: number;
  };
  deathVerification: { caseId: string; status: CaseStatus } | null;
};

export type UserFilters = { page: number; search?: string; status?: UserStatus; role?: UserRole };

export const SUSPEND_REASON_MAX = 1000;

// ─── Death verification ─────────────────────────────────────────────────────

export type AccountHolder = { userId: string; email: string; displayName: string | null };

export type DeathCaseSummary = {
  caseId: string;
  status: CaseStatus;
  openedAt: string;
  safeguardEndsAt: string | null;
  reportCount: number;
  accountHolder: AccountHolder;
};

export type DeathCaseEventType =
  | 'REPORT_RECEIVED'
  | 'SAFETY_NOTICE_SENT'
  | 'SAFEGUARD_STARTED'
  | 'SAFEGUARD_ELAPSED'
  | 'CUSTOMER_CONFIRMED_ALIVE'
  | 'ADMIN_VERIFIED'
  | 'ADMIN_REJECTED'
  | 'DEATH_TRIGGER_ACTIVATION_STARTED'
  | 'DEATH_TRIGGER_ACTIVATION_COMPLETED';

export type DeathCaseDetail = {
  caseId: string;
  status: CaseStatus;
  openedAt: string;
  resolvedAt: string | null;
  safetyNoticeSentAt: string | null;
  safetyNoticeLastAttemptAt: string | null;
  safetyNoticeAttemptCount: number;
  safeguardStartedAt: string | null;
  safeguardEndsAt: string | null;
  verifiedAt: string | null;
  verifiedDeathAt: string | null;
  verifiedByUserId: string | null;
  rejectedAt: string | null;
  rejectedByUserId: string | null;
  cancelledAt: string | null;
  adminDecisionNote: string | null;
  deathTriggersActivatedAt: string | null;
  accountHolder: AccountHolder & { accountStatus: UserStatus };
  reportCount: number;
  reports: {
    id: string;
    reportedByTrustedContactId: string | null;
    reporterFirstNameSnapshot: string;
    reporterLastNameSnapshot: string | null;
    reporterEmailNormalized: string | null;
    reporterMobileNormalized: string | null;
    /** Calendar date "YYYY-MM-DD". */
    reportedDateOfDeath: string | null;
    note: string | null;
    createdAt: string;
  }[];
  auditEvents: {
    eventType: DeathCaseEventType;
    actorType: 'SYSTEM' | 'CUSTOMER' | 'TRUSTED_CONTACT' | 'ADMIN';
    actorUserId: string | null;
    actorTrustedContactId: string | null;
    createdAt: string;
  }[];
  activations: { messageId: string; triggerType: string; dueAt: string; messageStatus: string }[];
};

export type CaseFilters = { page: number; status?: CaseStatus };

export type VerifyInput = { verifiedDeathAt: string; confirmVerification: true; decisionNote: string | null };
export type RejectInput = { confirmRejection: true; decisionNote: string | null };

export const DECISION_NOTE_MAX = 2000;

// ─── Audit log ──────────────────────────────────────────────────────────────

export const AUDIT_EVENT_TYPES = [
  'ADMIN_PASSWORD_AUTH_SUCCEEDED',
  'ADMIN_MFA_SETUP_COMPLETED',
  'ADMIN_MFA_VERIFIED',
  'ADMIN_MFA_FAILED',
  'ADMIN_RECOVERY_CODE_USED',
  'ADMIN_LOGIN',
  'ADMIN_LOGOUT',
  'USER_SUSPENDED',
  'USER_REACTIVATED',
  'ADMIN_VIEWED_USER',
  'ADMIN_VIEWED_DEATH_CASE',
  'DEATH_VERIFICATION_VERIFIED',
  'DEATH_VERIFICATION_REJECTED',
  'FAILED_JOB_RETRIED',
  'PASSWORD_CHANGED',
] as const;
export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];
// CUSTOMER: a Customer acting on their own account (Step 22, PASSWORD_CHANGED).
export type AuditActorType = 'ADMIN' | 'SUPER_ADMIN' | 'CUSTOMER';

export type AuditLog = {
  id: string;
  eventType: AuditEventType;
  actorType: AuditActorType;
  actorUserId: string | null;
  subjectType: string | null;
  subjectId: string | null;
  ipPrefix: string | null;
  userAgent: string | null;
  /** Scalars only (the backend drops secret-like keys before storing). */
  metadata: Record<string, string | number | boolean | null> | null;
  createdAt: string;
};

export type AuditFilters = {
  page: number;
  eventType?: AuditEventType;
  actorUserId?: string;
  subjectType?: string;
  subjectId?: string;
  /** ISO 8601 with offset. */
  from?: string;
  to?: string;
};

// ─── Queues ─────────────────────────────────────────────────────────────────

export type QueueSummary = {
  name: string;
  waiting: number;
  active: number;
  delayed: number;
  prioritized: number;
  failed: number;
  completed: number;
};

/** Sanitized by the API: first line of the reason only, no URLs or emails, ids-only payload. */
export type FailedJob = {
  jobId: string;
  queue: string;
  name: string;
  attemptsMade: number;
  maxAttempts: number;
  failedReasonSanitized: string | null;
  createdAt: string;
  failedAt: string | null;
  payload: { messageId?: string; caseId?: string };
};

// ─── Requests ───────────────────────────────────────────────────────────────

/** ?a=1&b=x from defined values only. */
export const toQuery = (params: Record<string, string | number | undefined>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
};

const post = <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: 'POST', body: body ?? {} });

export const adminAuthApi = {
  // POST /auth/login is authApi.login (the shared password route).
  setup: (challengeId: string) => post<TotpSetup>('/admin-auth/totp/setup', { challengeId }),
  confirm: (challengeId: string, code: string) =>
    post<TotpConfirmed>('/admin-auth/totp/confirm', { challengeId, code }),
  verify: (challengeId: string, code: string) => post<AdminMe>('/admin-auth/totp/verify', { challengeId, code }),
  recover: (challengeId: string, recoveryCode: string) =>
    post<RecoveryVerified>('/admin-auth/recovery/verify', { challengeId, recoveryCode }),
  me: (signal?: AbortSignal) => apiRequest<AdminMe>('/admin-auth/me', { signal }),
  // The shared logout also ends admin sessions (and audits ADMIN_LOGOUT).
  logout: () => post<{ success: true }>('/auth/logout'),
};

export const adminApi = {
  dashboard: (signal?: AbortSignal) => apiRequest<AdminDashboard>('/admin/dashboard', { signal }),

  users: (f: UserFilters, signal?: AbortSignal) => apiRequest<Page<AdminUser>>(`/admin/users${toQuery(f)}`, { signal }),
  user: (id: string, signal?: AbortSignal) => apiRequest<AdminUserDetail>(`/admin/users/${id}`, { signal }),
  suspend: (id: string, reason: string) => post<AdminUser>(`/admin/users/${id}/suspend`, { reason }),
  reactivate: (id: string, reason: string | null) =>
    post<AdminUser>(`/admin/users/${id}/reactivate`, reason ? { reason } : {}),

  cases: (f: CaseFilters, signal?: AbortSignal) =>
    apiRequest<Page<DeathCaseSummary>>(`/admin/death-verifications${toQuery(f)}`, { signal }),
  case: (id: string, signal?: AbortSignal) =>
    apiRequest<DeathCaseDetail>(`/admin/death-verifications/${id}`, { signal }),
  verify: (id: string, input: VerifyInput) => post<DeathCaseDetail>(`/admin/death-verifications/${id}/verify`, input),
  reject: (id: string, input: RejectInput) => post<DeathCaseDetail>(`/admin/death-verifications/${id}/reject`, input),

  auditLogs: (f: AuditFilters, signal?: AbortSignal) =>
    apiRequest<Page<AuditLog>>(`/admin/audit-logs${toQuery(f)}`, { signal }),
  auditLog: (id: string, signal?: AbortSignal) => apiRequest<AuditLog>(`/admin/audit-logs/${id}`, { signal }),

  queues: (signal?: AbortSignal) => apiRequest<QueueSummary[]>('/admin/system/queues', { signal }),
  failedJobs: (queue: string, page: number, signal?: AbortSignal) =>
    apiRequest<Page<FailedJob>>(`/admin/system/queues/${encodeURIComponent(queue)}/failed${toQuery({ page })}`, {
      signal,
    }),
  retry: (queue: string, jobId: string) =>
    post<{ queue: string; jobId: string; state: 'waiting' }>(
      `/admin/system/queues/${encodeURIComponent(queue)}/jobs/${encodeURIComponent(jobId)}/retry`,
    ),
};
