import { apiRequest } from './client';

// My Story and My Wishes share one contract: a server-side prompt catalogue
// plus one private text answer per prompt. The catalogue always comes from the
// API; the frontend never keeps its own copy.
export type PromptArea = 'my-story' | 'my-wishes';

export type PromptResponse = {
  id: string;
  promptKey: string;
  textContent: string;
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

export const ANSWER_MAX = 20_000;

const base = (area: PromptArea) => `/${area}/prompts`;

export const promptsApi = {
  list: (area: PromptArea, signal?: AbortSignal) => apiRequest<Prompt[]>(base(area), { signal }),
  get: (area: PromptArea, key: string, signal?: AbortSignal) =>
    apiRequest<Prompt>(`${base(area)}/${encodeURIComponent(key)}`, { signal }),
  /** Create, update or restore the answer (always 200). */
  save: (area: PromptArea, key: string, textContent: string) =>
    apiRequest<PromptResponse>(`${base(area)}/${encodeURIComponent(key)}/response`, {
      method: 'PUT',
      body: { textContent },
    }),
  remove: (area: PromptArea, key: string) =>
    apiRequest<void>(`${base(area)}/${encodeURIComponent(key)}/response`, { method: 'DELETE' }),
};
