import { apiRequest } from './client';
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

export type Memory = {
  id: string;
  title: string;
  category: MemoryCategory;
  textContent: string | null;
  createdAt: string;
  updatedAt: string;
};

export type MemoryInput = Pick<Memory, 'title' | 'category' | 'textContent'>;

const crud = resource<Memory, MemoryInput>('/memory-vault');

export const memoryVaultApi = {
  ...crud,
  list: (category?: MemoryCategory, signal?: AbortSignal) =>
    apiRequest<Memory[]>(category ? `/memory-vault?category=${category}` : '/memory-vault', {
      signal,
    }),
};
