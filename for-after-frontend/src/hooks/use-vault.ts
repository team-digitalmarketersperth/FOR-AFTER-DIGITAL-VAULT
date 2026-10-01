'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ApiError } from '@/lib/api/errors';
import { memoryVaultApi, type Memory, type MemoryCategory, type MemoryInput } from '@/lib/api/memory-vault';
import {
  messagesApi,
  scheduleApi,
  type Message,
  type MessageInput,
  type Schedule,
  type ScheduleInput,
} from '@/lib/api/messages';
import {
  recipientsApi,
  trustedContactsApi,
  type Recipient,
  type RecipientInput,
  type TrustedContact,
  type TrustedContactInput,
} from '@/lib/api/people';
import { promptsApi, type Prompt, type PromptArea } from '@/lib/api/prompts';
import { queryKeys } from '@/lib/query/query-client';

type Api<T, Input> = {
  list: (signal?: AbortSignal) => Promise<T[]>;
  get: (id: string, signal?: AbortSignal) => Promise<T>;
  create: (input: Input) => Promise<T>;
  update: (id: string, input: Partial<Input>) => Promise<T>;
  remove: (id: string) => Promise<void>;
};

/**
 * List/detail/create/update/remove for one owner-scoped collection. Writes
 * seed the detail cache and invalidate the collection root (list + details).
 */
function resourceHooks<T extends { id: string }, Input>(
  root: readonly string[],
  api: Api<T, Input>,
  // What a write makes stale besides the item itself: by default the list.
  stale: (readonly string[])[] = [root],
) {
  const detailKey = (id: string) => [...root, id];
  const refresh = (qc: ReturnType<typeof useQueryClient>) =>
    Promise.all(
      stale.map((key) => qc.invalidateQueries({ queryKey: key, exact: key === root })),
    );
  return {
    useList: () =>
      useQuery<T[], ApiError>({ queryKey: root, queryFn: ({ signal }) => api.list(signal) }),
    useItem: (id: string) =>
      useQuery<T, ApiError>({ queryKey: detailKey(id), queryFn: ({ signal }) => api.get(id, signal) }),
    useCreate: () => {
      const qc = useQueryClient();
      return useMutation<T, ApiError, Input>({
        mutationFn: api.create,
        onSuccess: (item) => {
          qc.setQueryData(detailKey(item.id), item);
          return refresh(qc);
        },
      });
    },
    useUpdate: (id: string) => {
      const qc = useQueryClient();
      return useMutation<T, ApiError, Partial<Input>>({
        mutationFn: (input) => api.update(id, input),
        onSuccess: (item) => {
          qc.setQueryData(detailKey(id), item);
          return refresh(qc);
        },
      });
    },
    useRemove: (id: string) => {
      const qc = useQueryClient();
      return useMutation<void, ApiError, void>({
        mutationFn: () => api.remove(id),
        onSuccess: () => {
          qc.removeQueries({ queryKey: detailKey(id) });
          return refresh(qc);
        },
      });
    },
  };
}

// Removing or renaming someone changes the recipient summaries on messages.
export const recipients = resourceHooks<Recipient, RecipientInput>(queryKeys.recipients, recipientsApi, [
  queryKeys.recipients,
  queryKeys.messages,
]);
export const trustedContacts = resourceHooks<TrustedContact, TrustedContactInput>(
  queryKeys.trustedContacts,
  trustedContactsApi,
);
export const messages = resourceHooks<Message, MessageInput>(queryKeys.messages, messagesApi);

// Memory Vault lists are filtered by category, so lists live under their own
// sub-key and every write invalidates the whole root.
const memoryHooks = resourceHooks<Memory, MemoryInput>(
  queryKeys.memories,
  { ...memoryVaultApi, list: (signal) => memoryVaultApi.list(undefined, signal) },
  [['memory-vault', 'list']],
);
export const memories = {
  ...memoryHooks,
  useList: (category?: MemoryCategory) =>
    useQuery<Memory[], ApiError>({
      queryKey: queryKeys.memoryList(category),
      queryFn: ({ signal }) => memoryVaultApi.list(category, signal),
    }),
};

/**
 * The message's schedule, or null when it has none (DRAFT answers 404; a
 * RELEASED/CANCELLED message without one answers 409).
 */
export function useSchedule(messageId: string, enabled = true) {
  return useQuery<Schedule | null, ApiError>({
    queryKey: queryKeys.schedule(messageId),
    enabled,
    queryFn: async ({ signal }) => {
      try {
        return await scheduleApi.get(messageId, signal);
      } catch (error) {
        const e = error as ApiError;
        if (e.kind === 'not_found' || e.kind === 'conflict') return null;
        throw error;
      }
    },
  });
}

type ScheduleAction =
  | { type: 'create' | 'update'; input: ScheduleInput }
  | { type: 'unschedule' };

/** Create / change / remove a schedule; the message's status changes with it. */
export function useScheduleMutation(messageId: string) {
  const qc = useQueryClient();
  return useMutation<unknown, ApiError, ScheduleAction>({
    mutationFn: (action) =>
      action.type === 'unschedule'
        ? scheduleApi.remove(messageId)
        : scheduleApi[action.type](messageId, action.input),
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.message(messageId) }),
        qc.invalidateQueries({ queryKey: queryKeys.messages, exact: true }),
      ]),
  });
}

export function usePrompts(area: PromptArea) {
  return useQuery<Prompt[], ApiError>({
    queryKey: queryKeys.prompts(area),
    queryFn: ({ signal }) => promptsApi.list(area, signal),
  });
}

export function usePrompt(area: PromptArea, key: string) {
  return useQuery<Prompt, ApiError>({
    queryKey: queryKeys.prompt(area, key),
    queryFn: ({ signal }) => promptsApi.get(area, key, signal),
  });
}

/** Save (create/update/restore) or delete one answer. */
export function useAnswerMutation(area: PromptArea, key: string) {
  const qc = useQueryClient();
  return useMutation<unknown, ApiError, { textContent: string } | null>({
    mutationFn: (input) =>
      input ? promptsApi.save(area, key, input.textContent) : promptsApi.remove(area, key),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.prompts(area) }),
  });
}
