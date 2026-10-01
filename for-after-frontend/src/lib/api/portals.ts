import { apiRequest } from './client';
import type { ContentType } from './messages';

// Recipient Portal, Trusted Contact Portal and the Customer's own death-
// verification status. Recipients and Trusted Contacts are not Users: each has
// its own HttpOnly cookie, Redis session and /me route, and the browser may
// hold all three sessions at once. Nothing here reads or sets a cookie.

export type PortalMe = { authenticated: true; email: string };
export type OtpChallenge = { challengeId: string; message: string };

/** Email → 6-digit code sign-in, identical in shape for both portals. */
function otpAuth(base: 'recipient-auth' | 'trusted-contact-auth') {
  return {
    /** Always 202 with a challenge, whether or not the email is eligible. */
    requestOtp: (email: string) =>
      apiRequest<OtpChallenge>(`/${base}/request-otp`, { method: 'POST', body: { email } }),
    /** Sets the portal's session cookie on success. */
    verifyOtp: (challengeId: string, code: string) =>
      apiRequest<PortalMe>(`/${base}/verify-otp`, { method: 'POST', body: { challengeId, code } }),
    me: (signal?: AbortSignal) => apiRequest<PortalMe>(`/${base}/me`, { signal }),
    logout: () => apiRequest<void>(`/${base}/logout`, { method: 'POST' }),
  };
}

export const recipientAuthApi = otpAuth('recipient-auth');
export const trustedContactAuthApi = otpAuth('trusted-contact-auth');

// ─── Recipient ──────────────────────────────────────────────────────────────

// Released, granted content only; the API never sends the sender's account,
// other recipients or schedule details.
export type ReleasedMessage = {
  id: string;
  title: string;
  // VIDEO is not released today, but the database enum allows it.
  contentType: ContentType | 'VIDEO';
  releasedAt: string;
  hasMedia: boolean;
};
export type ReleasedMessageDetail = ReleasedMessage & { textContent: string | null };

export const recipientApi = {
  messages: (signal?: AbortSignal) => apiRequest<ReleasedMessage[]>('/recipient/messages', { signal }),
  message: (id: string, signal?: AbortSignal) =>
    apiRequest<ReleasedMessageDetail>(`/recipient/messages/${id}`, { signal }),
  // Media: mediaApi with scope { kind: 'recipient/messages', id }.
};

// ─── Death verification ─────────────────────────────────────────────────────

export const CASE_STATUSES = [
  'PENDING_VERIFICATION',
  'SAFEGUARD_ACTIVE',
  'READY_FOR_REVIEW',
  'VERIFIED',
  'REJECTED',
  'CANCELLED',
] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];
export const OPEN_CASE_STATUSES: readonly CaseStatus[] = ['PENDING_VERIFICATION', 'SAFEGUARD_ACTIVE', 'READY_FOR_REVIEW'];

export type TrustedAccount = {
  trustedContactId: string;
  accountHolder: { displayName: string };
  relationship: string | null;
  hasPreservedContent: boolean;
  deathVerificationStatus: CaseStatus | null;
};

export type CaseStatusForReporter = {
  status: CaseStatus | null;
  reportedByYou: boolean;
  openedAt: string | null;
};

export type DeathReportInput = {
  /** Calendar date "YYYY-MM-DD", never a timestamp. */
  reportedDateOfDeath: string | null;
  note: string | null;
  confirmReport: true;
};

export type DeathReportReceipt = {
  caseId: string;
  reportId: string;
  status: CaseStatus;
  reportedAt: string;
  message: string;
};

export const REPORT_NOTE_MAX = 2000;

export const trustedContactApi = {
  accounts: (signal?: AbortSignal) => apiRequest<TrustedAccount[]>('/trusted-contact/accounts', { signal }),
  status: (trustedContactId: string, signal?: AbortSignal) =>
    apiRequest<CaseStatusForReporter>(`/trusted-contact/accounts/${trustedContactId}/death-verification`, { signal }),
  report: (trustedContactId: string, input: DeathReportInput) =>
    apiRequest<DeathReportReceipt>(`/trusted-contact/accounts/${trustedContactId}/death-reports`, {
      method: 'POST',
      body: input,
    }),
};

/** The signed-in Customer's own case: status and safeguard deadline only. */
export type CustomerCaseStatus = {
  status: CaseStatus | null;
  safeguardEndsAt: string | null;
  canConfirmAlive: boolean;
};

export const deathVerificationApi = {
  me: (signal?: AbortSignal) => apiRequest<CustomerCaseStatus>('/death-verification/me', { signal }),
  confirmAlive: () =>
    apiRequest<CustomerCaseStatus>('/death-verification/me/confirm-alive', {
      method: 'POST',
      body: { confirmAlive: true },
    }),
};
