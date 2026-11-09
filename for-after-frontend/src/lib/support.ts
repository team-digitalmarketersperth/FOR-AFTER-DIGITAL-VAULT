import type { SupportCategory, SupportStatus } from '@/lib/api/support';

// One set of support wording for the Customer pages and the admin inbox.

export const SUPPORT_CATEGORY_LABEL: Record<SupportCategory, string> = {
  ACCOUNT_ACCESS: 'Account access',
  MESSAGES_RECIPIENTS: 'Messages and recipients',
  UPLOADS_STORAGE: 'Uploads and storage',
  MY_STORY_WISHES: 'My Story / My Wishes',
  TECHNICAL: 'Technical issue',
  OTHER: 'Other',
};

type Tone = 'neutral' | 'open' | 'done' | 'warning';

/** Customer wording ("Waiting for you") and the admin's ("Waiting for customer"); same stored status. */
export const SUPPORT_STATUS: Record<SupportStatus, { label: string; admin: string; tone: Tone }> = {
  OPEN: { label: 'Open', admin: 'Open', tone: 'open' },
  IN_PROGRESS: { label: 'In progress', admin: 'In progress', tone: 'open' },
  WAITING_FOR_CUSTOMER: { label: 'Waiting for you', admin: 'Waiting for customer', tone: 'warning' },
  RESOLVED: { label: 'Resolved', admin: 'Resolved', tone: 'done' },
};

/** Mirrors the API's rule (the API decides): any other status; resolved only reopens. */
export const nextStatuses = (from: SupportStatus): SupportStatus[] =>
  from === 'RESOLVED'
    ? ['OPEN']
    : (['OPEN', 'IN_PROGRESS', 'WAITING_FOR_CUSTOMER', 'RESOLVED'] as const).filter((s) => s !== from);

export const PRIVACY_HINT =
  'Describe the issue without including passwords, verification codes or sensitive personal content.';
