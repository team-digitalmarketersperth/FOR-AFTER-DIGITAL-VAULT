import type { AuditEventType, AuditLog, DeathCaseEventType } from '@/lib/api/admin';
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
