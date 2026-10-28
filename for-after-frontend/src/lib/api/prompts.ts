import { apiRequest } from './client';
import type { MemoryCategory, MemoryMessageInput } from './memory-vault';
import type { Message } from './messages';

// My Story and My Wishes share one contract: a server-side prompt catalogue
// plus one private text answer per prompt. The catalogue always comes from the
// API; the frontend never keeps its own copy.
export type PromptArea = 'my-story' | 'my-wishes';

export type PromptResponse = {
  id: string;
  promptKey: string;
  /** My Story (Phase 14A): the wording this answer was written for, kept when the catalogue changes. */
  promptTextSnapshot?: string;
  promptVersion?: number;
  /** May be files (or, in My Story, memories) only (Phase 14B / 15B). */
  textContent: string | null;
  /** My Story (Phase 14B): live linked memories, private context only. */
  memories?: { id: string; title: string; category: MemoryCategory }[];
  /** READY photos/recordings/videos (My Story 14B, My Wishes 15B). */
  mediaCount?: number;
  /** Owner-only reminder; never copied into a message. */
  privateNote: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Prompt = {
  key: string;
  category: string;
  version: number;
  prompt: string;
  answered: boolean;
  response: PromptResponse | null;
};

// The server's limits (it enforces them): My Story 50,000 (approved, Phase 14A), My Wishes 20,000.
export const ANSWER_MAX: Record<PromptArea, number> = { 'my-story': 50_000, 'my-wishes': 20_000 };

const base = (area: PromptArea) => `/${area}/prompts`;

/**
 * Phase 15A: the My Wishes notice, served by the API (its only source: the
 * frontend keeps no copy). Informational only since 2026-10-14: nothing waits
 * for an acknowledgement.
 */
export type WishesNotice = { version: number; text: string };

export const wishesNoticeApi = {
  get: (signal?: AbortSignal) => apiRequest<WishesNotice>('/my-wishes/disclaimer', { signal }),
};

/** textContent null = cleared; memoryVaultItemIds (My Story only) replaces the linked memories. */
export type AnswerInput = { textContent?: string | null; memoryVaultItemIds?: string[]; privateNote?: string | null };

/**
 * GET /my-story/book: the owner's saved answers as chapters (catalogue order,
 * only categories with content), never rewritten. No private notes. Answers to
 * prompts no longer in the catalogue come back in `unsorted`.
 */
export type BookEntry = Pick<PromptResponse, 'promptKey' | 'textContent' | 'updatedAt'> & {
  /** The wording the answer was written for. */
  prompt: string;
  mediaCount: number;
  memories: NonNullable<PromptResponse['memories']>;
};
export type StoryBook = { chapters: { category: string; entries: BookEntry[] }[]; unsorted: BookEntry[] };

export const storyBookApi = {
  get: (signal?: AbortSignal) => apiRequest<StoryBook>('/my-story/book', { signal }),
};

export const promptsApi = {
  list: (area: PromptArea, signal?: AbortSignal) => apiRequest<Prompt[]>(base(area), { signal }),
  get: (area: PromptArea, key: string, signal?: AbortSignal) =>
    apiRequest<Prompt>(`${base(area)}/${encodeURIComponent(key)}`, { signal }),
  /** Create, update or restore the answer (always 200). Omitted fields stay as they are. */
  save: (area: PromptArea, key: string, body: AnswerInput) =>
    apiRequest<PromptResponse>(`${base(area)}/${encodeURIComponent(key)}/response`, { method: 'PUT', body }),
  /** Phase 14B / 15B: a separate DRAFT message from chosen parts of an answer or a wish. */
  createMessage: (area: PromptArea, key: string, input: MemoryMessageInput) =>
    apiRequest<Message>(`${base(area)}/${encodeURIComponent(key)}/response/messages`, { method: 'POST', body: input }),
  remove: (area: PromptArea, key: string) =>
    apiRequest<void>(`${base(area)}/${encodeURIComponent(key)}/response`, { method: 'DELETE' }),
};
