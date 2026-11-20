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
  /** Updated Plans Step 5: a fresh id per Send (the server refuses a reused one, never re-running it). */
  requestId?: string;
};

/**
 * Updated Plans Step 5: this account's AI allowance (GET /assistant/usage). `metered: false` means no allowance
 * applies to this account (an exemption or a state the server explains); it is never described as unlimited.
 */
export type AssistantUsage =
  | {
      metered: true;
      kind: 'trial' | 'month';
      allowance: number;
      used: number;
      inProgress: number;
      remaining: number;
      periodEndsAt: string;
      resetsAt: string | null;
    }
  | { metered: false; reason: 'billing_off' | 'grandfathered' | 'unmapped_paid' | 'no_access' };

/** `draft`: the reply is text for the editor; `open`: a section the server approved to link to. */
export type AssistantReply = { reply: string; truncated: boolean; draft?: boolean; open?: AssistantPage };

export const ASSISTANT_LIMITS = { message: 2_000, source: 6_000, turn: 3_000, history: 6, total: 12_000 } as const;

export const assistantApi = {
  reply: (body: AssistantRequest, signal?: AbortSignal) =>
    apiRequest<AssistantReply>('/assistant/reply', { method: 'POST', body, signal }),
  usage: (signal?: AbortSignal) => apiRequest<AssistantUsage>('/assistant/usage', { signal }),
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
