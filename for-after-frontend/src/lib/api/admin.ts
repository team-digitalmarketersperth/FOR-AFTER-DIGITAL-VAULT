import { apiRequest } from './client';
import type { AccessState } from '@/lib/api/billing';
import type { SupportCategory, SupportMessage, SupportStatus, SupportSummary, SupportTextInput } from '@/lib/api/support';
import type { UserRole, UserStatus } from './auth';
import type { AccessUrl } from './media';
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

/** System Health statuses (docs/admin.md §19); labels in lib/system-health.ts. */
export type HealthStatus = 'ok' | 'failed' | 'timed_out' | 'unknown' | 'not_configured' | 'stale' | 'missing';
export type HealthCheck = { status: 'ok' | 'failed' | 'timed_out'; checkedAt: string; durationMs: number };
/** GET /admin/system/health: observations from the API instance that answered. */
export type SystemHealth = {
  checkedAt: string;
  api: { status: 'ok'; checkedAt: string };
  database: HealthCheck;
  redis: HealthCheck;
  worker: {
    status: 'ok' | 'stale' | 'missing' | 'unknown';
    checkedAt: string;
    reportingWorkers: number | null;
    lastSeenAt: string | null;
    staleAfterSeconds: number;
  };
  malwareScanner: HealthCheck | { status: 'not_configured'; checkedAt: string; durationMs: null };
};

/**
 * GET /admin/dashboard: counts and statuses only (definitions in the backend
 * docs/admin.md → Overview). Every section is null when its source could not
 * be read: never shown as zero.
 */
export type AdminDashboard = {
  /** Server time the counts were taken (UTC). */
  generatedAt: string;
  /** CUSTOMER accounts only; newLast7Days = created in the 168 hours before generatedAt. */
  customers: {
    total: number;
    active: number;
    suspended: number;
    passed: number;
    deleted: number;
    newLast7Days: number;
  } | null;
  deathVerification: { pending: number; safeguardActive: number; readyForReview: number } | null;
  /** Messages due by the release rules but still SCHEDULED (includes blocked ones); same as /admin/releases?pastDue=true. */
  releases: { pastDue: number } | null;
  /** "Message waiting" emails: retrying = an attempt failed, more to come; failed = given up. */
  releaseEmails: { retrying: number; failed: number } | null;
  /** Summed over the allowlisted queues; null = Redis could not be read. */
  queues: { waiting: number; active: number; delayed: number; failed: number } | null;
  deadLetters: { open: number } | null;
  /** Recorded ADMIN_MFA_FAILED audit rows in the last 7 days (rows, not attempts). */
  security: { adminMfaFailuresLast7Days: number } | null;
  /** The System Health snapshot's statuses (same checks). */
  services: {
    database: SystemHealth['database']['status'];
    redis: SystemHealth['redis']['status'];
    worker: SystemHealth['worker']['status'];
    malwareScanner: SystemHealth['malwareScanner']['status'];
  };
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
  /** Present only for SUPER_ADMIN viewers; null = an admin account or no billing data. */
  billing?: BillingSummary | null;
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
  | 'DEATH_TRIGGER_ACTIVATION_COMPLETED'
  | 'EVIDENCE_UPLOADED'
  | 'EVIDENCE_VIEWED_BY_ADMIN';

/** Phase 19A: supporting file metadata; opened only through the audited access-url call. */
export type DeathCaseEvidence = {
  id: string;
  deathReportId: string;
  /** Cleaned display name (no path or control characters). */
  originalFileName: string;
  mimeType: string;
  sizeBytes: number;
  status: 'PENDING_UPLOAD' | 'READY' | 'FAILED';
  uploadedAt: string | null;
  createdAt: string;
};

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
  evidence: DeathCaseEvidence[];
  /** Phase 19B: snapshotted when the case opened (1 or 2); null on older closed cases. */
  requiredConfirmations: number | null;
  /** Distinct Trusted Contacts (by email) who reported. Admin-only. */
  receivedConfirmations: number;
  /** A prerequisite for verify (the API enforces it); never a verification. */
  confirmationRequirementMet: boolean;
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
  'DEAD_LETTER_RETRY_REQUESTED',
  'IP_BLOCK_CREATED',
  'IP_BLOCK_REVOKED',
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

// ─── Security activity ──────────────────────────────────────────────────────

/** Server-side projection of security audit rows (docs/admin.md §20). */
export const SECURITY_CATEGORIES = [
  'admin_sign_in',
  'mfa_failure',
  'recovery_code',
  'mfa_setup',
  'account_status',
  'account_credentials',
  'ip_controls',
] as const;
export type SecurityCategory = (typeof SECURITY_CATEGORIES)[number];
export const SECURITY_OUTCOMES = ['failed', 'completed'] as const;
export type SecurityOutcome = (typeof SECURITY_OUTCOMES)[number];
export const SECURITY_ACTOR_TYPES = ['ADMIN', 'SUPER_ADMIN', 'CUSTOMER'] as const;

export type SecurityEvent = {
  reference: string;
  recordedAt: string;
  /** A backend AuditEventType; labelled from a fixed map, unknown values shown as-is. */
  eventType: string;
  category: SecurityCategory;
  outcome: SecurityOutcome;
  actorType: AuditActorType;
  actorUserId: string | null;
  /** The User the event is about, as recorded by the server. */
  accountId: string | null;
  /** IPv4 /24 or IPv6 /48 as seen by the API; never a full address. */
  network: string | null;
  /** The proxy chain was verified when this row was written. Says nothing about who sent it. */
  sourceTrusted: boolean;
  /** Admin two-factor failures only; null fields = not recorded. */
  reason: { method: 'totp' | 'recovery' | 'challenge' | null; code: string | null; challengeInvalidated: boolean } | null;
};

export type SecurityPage = Page<SecurityEvent> & {
  evaluatedAt: string;
  window: { from: string; to: string };
  /** Stored rows per category in the window (other filters not applied). */
  counts: Record<SecurityCategory, number>;
  /** Zero-filled stored rows per local day or hour; date range only, like `counts`. */
  series: SecuritySeries;
  /** Most frequent masked networks in the window; never an exact address. */
  sources: { network: string; count: number }[];
  sourcesTrusted: boolean;
};

export type SecuritySeries = {
  unit: 'day' | 'hour';
  timeZone: string;
  /** `bin` is wall-clock text in `timeZone`, e.g. 2026-11-05T00:00. */
  bins: { bin: string; signIn: number; mfaFailure: number }[];
};

export const IP_BLOCK_STATUSES = ['active', 'expired', 'revoked'] as const;
export type IpBlockStatus = (typeof IP_BLOCK_STATUSES)[number];

export type IpBlock = {
  id: string;
  /** Super admins only; other admins get null and see `network`. */
  ip: string | null;
  network: string | null;
  reason: string | null;
  createdByName: string | null;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  revokedByName: string | null;
  status: IpBlockStatus;
};

export type IpBlockControls = {
  /** Proxy attribution verified for this deployment; only then are blocks created and enforced. */
  available: boolean;
  superAdmin: boolean;
  recentAuth: boolean;
  activeCount: number;
};

export type IpBlockPage = Page<IpBlock> & { controls: IpBlockControls };
export type IpBlockFilters = { page: number; status?: IpBlockStatus };
export type CreateIpBlockInput = { ip: string; durationMinutes: number; reason: string };

export type SecurityFilters = {
  page: number;
  category?: SecurityCategory;
  outcome?: SecurityOutcome;
  actorType?: (typeof SECURITY_ACTOR_TYPES)[number];
  reference?: string;
  accountId?: string;
  /** ISO 8601 with offset. */
  from?: string;
  to?: string;
  /** IANA zone for the graph's bins. */
  tz?: string;
};

// ─── Storage & scans ────────────────────────────────────────────────────────

/** Stored-file metadata only (docs/admin.md §21): never names, keys, MIME types or links. */
export const STORAGE_ASSET_SOURCES = ['MESSAGE', 'MEMORY_VAULT', 'MY_STORY', 'MY_WISHES', 'RECIPIENT_PHOTO', 'DEATH_EVIDENCE'] as const;
export type StorageAssetSource = (typeof STORAGE_ASSET_SOURCES)[number];
export const UPLOAD_STATES = ['pending', 'ready', 'failed'] as const;
export type UploadState = (typeof UPLOAD_STATES)[number];
export const DELETION_STATES = ['active', 'pending', 'confirmed'] as const;
export type DeletionState = (typeof DELETION_STATES)[number];
export const ASSET_KINDS = ['PHOTO', 'AUDIO', 'VIDEO'] as const;

export type StorageAsset = {
  reference: string;
  source: StorageAssetSource;
  /** null for death-verification evidence (no kind column). */
  kind: (typeof ASSET_KINDS)[number] | null;
  /** Owner; null for evidence (not shown). */
  accountId: string | null;
  sizeBytes: number;
  /** true only once the upload was verified against the stored object (READY). */
  sizeVerified: boolean;
  uploadState: UploadState;
  deletion: DeletionState;
  legacyStorage: boolean;
  createdAt: string;
  updatedAt: string;
  /** When it became READY (all checks passed); null otherwise. */
  verifiedAt: string | null;
  deletedAt: string | null;
  storageDeletedAt: string | null;
};

export type SourceTotals = {
  pending: number;
  ready: number;
  failed: number;
  verifiedBytes: number;
  reservedBytes: number;
  deletionPending: number;
  deletionConfirmed: number;
  total: number;
};

export type StoragePage = Page<StorageAsset> & {
  evaluatedAt: string;
  /** null = the totals could not be read (never zeros). */
  summary: Record<StorageAssetSource, SourceTotals> | null;
};

export type StorageAssetFilters = {
  page: number;
  source?: StorageAssetSource;
  uploadState?: UploadState;
  deletion?: DeletionState;
  kind?: (typeof ASSET_KINDS)[number];
  reference?: string;
  accountId?: string;
  /** ISO 8601 with offset (created time). */
  from?: string;
  to?: string;
};

// ─── Support (Step 7) ───────────────────────────────────────────────────────

/** Admin view: the public conversation (with author ids) and internal notes, kept apart. */
export type AdminSupportRequest = SupportSummary & {
  ownerUserId: string;
  description: string;
  updatedAt: string;
  messages: (SupportMessage & { authorUserId: string })[];
  internalNotes: { id: string; authorUserId: string; body: string; createdAt: string }[];
};
export type AdminSupportSummary = SupportSummary & { ownerUserId: string };

export type AdminSupportFilters = {
  page: number;
  status?: SupportStatus;
  category?: SupportCategory;
  reference?: string;
  accountId?: string;
  /** ISO 8601 with offset (created time). */
  from?: string;
  to?: string;
};

// ─── AI operations (Step 8) ─────────────────────────────────────────────────

export const AI_WINDOWS = ['24h', '7d'] as const;
export type AiWindow = (typeof AI_WINDOWS)[number];
export const AI_PAGES = ['dashboard', 'people', 'trusted-contacts', 'messages', 'memory-vault', 'my-story', 'my-wishes', 'account'] as const;
export const AI_ACTIONS = ['ask', 'draft', 'improve', 'shorten', 'expand', 'questions', 'caption'] as const;
export const AI_REQUEST_OUTCOMES = [
  'reply',
  'reply_truncated',
  'empty_reply',
  'not_configured',
  'user_limit',
  'global_limit',
  'concurrency_limit',
  'limits_unavailable',
  'provider_rate_limited',
  'provider_config',
  'provider_failure',
  'timeout',
  'cancelled',
  'unknown',
] as const;
export type AiRequestOutcome = (typeof AI_REQUEST_OUTCOMES)[number];
export const AI_ATTEMPT_RESULTS = ['ok', 'provider_429', 'provider_auth', 'provider_request', 'provider_5xx', 'network', 'malformed', 'timeout', 'cancelled'] as const;
export type AiAttemptResult = (typeof AI_ATTEMPT_RESULTS)[number];

export type AiFilters = { window?: AiWindow; area?: (typeof AI_PAGES)[number]; action?: (typeof AI_ACTIONS)[number] };

type AiBase = {
  evaluatedAt: string;
  window: AiWindow;
  filters: { area: string | null; action: string | null };
  /** Presence of the key only, the model and application limits (not provider quotas). */
  configuration: {
    configured: boolean;
    provider: string;
    model: string;
    perUserHour: number;
    globalAttemptsPerMinute: number;
    maxConcurrent: number;
    budgetMs: number;
    maxAttempts: number;
    maxCompletionTokens: number;
  };
};
export type AiOperations =
  | (AiBase & { monitoring: 'unavailable' })
  | (AiBase & {
      monitoring: 'available';
      period: { from: string; to: string };
      collectingSince: string | null;
      lastReplyAt: string | null;
      lastProviderFailureAt: string | null;
      requests: {
        total: number;
        byOutcome: Record<AiRequestOutcome, number>;
        meanMs: number | null;
        replyMeanMs: number | null;
        replySamples: number;
      };
      attempts: { total: number; retries: number; byResult: Record<AiAttemptResult, number>; meanMs: number | null };
      tokens: { reportedAttempts: number; unknownAttempts: number; input: number; output: number; total: number };
    });

// ─── Admin access (Step 9, read-only) ───────────────────────────────────────

export type AdminRole = 'ADMIN' | 'SUPER_ADMIN';
export type AdminAccount = {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  role: AdminRole;
  status: UserStatus;
  createdAt: string;
  /** A confirmed authenticator; not whether any session passed MFA. */
  mfaEnrolled: boolean;
  /** The last completed admin sign-in recorded in the audit log; null = none recorded. */
  lastSignInAt: string | null;
  /** Invited and has not set a password yet. */
  invitationPending: boolean;
};
/** 'sent' = the email provider accepted the invitation email (not proof of delivery). */
export type InvitationResult = { id: string; invitation: 'sent' | 'not_sent' | 'capped' };
export type CreateAdminInput = { email: string; firstName: string; lastName: string };
export type AdminAccountDetail = AdminAccount & {
  mfaEnrolledAt: string | null;
  /** Computed on the server from the rules that enforce them. */
  permissions: {
    adminPortal: boolean;
    manageCustomerAccounts: boolean;
    manageAdminAccounts: boolean;
    manageSuperAdminAccounts: boolean;
    changeRoles: boolean;
  };
  /** Whether you may suspend/reactivate this account on the Users page (checked again there). */
  viewerCanManage: boolean;
  history: {
    reference: string;
    eventType: AuditEventType | 'EMAIL_CHANGED';
    actorType: AuditActorType;
    actorUserId: string | null;
    previousStatus: UserStatus | null;
    newStatus: UserStatus | null;
    recordedAt: string;
  }[];
};
export type AdminAccessFilters = {
  page: number;
  search?: string;
  role?: AdminRole;
  status?: UserStatus;
  mfa?: 'enrolled' | 'not_enrolled';
};

// ─── Subscriptions & payments (Step 10, SUPER_ADMIN only) ───────────────────

/** The same access state the Customer sees; no card, customer or payment details. */
export type BillingSummary = {
  accountId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  accountCreatedAt: string;
  state: AccessState;
  hasAccess: boolean;
  trialStartedAt: string | null;
  trialEndsAt: string | null;
  plan: string | null;
  subscriptionStatus: string | null;
  subscriptionReference: string | null;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: string | null;
  lastSyncedAt: string | null;
};
export const BILLING_FILTERS = ['trial_active', 'trial_expired', 'paid_active', 'cancellation_scheduled', 'payment_issue', 'payment_pending', 'access_ended'] as const;
export type BillingFilters = {
  page: number;
  state?: (typeof BILLING_FILTERS)[number];
  plan?: 'monthly' | 'annual' | 'unknown';
  accountId?: string;
  subscriptionReference?: string;
  /** ISO 8601 with offset (account created). */
  from?: string;
  to?: string;
};
export type BillingPage = Page<BillingSummary> & { evaluatedAt: string; enabled: boolean; enforceFrom: string | null };

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
  // email-delivery jobs (Step 24) carry only their notification id.
  payload: { messageId?: string; caseId?: string; notificationId?: string };
};

// Phase 17A: durable dead letters (PostgreSQL). Ids and safe categories only.
export const DEAD_LETTER_QUEUES = ['message-release', 'death-verification', 'email-delivery'] as const;
export const DEAD_LETTER_STATUSES = ['OPEN', 'REQUEUED', 'RESOLVED'] as const;
export type DeadLetterStatus = (typeof DEAD_LETTER_STATUSES)[number];
export type OpsAlertStatus = 'PENDING' | 'SENT' | 'FAILED' | 'NOT_CONFIGURED';

export type DeadLetter = {
  id: string;
  queueName: string;
  jobId: string;
  jobName: string;
  // Message | MessageRecipientRelease | DeathVerificationCase | ReleaseNotification
  entityType: string;
  entityId: string | null;
  attemptsMade: number;
  errorCode: string | null;
  /** Sanitized by the API: first line, no URLs, emails or secrets. */
  errorMessage: string | null;
  failedAt: string;
  failureCount: number;
  status: DeadLetterStatus;
  resolution: string | null;
  requeuedAt: string | null;
  resolvedAt: string | null;
  alertStatus: OpsAlertStatus;
  alertedAt: string | null;
  createdAt: string;
};

export type DeadLetterFilters = { queue?: string; status?: DeadLetterStatus; page?: number };

// ─── Releases (read-only monitoring) ────────────────────────────────────────

export const RELEASE_STATUSES = ['SCHEDULED', 'RELEASED', 'CANCELLED'] as const;
export type ReleaseStatus = (typeof RELEASE_STATUSES)[number];
export const RELEASE_TRIGGERS = [
  'NOW',
  'FIXED_DATE',
  'CUSTOM_EVENT',
  'BIRTHDAY',
  'ANNIVERSARY',
  'ON_DEATH',
  'AFTER_DEATH',
  'ANNUAL_AFTER_DEATH',
] as const;
export type ReleaseTrigger = (typeof RELEASE_TRIGGERS)[number];
/** Computed by the API at evaluatedAt from stored rows; never persisted (docs/admin.md §16). */
export type ReleaseAssessment =
  | 'released'
  | 'cancelled'
  | 'past_due'
  | 'scheduled'
  | 'recurring'
  | 'awaiting_death_verification'
  | 'no_schedule';
export const RELEASE_SORTS = ['updatedAt', 'createdAt', 'scheduledFor'] as const;

export type ReleaseItem = {
  reference: string;
  accountId: string;
  status: ReleaseStatus;
  triggerType: ReleaseTrigger | null;
  scheduledFor: string | null;
  releasedAt: string | null;
  assessment: ReleaseAssessment;
  deathCaseStatus: CaseStatus | null;
  safeguardEndsAt: string | null;
  lastRecordedAt: string | null;
};
export type ReleasePage = Page<ReleaseItem> & { evaluatedAt: string };

export type ReleaseHistoryEvent =
  | 'schedule_saved'
  | 'schedule_changed'
  | 'death_trigger_activated'
  | 'released'
  | 'occurrence_released'
  | 'job_dead_lettered';

export type ReleaseDetail = {
  evaluatedAt: string;
  reference: string;
  accountId: string;
  status: ReleaseStatus;
  assessment: ReleaseAssessment;
  liveRecipients: number;
  schedule: {
    triggerType: ReleaseTrigger;
    scheduledFor: string | null;
    afterDeathDays: number | null;
    createdAt: string;
    updatedAt: string;
  } | null;
  release: { id: string; triggerType: ReleaseTrigger; scheduledFor: string | null; releasedAt: string; accessGrants: number } | null;
  deathActivation: {
    id: string;
    triggerType: ReleaseTrigger;
    activatedAt: string;
    dueAt: string;
    deathVerificationCaseId: string;
  } | null;
  deathCase: { id: string; status: CaseStatus; openedAt: string; safeguardEndsAt: string | null; verifiedAt: string | null } | null;
  occurrences: { released: number; pending: number; pastDue: number; nextDueAt: string | null };
  /** accepted = the email provider accepted it, not a confirmed delivery. */
  releaseEmails: { pending: number; retrying: number; accepted: number; failed: number };
  deadLetters: {
    id: string;
    queueName: string;
    errorCode: string | null;
    failedAt: string;
    failureCount: number;
    status: DeadLetterStatus;
  }[];
  history: { at: string; event: ReleaseHistoryEvent }[];
};

/** API filters (ISO instants); the page keeps calendar days in the URL. */
export type ReleaseFilters = {
  page: number;
  status?: ReleaseStatus;
  triggerType?: ReleaseTrigger;
  scheduledFrom?: string;
  scheduledTo?: string;
  reference?: string;
  accountId?: string;
  pastDue?: 'true';
  sort?: (typeof RELEASE_SORTS)[number];
  dir?: 'asc' | 'desc';
};

// ─── Deliveries (read-only monitoring, docs/admin.md §17) ────────────────────

export const DELIVERY_CATEGORIES = ['release_email', 'safety_notice'] as const;
export type DeliveryCategory = (typeof DELIVERY_CATEGORIES)[number];
export const RELEASE_EMAIL_STATUSES = ['queued', 'retrying', 'provider_accepted', 'failed'] as const;
export type ReleaseEmailStatus = (typeof RELEASE_EMAIL_STATUSES)[number];
export const SAFETY_NOTICE_STATUSES = ['queued', 'attempted', 'provider_accepted', 'not_sent_case_closed'] as const;
export type SafetyNoticeStatus = (typeof SAFETY_NOTICE_STATUSES)[number];
/** Allowlisted by the API; never a raw provider string. */
export const ERROR_CATEGORIES = [
  'timeout',
  'network_error',
  'token_unavailable',
  'auth_rejected',
  'unauthorized',
  'rate_limit_exceeded',
  'mailbox_not_found',
  'email_disabled',
  'unknown_error',
  'forbidden',
  'provider_error',
] as const;
export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

export type ReleaseEmailItem = {
  reference: string;
  channel: 'EMAIL';
  releaseReference: string;
  /** Opaque recipient id: tells similar rows apart without contact details. */
  recipientReference: string;
  /** Masked by the API (r***@g***.com); the full address never reaches the browser. */
  destination: string | null;
  yearlyOccurrence: boolean;
  status: ReleaseEmailStatus;
  /** Last attempt timed out or lost the connection: the provider may or may not have sent it. */
  lastAttemptUncertain: boolean;
  attemptCount: number;
  errorCategory: ErrorCategory | null;
  acceptedAt: string | null;
  failedAt: string | null;
  createdAt: string;
  updatedAt: string;
};
export type SafetyNoticeItem = {
  reference: string;
  channel: 'EMAIL';
  accountId: string;
  caseStatus: CaseStatus;
  status: SafetyNoticeStatus;
  attemptCount: number;
  lastAttemptAt: string | null;
  acceptedAt: string | null;
  createdAt: string;
  updatedAt: string;
};
export type DeliveryPage =
  | (Page<ReleaseEmailItem> & { evaluatedAt: string; category: 'release_email' })
  | (Page<SafetyNoticeItem> & { evaluatedAt: string; category: 'safety_notice' });

type DeadLetterRef = {
  id: string;
  queueName: string;
  errorCode: string | null;
  failedAt: string;
  failureCount: number;
  status: DeadLetterStatus;
};
export type ReleaseEmailDetail = Omit<ReleaseEmailItem, 'yearlyOccurrence'> & {
  evaluatedAt: string;
  category: 'release_email';
  /** The provider's id for an accepted email: not a delivery receipt. */
  providerMessageId: string | null;
  messageReleaseId: string;
  occurrence: { id: string; occurrenceYear: number; dueAt: string } | null;
  /** undefined = not looked up (already accepted); null = queue data unavailable. */
  queueJob?: { state: string; attemptsMade: number | null; maxAttempts: number | null } | null;
  deadLetters: DeadLetterRef[];
  history: { at: string; event: 'intent_created' | 'provider_accepted' | 'failed_for_good' | 'dead_lettered' }[];
};
export type SafetyNoticeDetail = SafetyNoticeItem & {
  evaluatedAt: string;
  category: 'safety_notice';
  caseEvents: { id: string; createdAt: string }[];
  history: { at: string; event: 'case_opened' | 'last_attempt_started' | 'provider_accepted' }[];
};

/** API filters (ISO instants); the page keeps calendar days in the URL. */
export type DeliveryFilters = {
  page: number;
  category?: DeliveryCategory;
  status?: ReleaseEmailStatus | SafetyNoticeStatus;
  outcomeUncertain?: 'true';
  errorCategory?: ErrorCategory;
  reference?: string;
  releaseReference?: string;
  createdFrom?: string;
  createdTo?: string;
  sort?: 'createdAt' | 'updatedAt';
  dir?: 'asc' | 'desc';
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
  // Ends only the admin session (for_after_admin_session) and audits ADMIN_LOGOUT;
  // a Customer signed in in the same browser stays signed in.
  logout: () => post<{ success: true }>('/admin-auth/logout'),
};

/** GET /admin/account: the signed-in admin's own account (explicit fields; no secrets, codes or session ids). */
export type OwnAdminAccount = {
  profile: { firstName: string | null; lastName: string | null; email: string; emailVerified: boolean; role: AdminRole };
  security: { twoFactorEnabled: boolean; twoFactorEnabledAt: string | null; recoveryCodesRemaining: number; passwordChangedAt: string | null };
  session: { signedInAt: string | null; twoFactorAt: string | null; idleTimeoutMinutes: number; expiresAt: string | null };
  /** From the audit log (sign-in events), not a list of live sessions. `device` is the browser's own user-agent text. */
  recentSignIns: { at: string; network: string | null; device: string | null }[];
};

export const adminAccountApi = {
  get: (signal?: AbortSignal) => apiRequest<OwnAdminAccount>('/admin/account', { signal }),
  updateProfile: (input: { firstName: string; lastName: string }) =>
    apiRequest<{ firstName: string; lastName: string }>('/admin/account/profile', { method: 'PATCH', body: input }),
  changePassword: (input: { currentPassword: string; newPassword: string }) => post<{ success: true }>('/admin/account/password', input),
  sendVerification: () => post<{ sent: true }>('/admin/account/verification'),
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
  /** Short-lived signed URL for one READY file; the view is recorded on the case timeline. */
  evidenceAccessUrl: (caseId: string, evidenceId: string) =>
    apiRequest<AccessUrl>(`/admin/death-verifications/${caseId}/evidence/${evidenceId}/access-url`),

  auditLogs: (f: AuditFilters, signal?: AbortSignal) =>
    apiRequest<Page<AuditLog>>(`/admin/audit-logs${toQuery(f)}`, { signal }),
  auditLog: (id: string, signal?: AbortSignal) => apiRequest<AuditLog>(`/admin/audit-logs/${id}`, { signal }),

  securityEvents: (f: SecurityFilters, signal?: AbortSignal) =>
    apiRequest<SecurityPage>(`/admin/security/events${toQuery(f)}`, { signal }),
  securityEvent: (reference: string, signal?: AbortSignal) =>
    apiRequest<SecurityEvent>(`/admin/security/events/${encodeURIComponent(reference)}`, { signal }),

  ipBlocks: (f: IpBlockFilters, signal?: AbortSignal) => apiRequest<IpBlockPage>(`/admin/security/ip-blocks${toQuery(f)}`, { signal }),
  createIpBlock: (input: CreateIpBlockInput) => post<IpBlock>('/admin/security/ip-blocks', input),
  revokeIpBlock: (id: string) => post<IpBlock>(`/admin/security/ip-blocks/${encodeURIComponent(id)}/revoke`),

  storageAssets: (f: StorageAssetFilters, signal?: AbortSignal) =>
    apiRequest<StoragePage>(`/admin/storage/assets${toQuery(f)}`, { signal }),
  storageAsset: (reference: string, signal?: AbortSignal) =>
    apiRequest<StorageAsset>(`/admin/storage/assets/${encodeURIComponent(reference)}`, { signal }),

  supportRequests: (f: AdminSupportFilters, signal?: AbortSignal) =>
    apiRequest<Page<AdminSupportSummary>>(`/admin/support/requests${toQuery(f)}`, { signal }),
  supportRequest: (id: string, signal?: AbortSignal) =>
    apiRequest<AdminSupportRequest>(`/admin/support/requests/${encodeURIComponent(id)}`, { signal }),
  // Separate commands: visibility is the endpoint, never a flag in the body.
  supportReply: (id: string, input: SupportTextInput) =>
    post<AdminSupportRequest>(`/admin/support/requests/${encodeURIComponent(id)}/replies`, input),
  supportNote: (id: string, input: SupportTextInput) =>
    post<AdminSupportRequest>(`/admin/support/requests/${encodeURIComponent(id)}/notes`, input),
  supportStatus: (id: string, input: { status: SupportStatus; expectedStatus: SupportStatus }) =>
    apiRequest<AdminSupportRequest>(`/admin/support/requests/${encodeURIComponent(id)}/status`, { method: 'PATCH', body: input }),

  aiOperations: (f: AiFilters, signal?: AbortSignal) =>
    apiRequest<AiOperations>(`/admin/system/ai${toQuery(f)}`, { signal }),

  adminAccounts: (f: AdminAccessFilters, signal?: AbortSignal) =>
    apiRequest<Page<AdminAccount>>(`/admin/access/admins${toQuery(f)}`, { signal }),
  adminAccount: (id: string, signal?: AbortSignal) =>
    apiRequest<AdminAccountDetail>(`/admin/access/admins/${encodeURIComponent(id)}`, { signal }),
  createAdmin: (input: CreateAdminInput) => post<InvitationResult>('/admin/access/admins', input),
  resendAdminInvitation: (id: string) => post<InvitationResult>(`/admin/access/admins/${encodeURIComponent(id)}/invitation`),

  billingAccounts: (f: BillingFilters, signal?: AbortSignal) =>
    apiRequest<BillingPage>(`/admin/billing/accounts${toQuery(f)}`, { signal }),

  queues: (signal?: AbortSignal) => apiRequest<QueueSummary[]>('/admin/system/queues', { signal }),
  systemHealth: (signal?: AbortSignal) => apiRequest<SystemHealth>('/admin/system/health', { signal }),

  releases: (f: ReleaseFilters, signal?: AbortSignal) =>
    apiRequest<ReleasePage>(`/admin/releases${toQuery(f)}`, { signal }),
  release: (reference: string, signal?: AbortSignal) =>
    apiRequest<ReleaseDetail>(`/admin/releases/${encodeURIComponent(reference)}`, { signal }),

  deliveries: (f: DeliveryFilters, signal?: AbortSignal) =>
    apiRequest<DeliveryPage>(`/admin/deliveries${toQuery(f)}`, { signal }),
  releaseEmail: (reference: string, signal?: AbortSignal) =>
    apiRequest<ReleaseEmailDetail>(`/admin/deliveries/release-emails/${encodeURIComponent(reference)}`, { signal }),
  safetyNotice: (reference: string, signal?: AbortSignal) =>
    apiRequest<SafetyNoticeDetail>(`/admin/deliveries/safety-notices/${encodeURIComponent(reference)}`, { signal }),
  failedJobs: (queue: string, page: number, signal?: AbortSignal) =>
    apiRequest<Page<FailedJob>>(`/admin/system/queues/${encodeURIComponent(queue)}/failed${toQuery({ page })}`, {
      signal,
    }),
  retry: (queue: string, jobId: string) =>
    post<{ queue: string; jobId: string; state: 'waiting' }>(
      `/admin/system/queues/${encodeURIComponent(queue)}/jobs/${encodeURIComponent(jobId)}/retry`,
    ),

  deadLetters: (f: DeadLetterFilters, signal?: AbortSignal) =>
    apiRequest<Page<DeadLetter>>(`/admin/system/dead-letters${toQuery(f)}`, { signal }),
  deadLetter: (id: string, signal?: AbortSignal) => apiRequest<DeadLetter>(`/admin/system/dead-letters/${id}`, { signal }),
  retryDeadLetter: (id: string) => post<DeadLetter>(`/admin/system/dead-letters/${id}/retry`),
};
