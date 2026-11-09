import type {
  AuditActorType,
  AuditEventType,
  AuditLog,
  DeathCaseEventType,
  ErrorCategory,
  ReleaseAssessment,
  ReleaseEmailStatus,
  ReleaseHistoryEvent,
  ReleaseTrigger,
  SafetyNoticeStatus,
  SecurityCategory,
  SecurityEvent,
  SecurityOutcome,
  DeletionState,
  StorageAssetSource,
  UploadState,
} from '@/lib/api/admin';
import type { UserRole, UserStatus } from '@/lib/api/auth';

// Admin portal wording and the few rules the UI mirrors from the API. The API
// stays authoritative: these only decide what to offer, never what is allowed.

export const ROLE_LABEL: Record<UserRole, string> = {
  CUSTOMER: 'Customer',
  ADMIN: 'Admin',
  SUPER_ADMIN: 'Super admin',
};

export const STATUS_LABEL: Record<UserStatus, string> = {
  ACTIVE: 'Active',
  SUSPENDED: 'Suspended',
  PASSED: 'Passed',
  DELETED: 'Deleted',
};

/**
 * Mirrors canManage() in for-after-backend/src/admin/admin.service.ts: ADMIN
 * manages Customers; SUPER_ADMIN also manages ADMINs; nobody manages a
 * SUPER_ADMIN or their own account.
 */
export const canManage = (actor: { id: string; role: UserRole }, target: { id: string; role: UserRole }) =>
  actor.id !== target.id &&
  (target.role === 'CUSTOMER' || (target.role === 'ADMIN' && actor.role === 'SUPER_ADMIN'));

export const personName = (p: { firstName: string | null; lastName: string | null }) =>
  [p.firstName, p.lastName].filter(Boolean).join(' ') || null;

export const AUDIT_EVENT_LABEL: Record<AuditEventType, string> = {
  ADMIN_PASSWORD_AUTH_SUCCEEDED: 'Admin password accepted',
  ADMIN_MFA_SETUP_COMPLETED: 'Admin two-factor set up',
  ADMIN_MFA_VERIFIED: 'Admin two-factor verified',
  ADMIN_MFA_FAILED: 'Admin two-factor failed',
  ADMIN_RECOVERY_CODE_USED: 'Admin recovery code used',
  ADMIN_LOGIN: 'Admin signed in',
  ADMIN_LOGOUT: 'Admin signed out',
  USER_SUSPENDED: 'User suspended',
  USER_REACTIVATED: 'User reactivated',
  ADMIN_VIEWED_USER: 'User record viewed',
  ADMIN_VIEWED_DEATH_CASE: 'Death case viewed',
  DEATH_VERIFICATION_VERIFIED: 'Death verified',
  DEATH_VERIFICATION_REJECTED: 'Death report rejected',
  FAILED_JOB_RETRIED: 'Failed job retried',
  PASSWORD_CHANGED: 'Customer changed their password',
  DEAD_LETTER_RETRY_REQUESTED: 'Dead-lettered job retried',
  IP_BLOCK_CREATED: 'Temporary IP block created',
  IP_BLOCK_REVOKED: 'Temporary IP block revoked',
};

export const AUDIT_ACTOR_LABEL: Record<AuditActorType, string> = {
  ADMIN: 'Admin',
  SUPER_ADMIN: 'Super admin',
  CUSTOMER: 'Customer',
};

export const CASE_EVENT_LABEL: Record<DeathCaseEventType, string> = {
  REPORT_RECEIVED: 'Report received',
  SAFETY_NOTICE_SENT: 'Safety notice sent to the account holder',
  SAFEGUARD_STARTED: 'Safeguard period started',
  SAFEGUARD_ELAPSED: 'Safeguard period ended: ready for review',
  CUSTOMER_CONFIRMED_ALIVE: 'Account holder confirmed they are alive',
  ADMIN_VERIFIED: 'Verified by an admin',
  ADMIN_REJECTED: 'Rejected by an admin',
  DEATH_TRIGGER_ACTIVATION_STARTED: 'Death-triggered messages: activation started',
  DEATH_TRIGGER_ACTIVATION_COMPLETED: 'Death-triggered messages: activation completed',
  EVIDENCE_UPLOADED: 'Supporting evidence uploaded',
  EVIDENCE_VIEWED_BY_ADMIN: 'Supporting evidence viewed by an admin',
};

// Defence in depth, same pattern as the API's audit writer: a key that looks
// like a secret or private content is never rendered, whatever the API sends.
const SENSITIVE_KEY = /pass|secret|token|code|otp|cookie|session|note|content|answer|url|key/i;

export const safeMetadata = (metadata: AuditLog['metadata']) =>
  Object.entries(metadata ?? {}).filter(([k, v]) => !SENSITIVE_KEY.test(k) && (v === null || typeof v !== 'object'));

/** One line for the list, from the metadata shapes the API writes today. */
export function auditSummary({ metadata }: AuditLog) {
  const m = Object.fromEntries(safeMetadata(metadata));
  const text = (v: unknown) => (typeof v === 'string' ? v.replaceAll('_', ' ').toLowerCase() : null);
  if (m.previousStatus && m.newStatus) return `${text(m.previousStatus)} → ${text(m.newStatus)}`;
  if (m.queue) return `Queue ${m.queue}`;
  if (typeof m.remaining === 'number') return `${m.remaining} recovery codes left`;
  if (m.method) return [text(m.method), text(m.reason)].filter(Boolean).join(': ');
  if (m.newStatus) return text(m.newStatus);
  return null;
}

/** Shortened id for dense lists; the full id is in the title/detail. */
export const shortId = (id: string) => (id.length > 12 ? `${id.slice(0, 8)}…` : id);

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// URL search params → typed filters. Anything unexpected is dropped, so a
// hand-edited URL never sends a value the API would reject.
type Param = string | string[] | undefined;
const one = (v: Param) => (Array.isArray(v) ? v[0] : v);
export const pageParam = (v: Param) => {
  const n = Number(one(v));
  return Number.isInteger(n) && n >= 1 && n <= 100_000 ? n : 1;
};
export const textParam = (v: Param, max = 200) => one(v)?.trim().slice(0, max) || undefined;
export const enumParam = <T extends string>(v: Param, values: readonly T[]) =>
  values.find((x) => x === one(v));

/** previousStatus → "Previous status" (metadata keys are camelCase). */
export const keyLabel = (key: string) => {
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

// ─── Releases (docs/admin.md §16) ───────────────────────────────────────────

/** Operational labels (admin wording, not the Customer's). */
export const TRIGGER_LABEL: Record<ReleaseTrigger, string> = {
  NOW: 'Send now',
  FIXED_DATE: 'Fixed date',
  CUSTOM_EVENT: 'Custom event',
  BIRTHDAY: 'Birthday (yearly)',
  ANNIVERSARY: 'Anniversary (yearly)',
  ON_DEATH: 'On verified death',
  AFTER_DEATH: 'After verified death',
  ANNUAL_AFTER_DEATH: 'Yearly after verified death',
};

/** The API's current assessment → label, tone and what it means. Never persisted. */
export const ASSESSMENT: Record<
  ReleaseAssessment,
  { label: string; tone: 'neutral' | 'open' | 'done' | 'warning' | 'danger'; description: string }
> = {
  released: { label: 'Released', tone: 'done', description: 'A release is recorded for this message.' },
  cancelled: { label: 'Cancelled', tone: 'neutral', description: 'The message is cancelled; nothing will be released.' },
  past_due: {
    label: 'Past due, not yet released',
    tone: 'warning',
    description:
      'Due by its schedule but no release is recorded yet. The worker normally releases within moments; one it refuses (for example no remaining recipients) stays here. The reason is only in the worker logs.',
  },
  scheduled: { label: 'Scheduled', tone: 'open', description: 'Due at a future time.' },
  recurring: {
    label: 'Recurring',
    tone: 'open',
    description: 'Released per recipient each year; the next occurrence is not due yet.',
  },
  awaiting_death_verification: {
    label: 'Waiting for a verified death',
    tone: 'neutral',
    description: 'Releases only after a death is verified; no date exists until then.',
  },
  no_schedule: {
    label: 'Scheduled, no schedule found',
    tone: 'danger',
    description: 'The message is marked scheduled but has no schedule row, so the worker cannot release it.',
  },
};

export const HISTORY_LABEL: Record<ReleaseHistoryEvent, string> = {
  schedule_saved: 'Current schedule saved',
  schedule_changed: 'Current schedule last changed',
  death_trigger_activated: 'Death trigger activated (death verified)',
  released: 'Release recorded',
  occurrence_released: 'Yearly occurrence released',
  job_dead_lettered: 'Background job failed for good (dead letter)',
};

// ─── Deliveries (docs/admin.md §17) ─────────────────────────────────────────

type StatusInfo = { label: string; tone: 'neutral' | 'open' | 'done' | 'warning' | 'danger'; description: string };

/** Never "Delivered": no provider confirms delivery (no webhooks). */
export const RELEASE_EMAIL_STATUS: Record<ReleaseEmailStatus, StatusInfo> = {
  queued: {
    label: 'Waiting to send',
    tone: 'neutral',
    description: 'Recorded; no attempt has finished yet (one may be in progress).',
  },
  retrying: {
    label: 'Retrying after a failed attempt',
    tone: 'warning',
    description: 'At least one attempt failed; the queue retries it automatically.',
  },
  provider_accepted: {
    label: 'Accepted by the email provider',
    tone: 'done',
    description: 'The provider accepted the email. That is not confirmation it reached the inbox.',
  },
  failed: {
    label: 'Failed for good',
    tone: 'danger',
    description: 'Retries ran out or the error cannot be retried. No more attempts are made.',
  },
};

export const SAFETY_NOTICE_STATUS: Record<SafetyNoticeStatus, StatusInfo> = {
  queued: { label: 'Waiting to send', tone: 'neutral', description: 'No attempt has been recorded yet.' },
  attempted: {
    label: 'Attempted, not accepted yet',
    tone: 'warning',
    description:
      'At least one attempt started but none was accepted. It may be in progress, or it failed and is retried while the case is pending. Failure reasons are not stored.',
  },
  provider_accepted: {
    label: 'Accepted by the email provider',
    tone: 'done',
    description:
      'The provider accepted the notice and the safeguard period started. That is not confirmation it reached the inbox.',
  },
  not_sent_case_closed: {
    label: 'Not sent (case closed)',
    tone: 'neutral',
    description: 'The case left pending verification before a notice was accepted, so none will be sent.',
  },
};

export const ERROR_CATEGORY_LABEL: Record<ErrorCategory, string> = {
  timeout: 'Timed out (outcome uncertain)',
  network_error: 'Network error (outcome uncertain)',
  token_unavailable: 'Provider sign-in unavailable',
  auth_rejected: 'Provider sign-in rejected',
  unauthorized: 'Unauthorised at the provider',
  rate_limit_exceeded: 'Rate limited by the provider',
  mailbox_not_found: 'Sending mailbox not found',
  email_disabled: 'Email sending disabled',
  unknown_error: 'Unknown error',
  forbidden: 'Refused by the provider',
  provider_error: 'Other provider error',
};

// ─── Security activity (docs/admin.md §20) ─────────────────────────────────
// Factual labels for recorded events; none of them claims an attack.

export const SECURITY_CATEGORY_LABEL: Record<SecurityCategory, string> = {
  admin_sign_in: 'Admin sign-in and sign-out',
  mfa_failure: 'Admin two-factor failed',
  recovery_code: 'Admin recovery code used',
  mfa_setup: 'Admin two-factor set up',
  account_status: 'Account suspended or reactivated',
  account_credentials: 'Password or email changed',
  ip_controls: 'Temporary IP block created or revoked',
};

export const SECURITY_OUTCOME: Record<SecurityOutcome, StatusInfo> = {
  failed: { label: 'Failed', tone: 'warning', description: 'The step was refused. One failure is not evidence of an attack.' },
  completed: { label: 'Completed', tone: 'neutral', description: 'The recorded action or sign-in step completed.' },
};

/** Includes the account events the generic audit list does not label yet. */
export const SECURITY_EVENT_LABEL: Record<string, string> = {
  ...AUDIT_EVENT_LABEL,
  USER_SUSPENDED: 'Account suspended',
  USER_REACTIVATED: 'Account reactivated',
  PASSWORD_RESET_COMPLETED: 'Password reset completed',
  EMAIL_CHANGE_REQUESTED: 'Email change requested',
  EMAIL_CHANGED: 'Email changed',
};

const MFA_METHOD_LABEL = { totp: 'Authenticator code', recovery: 'Recovery code', challenge: 'Sign-in attempt' } as const;
const MFA_REASON_LABEL: Record<string, string> = {
  wrong_code: 'Code not accepted',
  replay: 'Code already used',
  already_used: 'Sign-in step already completed',
  attempts_exhausted: 'Attempt limit reached',
};

/** A two-factor failure's recorded reason, in words; never raw stored text. */
export function securityReason(r: SecurityEvent['reason']) {
  if (!r) return null;
  const parts = [
    r.method ? MFA_METHOD_LABEL[r.method] : null,
    r.code ? (MFA_REASON_LABEL[r.code] ?? null) : 'Reason not recorded',
    r.challengeInvalidated ? 'password step must be repeated' : null,
  ].filter(Boolean);
  return parts.join(' · ');
}

// ─── Storage & scans (docs/admin.md §21) ───────────────────────────────────
// Stored states only; no scan result is stored per file, so none is shown.

export const STORAGE_SOURCE_LABEL: Record<StorageAssetSource, string> = {
  MESSAGE: 'Messages',
  MEMORY_VAULT: 'Memory Vault',
  MY_STORY: 'My Story',
  MY_WISHES: 'My Wishes',
  RECIPIENT_PHOTO: 'Recipient photos',
  DEATH_EVIDENCE: 'Death verification evidence',
};

export const UPLOAD_STATE: Record<UploadState, StatusInfo> = {
  pending: {
    label: 'Awaiting upload or checks',
    tone: 'open',
    description:
      'Not yet uploaded, or its checks have not completed (including when the scanner could not finish). Inaccessible until verified; retired after 24 hours.',
  },
  ready: {
    label: 'Verified',
    tone: 'done',
    description:
      'Passed the upload checks in force when it was completed: exact size, file type and signature, and (since 8 October 2026) a malware scan. Not a guarantee of present-day safety.',
  },
  failed: {
    label: 'Failed verification',
    tone: 'warning',
    description:
      'Refused at upload: a type mismatch or a detected threat. Which one is not recorded. Never accessible; its file is removed.',
  },
};

export const DELETION_STATE: Record<DeletionState, StatusInfo> = {
  active: { label: 'Not marked for removal', tone: 'neutral', description: 'The record is live.' },
  pending: {
    label: 'Removal pending',
    tone: 'open',
    description:
      'Deleted or failed; the stored file has not yet been confirmed removed. The cleanup job retries automatically (legacy B2 files only on their owner’s request).',
  },
  confirmed: {
    label: 'Removal recorded',
    tone: 'neutral',
    description: 'The storage provider accepted the delete (or had no file). Provider billing is not checked.',
  },
};
