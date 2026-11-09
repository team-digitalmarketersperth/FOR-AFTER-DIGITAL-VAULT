import { apiRequest } from './client';

// GET /users/me/attention: what the Customer could take care of next, derived
// on the server from their own rows. Wording and links come from the API.
export type AttentionPriority = 'HIGH' | 'MEDIUM' | 'LOW';
export type AttentionCategory = 'TRUSTED_CONTACTS' | 'MESSAGES' | 'PEOPLE' | 'STORAGE';

export type AttentionItem = {
  key: string;
  category: AttentionCategory;
  priority: AttentionPriority;
  title: string;
  description: string | null;
  actionLabel: string;
  actionHref: string;
};

export type Attention = { items: AttentionItem[]; total: number };

export const attentionApi = {
  get: (signal?: AbortSignal) => apiRequest<Attention>('/users/me/attention', { signal }),
};
