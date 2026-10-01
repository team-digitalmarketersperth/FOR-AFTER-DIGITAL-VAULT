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
