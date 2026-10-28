import { apiRequest } from './client';

// POST /assistant/reply (backend `src/assistant`): the companion's AI replies,
// through Groq on the server. Ids and limits mirror the backend's checks.
export type AssistantPage =
  | 'dashboard'
  | 'people'
  | 'trusted-contacts'
  | 'messages'
  | 'memory-vault'
  | 'my-story'
  | 'my-wishes'
  | 'account';
export type AssistantAction = 'ask' | 'draft' | 'improve' | 'shorten' | 'expand' | 'questions' | 'caption';
export type AssistantTurn = { role: 'user' | 'assistant'; content: string };
export type AssistantRequest = {
  page: AssistantPage;
  action: AssistantAction;
  message?: string;
  source?: string;
  promptKey?: string;
  history?: AssistantTurn[];
};

export const ASSISTANT_LIMITS = { message: 2_000, source: 6_000, turn: 3_000, history: 6, total: 12_000 } as const;

export const assistantApi = {
  reply: (body: AssistantRequest, signal?: AbortSignal) =>
    apiRequest<{ reply: string; truncated: boolean }>('/assistant/reply', { method: 'POST', body, signal }),
};

/** The newest turns that fit the request's remaining character budget. */
export function boundedHistory(turns: AssistantTurn[], used: number): AssistantTurn[] {
  const out: AssistantTurn[] = [];
  let left = ASSISTANT_LIMITS.total - used;
  for (const t of [...turns].reverse()) {
    const content = t.content.slice(0, ASSISTANT_LIMITS.turn);
    if (out.length === ASSISTANT_LIMITS.history || content.length > left) break;
    out.unshift({ role: t.role, content });
    left -= content.length;
  }
  return out;
}
