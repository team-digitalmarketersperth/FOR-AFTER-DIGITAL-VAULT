import type { CaseStatus } from '@/lib/api/portals';

// The one place death-verification statuses become words. A report is not a
// verification, and neither releases anything: only the For After team's
// verification can, and the copy never implies otherwise.

type Copy = { label: string; description: string; tone: 'open' | 'closed' | 'done' };

/** What a Trusted Contact sees (they never see safeguard details or notes). */
export const REPORTER_STATUS: Record<CaseStatus | 'NONE', Copy> = {
  NONE: {
    label: 'No report submitted',
    description: 'No one has reported a death for this account.',
    tone: 'closed',
  },
  PENDING_VERIFICATION: {
    label: 'Report received',
    description: 'A report has been received and is waiting to be verified by the For After team.',
    tone: 'open',
  },
  SAFEGUARD_ACTIVE: {
    label: 'Verification underway',
    description: 'The verification process is underway.',
    tone: 'open',
  },
  READY_FOR_REVIEW: {
    label: 'Awaiting review',
    description: 'The case is ready for review by the For After team.',
    tone: 'open',
  },
  VERIFIED: {
    label: 'Verification completed',
    description: 'The For After team has completed the verification process.',
    tone: 'done',
  },
  REJECTED: {
    label: 'Not verified',
    description: 'The report was not verified.',
    tone: 'closed',
  },
  CANCELLED: {
    label: 'Case closed',
    description: 'This verification case has been closed.',
    tone: 'closed',
  },
};

export const reporterStatus = (status: CaseStatus | null) => REPORTER_STATUS[status ?? 'NONE'];

/** What the For After team sees in the admin portal: operational, exact. */
export const ADMIN_STATUS: Record<CaseStatus, Copy> = {
  PENDING_VERIFICATION: {
    label: 'Pending verification',
    description: 'Report received. The safety notice to the account holder has not been sent yet.',
    tone: 'open',
  },
  SAFEGUARD_ACTIVE: {
    label: 'Safeguard active',
    description: 'The account holder has been notified. Review opens when the safeguard period ends.',
    tone: 'open',
  },
  READY_FOR_REVIEW: {
    label: 'Ready for review',
    description: 'The safeguard period has ended without the account holder responding. A decision is needed.',
    tone: 'open',
  },
  VERIFIED: {
    label: 'Verified',
    description: 'The death was verified. The account is marked as passed.',
    tone: 'done',
  },
  REJECTED: { label: 'Rejected', description: 'The report was not verified. Nothing was released.', tone: 'closed' },
  CANCELLED: {
    label: 'Cancelled',
    description: 'The account holder confirmed they are alive. Nothing was released.',
    tone: 'closed',
  },
};
