import { apiRequest } from './client';

// GET /users/me/readiness: five setup steps, 20 points each, derived on the
// server from the Customer's own rows. Counts only, never content.
export type ReadinessStep =
  | { key: 'PEOPLE'; complete: boolean; people: number }
  // Complete once at least one contact is READY (accepted their invitation).
  | { key: 'TRUSTED_CONTACTS'; complete: boolean; trustedContacts: number; ready: number }
  | { key: 'PRESERVED'; complete: boolean; messages: number; memories: number; storyAnswers: number }
  | { key: 'SCHEDULING'; complete: boolean; messages: number; needsScheduling: number }
  | { key: 'WISHES'; complete: boolean; wishes: number };

export type ReadinessKey = ReadinessStep['key'];

export type Readiness = {
  score: number;
  completedSteps: number;
  totalSteps: number;
  steps: ReadinessStep[];
};

export const readinessApi = {
  get: (signal?: AbortSignal) => apiRequest<Readiness>('/users/me/readiness', { signal }),
};
