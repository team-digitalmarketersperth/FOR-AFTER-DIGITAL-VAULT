import { toQuery, type Page } from './admin';
import { apiRequest } from './client';
import type { ContentType, Message } from './messages';
import { resource } from './resource';

// The backend MemoryVaultCategory enum, in its order.
export const MEMORY_CATEGORIES = [
  'FAMILY',
  'TRAVEL',
  'CHILDHOOD',
  'FUNNY_STORIES',
  'LIFE_LESSONS',
  'RECIPES',
  'LOVE_STORIES',
  'OTHER',
] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

export const isMemoryCategory = (value: unknown): value is MemoryCategory =>
  MEMORY_CATEGORIES.includes(value as MemoryCategory);

// The API's own technical limits (Phase 13A).
export const TAG_NAME_MAX = 50;
export const TAGS_MAX = 20;
export const SEARCH_MAX = 200;

/** The Customer's own tag. Tags are sent by name; the API dedupes them case-insensitively. */
export type MemoryTag = { id: string; name: string };

export type Memory = {
  id: string;
  title: string;
  category: MemoryCategory;
  textContent: string | null;
  tags: MemoryTag[];
  createdAt: string;
  updatedAt: string;
};

/** tags = the whole set (on update, it replaces the memory's tags). */
export type MemoryInput = Pick<Memory, 'title' | 'category' | 'textContent'> & { tags: string[] };

/** What to copy into the new message; contentType is always chosen, never inferred. */
export type MemoryMessageInput = {
  title: string;
  contentType: ContentType;
  includeText: boolean;
  mediaAssetIds: string[];
  recipientIds: string[];
};

/** GET /memory-vault filters, all optional and combinable; also the page's URL query. */
export type MemoryFilters = { category?: MemoryCategory; tag?: string; search?: string; page?: number };

const crud = resource<Memory, MemoryInput>('/memory-vault');

export const memoryVaultApi = {
  ...crud,
  // 25 per page, the API default (Recipients/Messages convention).
  list: (filters: MemoryFilters, signal?: AbortSignal) =>
    apiRequest<Page<Memory>>(`/memory-vault${toQuery(filters)}`, { signal }),
  tags: (signal?: AbortSignal) => apiRequest<MemoryTag[]>('/memory-vault/tags', { signal }),
  /** Phase 13B: a new DRAFT Message from what was picked; the memory itself never changes. */
  createMessage: (id: string, input: MemoryMessageInput) =>
    apiRequest<Message>(`/memory-vault/${id}/messages`, { method: 'POST', body: input }),
};
