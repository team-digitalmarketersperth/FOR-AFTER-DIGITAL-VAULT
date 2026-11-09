import { apiRequest } from './client';
import type { Page } from './admin';

// Mirrors the backend (announcements.dto.ts); the server enforces every limit.
export const NAME_MAX = 120;
export const SUBJECT_MAX = 150;
export const BODY_MAX = 5000;
export const CTA_LABEL_MAX = 60;

// shortcut: labels mirror the backend allowlist keys (ANNOUNCEMENT_DESTINATIONS); serve them from the API if the list grows.
export const DESTINATIONS = { DASHBOARD: 'Dashboard', SUPPORT: 'Help & Support' } as const;
export type Destination = keyof typeof DESTINATIONS;

type AdminRef = { id: string; firstName: string | null; lastName: string | null; email: string };

export type AnnouncementContent = {
  subject: string;
  body: string;
  ctaLabel: string | null;
  ctaDestination: Destination | null;
};
export type AnnouncementInput = AnnouncementContent & { name: string };

export type AnnouncementSummary = {
  id: string;
  status: 'DRAFT';
  name: string;
  subject: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  createdBy: AdminRef;
  /** The customer run, if any (admin tests never set it). issues = recipients FAILED, UNKNOWN, SKIPPED or CANCELLED. */
  broadcast: { id: string; status: BroadcastStatus; audience: AudienceScope; issues: number } | null;
};
// Step 2. ACCEPTED = the email provider accepted it (not proof of delivery); UNKNOWN = it may have been accepted.
export type TestSendStatus = 'QUEUED' | 'PROCESSING' | 'ACCEPTED' | 'FAILED' | 'UNKNOWN';
export type TestSend = {
  id: string;
  status: TestSendStatus;
  announcementVersion: number;
  lastErrorCode: string | null;
  createdAt: string;
  acceptedAt: string | null;
  finishedAt: string | null;
};

// Step 4 run states. COMPLETED = processing finished, not "every customer received it".
export type BroadcastStatus = 'PREPARING' | 'SENDING' | 'COMPLETED' | 'CANCELLED' | 'BLOCKED';
// Per-customer outcomes. ACCEPTED = the email provider accepted it (never "delivered").
export type RecipientState = 'QUEUED' | 'PROCESSING' | 'ACCEPTED' | 'FAILED' | 'UNKNOWN' | 'SKIPPED' | 'CANCELLED';

/**
 * latestTest (GET only): the signed-in admin's own most recent test of this draft.
 * broadcast (GET only): the one customer broadcast of this announcement, if any.
 */
/** Step 7: who a send would reach. PILOT (default) = only the explicitly selected pilot members. */
export type AudienceScope = 'PILOT' | 'ALL_ELIGIBLE';

export type Announcement = Omit<AnnouncementSummary, 'broadcast'> &
  AnnouncementContent & {
    updatedBy: AdminRef;
    audience?: AudienceScope;
    latestTest?: TestSend | null;
    broadcast?: { id: string; status: BroadcastStatus; announcementVersion: number } | null;
  };

export type AnnouncementPreview = {
  from: { name: string; address: string | null };
  subject: string;
  html: string;
  text: string;
};

/** Why a Customer would not get an announcement (one primary reason each), or 'pass'. */
export type EligibilityStatus =
  | 'pass'
  | 'account_unavailable'
  | 'email_invalid'
  | 'email_not_verified'
  | 'open_death_report'
  | 'suppressed'
  | 'no_consent';

/**
 * Counts only, a snapshot at checkedAt, for the draft's audience scope (the
 * pilot group or every Customer). eligible is null while any policy blocker is open.
 */
export type AudienceReview = {
  announcementId: string;
  version: number;
  audience: AudienceScope;
  purpose: string;
  checkedAt: string;
  state: 'ELIGIBILITY_NOT_CONFIRMED' | 'CONFIRMED';
  candidates: number;
  eligible: number | null;
  excluded: number;
  exclusions: {
    accountUnavailable: number;
    emailInvalid: number;
    emailNotVerified: number;
    openDeathReport: number;
    suppressed: number;
    noConsent: number;
  };
  blockers: { code: string; message: string }[];
};

/** The pilot group: explicitly chosen Customer accounts (SUPER_ADMIN view; addresses are the ones the admin entered). */
export type PilotGroup = {
  audience: AudienceScope;
  max: number;
  members: { userId: string; email: string; firstName: string | null; lastName: string | null; status: EligibilityStatus }[];
};

/** Step 4: what "Queue announcement" would send. reviewToken is null whenever sending is not possible. */
export type BroadcastReview = {
  announcementId: string;
  version: number;
  checkedAt: string;
  from: { name: string; address: string | null };
  subject: string;
  html: string;
  purpose: string | null;
  audience: AudienceScope;
  candidates: number;
  eligible: number | null;
  excluded: number;
  exclusions: AudienceReview['exclusions'];
  blockers: { code: string; message: string }[];
  reviewToken: string | null;
  expiresAt: string | null;
};

/** Aggregates only (no addresses). prepared is the denominator only once audiencePrepared is true. */
export type Broadcast = {
  id: string;
  announcementId: string;
  announcementVersion: number;
  subject: string;
  status: BroadcastStatus;
  audience: AudienceScope;
  stopping: boolean;
  finishReason: string | null;
  reviewedCount: number;
  createdAt: string;
  preparedAt: string | null;
  completedAt: string | null;
  cancelRequestedAt: string | null;
  requestedBy: AdminRef;
  cancelledBy: AdminRef | null;
  prepared: number;
  audiencePrepared: boolean;
  counts: Record<RecipientState, number>;
  // QUEUED codes = waiting to retry after a failure the provider did not accept (e.g. throttling).
  reasons: Record<'QUEUED' | 'SKIPPED' | 'FAILED' | 'UNKNOWN', Record<string, number>>;
  lastUpdatedAt: string;
  /** Set while the worker deliberately waits (provider Retry-After or the daily broadcast limit). */
  pausedUntil: string | null;
  /** Manual retry summary (GET only): failures that can be retried now, why not, recent requests. */
  retry?: RetrySummary;
};

export type RetrySummary = {
  eligible: number;
  /** Why no retry is possible now (run stopped, broadcasting off, pilot only, policy), or null. */
  blockedReason: string | null;
  limit: number;
  activity: { id: string; createdAt: string; scope: 'ONE' | 'ALL'; recipientCount: number; requestedBy: AdminRef }[];
};

/** One recipient of a run. email is null when the account's address changed after the email was prepared. */
export type RecipientResult = {
  id: string;
  email: string | null;
  name: string | null;
  status: RecipientState;
  reasonCode: string | null;
  attemptCount: number;
  lastAttemptAt: string | null;
  finishedAt: string | null;
  retryable: boolean;
  retryBlockedReason: string | null;
};
export type RecipientDetail = RecipientResult & {
  providerReference: boolean;
  history: {
    retriedAt: string;
    scope: 'ONE' | 'ALL';
    requestedBy: AdminRef;
    previousReasonCode: string | null;
    previousAttemptCount: number;
    previousAttemptedAt: string | null;
  }[];
};
export type RecipientQuery = { status?: RecipientState; q?: string; page: number };
export type RunEmail = { subject: string; announcementVersion: number; html: string; text: string };
export type RetryReview = {
  subject: string;
  announcementVersion: number;
  audience: AudienceScope;
  scope: 'ONE' | 'ALL';
  count: number;
  setHash: string;
  blockers: { code: string; message: string }[];
};

const BASE = '/admin/announcements';
const run = (id: string, runId: string) => `${BASE}/${encodeURIComponent(id)}/broadcasts/${encodeURIComponent(runId)}`;

export const announcementsApi = {
  list: (page: number, signal?: AbortSignal) => apiRequest<Page<AnnouncementSummary>>(`${BASE}?page=${page}`, { signal }),
  get: (id: string, signal?: AbortSignal) => apiRequest<Announcement>(`${BASE}/${encodeURIComponent(id)}`, { signal }),
  create: (input: AnnouncementInput) => apiRequest<Announcement>(BASE, { method: 'POST', body: input }),
  update: (id: string, input: AnnouncementInput & { expectedVersion: number }) =>
    apiRequest<Announcement>(`${BASE}/${encodeURIComponent(id)}`, { method: 'PUT', body: input }),
  preview: (content: AnnouncementContent) =>
    apiRequest<AnnouncementPreview>(`${BASE}/preview`, { method: 'POST', body: content }),
  /** The signed-in admin's own verified email, or null: the only place a test can go. */
  testDestination: (signal?: AbortSignal) => apiRequest<{ email: string | null }>(`${BASE}/test-destination`, { signal }),
  requestTest: (id: string, input: { clientOperationId: string; expectedVersion: number }) =>
    apiRequest<TestSend>(`${BASE}/${encodeURIComponent(id)}/test-sends`, { method: 'POST', body: input }),
  audience: (id: string, signal?: AbortSignal) => apiRequest<AudienceReview>(`${BASE}/${encodeURIComponent(id)}/audience`, { signal }),
  getTest: (id: string, testId: string, signal?: AbortSignal) =>
    apiRequest<TestSend>(`${BASE}/${encodeURIComponent(id)}/test-sends/${encodeURIComponent(testId)}`, { signal }),
  broadcastReview: (id: string, expectedVersion: number) =>
    apiRequest<BroadcastReview>(`${BASE}/${encodeURIComponent(id)}/broadcast-review`, { method: 'POST', body: { expectedVersion } }),
  queueBroadcast: (id: string, input: { clientOperationId: string; expectedVersion: number; reviewToken: string }) =>
    apiRequest<Broadcast>(`${BASE}/${encodeURIComponent(id)}/broadcasts`, { method: 'POST', body: input }),
  pilot: (id: string, signal?: AbortSignal) => apiRequest<PilotGroup>(`${BASE}/${encodeURIComponent(id)}/pilot`, { signal }),
  setAudience: (id: string, audience: AudienceScope) =>
    apiRequest<PilotGroup>(`${BASE}/${encodeURIComponent(id)}/audience-scope`, { method: 'PUT', body: { audience } }),
  addPilot: (id: string, email: string) => apiRequest<PilotGroup>(`${BASE}/${encodeURIComponent(id)}/pilot`, { method: 'POST', body: { email } }),
  removePilot: (id: string, userId: string) =>
    apiRequest<PilotGroup>(`${BASE}/${encodeURIComponent(id)}/pilot/${encodeURIComponent(userId)}`, { method: 'DELETE' }),
  getBroadcast: (id: string, runId: string, signal?: AbortSignal) =>
    apiRequest<Broadcast>(`${BASE}/${encodeURIComponent(id)}/broadcasts/${encodeURIComponent(runId)}`, { signal }),
  cancelBroadcast: (id: string, runId: string) =>
    apiRequest<Broadcast>(`${BASE}/${encodeURIComponent(id)}/broadcasts/${encodeURIComponent(runId)}/cancel`, { method: 'POST' }),
  recipients: (id: string, runId: string, { status, q, page }: RecipientQuery, signal?: AbortSignal) => {
    const params = new URLSearchParams({ page: String(page), limit: '25' });
    if (status) params.set('status', status);
    if (q) params.set('q', q);
    return apiRequest<Page<RecipientResult>>(`${run(id, runId)}/recipients?${params}`, { signal });
  },
  recipient: (id: string, runId: string, recipientId: string, signal?: AbortSignal) =>
    apiRequest<RecipientDetail>(`${run(id, runId)}/recipients/${encodeURIComponent(recipientId)}`, { signal }),
  runEmail: (id: string, runId: string, signal?: AbortSignal) => apiRequest<RunEmail>(`${run(id, runId)}/email`, { signal }),
  retryReview: (id: string, runId: string, recipientId?: string) =>
    apiRequest<RetryReview>(`${run(id, runId)}/retry-review`, { method: 'POST', body: recipientId ? { recipientId } : {} }),
  retry: (id: string, runId: string, input: { clientOperationId: string; setHash: string; recipientId?: string }) =>
    apiRequest<{ retryId: string; count: number }>(`${run(id, runId)}/retries`, { method: 'POST', body: input }),
};
