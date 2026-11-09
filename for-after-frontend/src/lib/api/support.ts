import { apiRequest } from '@/lib/api/client';
import type { Page } from '@/lib/api/admin';

// Step 7 in-app support (backend docs/support.md). Plain text only; owner,
// author and status always come from the server.

export const SUPPORT_CATEGORIES = [
  'ACCOUNT_ACCESS',
  'MESSAGES_RECIPIENTS',
  'UPLOADS_STORAGE',
  'MY_STORY_WISHES',
  'TECHNICAL',
  'OTHER',
] as const;
export type SupportCategory = (typeof SUPPORT_CATEGORIES)[number];
export const SUPPORT_STATUSES = ['OPEN', 'IN_PROGRESS', 'WAITING_FOR_CUSTOMER', 'RESOLVED'] as const;
export type SupportStatus = (typeof SUPPORT_STATUSES)[number];

export const SUBJECT_MIN = 3;
export const SUBJECT_MAX = 150;
export const DESCRIPTION_MIN = 10;
export const TEXT_MAX = 5000;

export type SupportSummary = {
  id: string;
  subject: string;
  category: SupportCategory;
  status: SupportStatus;
  createdAt: string;
  /** Creation, follow-ups and public replies only. */
  lastPublicActivityAt: string;
};

/** The public conversation: never internal notes or an admin's identity. */
export type SupportMessage = { id: string; authorRole: 'CUSTOMER' | 'ADMIN'; body: string; createdAt: string };

export type SupportRequest = SupportSummary & { description: string; messages: SupportMessage[] };

export type SupportRequestInput = {
  clientRequestId: string;
  subject: string;
  category: SupportCategory;
  description: string;
};
export type SupportTextInput = { clientRequestId: string; body: string };

export const supportApi = {
  list: (page: number, signal?: AbortSignal) =>
    apiRequest<Page<SupportSummary>>(`/support/requests?page=${page}`, { signal }),
  get: (id: string, signal?: AbortSignal) =>
    apiRequest<SupportRequest>(`/support/requests/${encodeURIComponent(id)}`, { signal }),
  create: (input: SupportRequestInput) =>
    apiRequest<SupportRequest>('/support/requests', { method: 'POST', body: input }),
  followUp: (id: string, input: SupportTextInput) =>
    apiRequest<SupportRequest>(`/support/requests/${encodeURIComponent(id)}/messages`, { method: 'POST', body: input }),
};
