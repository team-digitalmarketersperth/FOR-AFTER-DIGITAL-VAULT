import { apiRequest } from './client';
import type { AccessUrl, UploadTarget } from './media';
import type { ContentType } from './messages';

// Recipient Portal, Trusted Contact Portal and the Customer's own death-
// verification status. Recipients and Trusted Contacts are not Users: each has
// its own HttpOnly cookie, Redis session and /me route, and the browser may
// hold all three sessions at once. Nothing here reads or sets a cookie.

/** Email sign-in → the email; Recipient SMS sign-in → the mobile, masked by the API. */
export type PortalMe = { authenticated: true; email: string } | { authenticated: true; mobile: string };
export const portalMeLabel = (me: PortalMe) => ('email' in me ? me.email : me.mobile);
export type OtpChallenge = { challengeId: string; message: string };

/** Email or mobile → 6-digit code sign-in, identical in shape for both portals. */
function otpAuth(base: 'recipient-auth' | 'trusted-contact-auth') {
  return {
    /** Always 202 with a challenge, whether or not the email is eligible. */
    requestOtp: (email: string) =>
      apiRequest<OtpChallenge>(`/${base}/request-otp`, { method: 'POST', body: { email } }),
    /** Sets the portal's session cookie on success. */
    verifyOtp: (challengeId: string, code: string) =>
      apiRequest<PortalMe>(`/${base}/verify-otp`, { method: 'POST', body: { challengeId, code } }),
    /**
     * Mobile (E.164) → SMS code, sent by Twilio Verify through the API. Always
     * 202 with the same message, whether or not the mobile is eligible.
     */
    requestSmsOtp: (mobile: string) =>
      apiRequest<{ message: string }>(`/${base}/request-sms-otp`, { method: 'POST', body: { mobile } }),
    /** Sets the same portal session cookie as email sign-in. */
    verifySmsOtp: (mobile: string, code: string) =>
      apiRequest<PortalMe>(`/${base}/verify-sms-otp`, { method: 'POST', body: { mobile, code } }),
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
  contentType: ContentType;
  releasedAt: string;
  hasMedia: boolean;
  /**
   * Phase 18: who it is from, as the sender's name stood when it was shared
   * with this person. Display name only; null for older messages.
   */
  senderDisplayName: string | null;
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

/** About the account holder's current (newest) case. */
export type CaseStatusForReporter = {
  status: CaseStatus | null;
  reportedByYou: boolean;
  openedAt: string | null;
  /** The API's answer to "may this contact report now?" (after a closed case: yes). */
  canReport: boolean;
  /** Phase 19A: open case + this contact's own report. The upload route stays authoritative. */
  canUploadEvidence: boolean;
};

/**
 * Phase 19A: a reporter's own supporting file (death certificate etc.).
 * Metadata only: no name, path or provider id. Viewed through a short-lived URL.
 */
export type Evidence = {
  id: string;
  mimeType: string;
  sizeBytes: number;
  status: 'PENDING_UPLOAD' | 'READY' | 'FAILED';
  uploadedAt: string | null;
};

// The backend allowlist (EVIDENCE_MIME_TYPES) and default limits
// (DEATH_EVIDENCE_MAX_BYTES / _MAX_FILES). The server stays authoritative.
export const EVIDENCE_TYPES: Record<string, string> = {
  'application/pdf': 'PDF',
  'image/jpeg': 'JPEG',
  'image/png': 'PNG',
};
export const EVIDENCE_MAX_BYTES = 20 * 1024 * 1024;
export const EVIDENCE_MAX_FILES = 5;

/** Client-side check before asking for an upload; null when acceptable. */
export function checkEvidenceFile(file: Pick<File, 'type' | 'size'>): string | null {
  const type = file.type.split(';')[0].trim().toLowerCase();
  if (!EVIDENCE_TYPES[type]) return 'Please choose a PDF, JPEG or PNG file.';
  if (file.size <= 0) return 'This file is empty.';
  if (file.size > EVIDENCE_MAX_BYTES) return `This file is larger than ${EVIDENCE_MAX_BYTES / 1024 / 1024} MB.`;
  return null;
}

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
  evidence: (trustedContactId: string, signal?: AbortSignal) =>
    apiRequest<Evidence[]>(evidenceBase(trustedContactId), { signal }),
  /** Same signed direct-upload contract as media (mediaAssetId = the evidence id). */
  requestEvidenceUpload: (trustedContactId: string, file: Pick<File, 'name' | 'type' | 'size'>) =>
    apiRequest<{ mediaAssetId: string; upload: UploadTarget; expiresAt: string }>(
      `${evidenceBase(trustedContactId)}/upload-url`,
      {
        method: 'POST',
        body: {
          originalFileName: file.name.slice(0, 255) || 'evidence',
          mimeType: file.type.split(';')[0].trim().toLowerCase(),
          sizeBytes: file.size,
        },
      },
    ),
  completeEvidence: (trustedContactId: string, id: string, providerFileId: string) =>
    apiRequest<Evidence>(`${evidenceBase(trustedContactId)}/${id}/complete`, {
      method: 'POST',
      body: { providerFileId },
    }),
  evidenceAccessUrl: (trustedContactId: string, id: string) =>
    apiRequest<AccessUrl>(`${evidenceBase(trustedContactId)}/${id}/access-url`),
};

const evidenceBase = (trustedContactId: string) =>
  `/trusted-contact/accounts/${trustedContactId}/death-verification/evidence`;

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

// ─── Trusted Contact invitation (Phase 10) ─────────────────────────────────

/** The emailed link's token is the only credential; no session is involved. */
export type InvitationView = {
  status: 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'EXPIRED' | 'CANCELLED';
  /** Null once the invitation can no longer be used. */
  accountHolder: { displayName: string } | null;
};

const invitationCall = (action: 'view' | 'accept' | 'decline') => (token: string) =>
  apiRequest<InvitationView>(`/trusted-contact/invitation/${action}`, { method: 'POST', body: { token } });

export const invitationApi = {
  view: invitationCall('view'),
  accept: invitationCall('accept'),
  decline: invitationCall('decline'),
};
