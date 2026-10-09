'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ApiError } from '@/lib/api/errors';
import type { Page as AdminPage } from '@/lib/api/admin';
import {
  memoryVaultApi,
  type Memory,
  type MemoryFilters,
  type MemoryInput,
  type MemoryMessageInput,
  type MemoryTag,
} from '@/lib/api/memory-vault';
import {
  messagesApi,
  scheduleApi,
  type Message,
  type MessageInput,
  type MessageSummary,
  type Schedule,
  type ScheduleInput,
} from '@/lib/api/messages';
import {
  recipientsApi,
  trustedContactsApi,
  type Page,
  type Recipient,
  type RecipientInput,
  type TrustedContact,
  type TrustedContactInput,
} from '@/lib/api/people';
import {
  promptsApi,
  wishesNoticeApi,
  type AnswerInput,
  type Prompt,
  type PromptArea,
  type WishesNotice,
} from '@/lib/api/prompts';
import { queryKeys } from '@/lib/query/query-client';

// L = the list item, when the list returns summaries rather than full items.
type Api<T, Input, L = T> = {
  list: (signal?: AbortSignal) => Promise<L[]>;
  get: (id: string, signal?: AbortSignal) => Promise<T>;
  create: (input: Input) => Promise<T>;
  update: (id: string, input: Partial<Input>) => Promise<T>;
  remove: (id: string) => Promise<void>;
};

/**
 * List/detail/create/update/remove for one owner-scoped collection. Writes
 * seed the detail cache and invalidate the collection root (list + details).
 */
function resourceHooks<T extends { id: string }, Input, L = T>(
  root: readonly string[],
  api: Api<T, Input, L>,
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
      useQuery<L[], ApiError>({ queryKey: root, queryFn: ({ signal }) => api.list(signal) }),
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
// useList is everyone (the message picker); usePage is the People I Love list.
const recipientHooks = resourceHooks<Recipient, RecipientInput>(queryKeys.recipients, recipientsApi, [
  queryKeys.recipients,
  queryKeys.recipientPages,
  queryKeys.messages,
]);
export const recipients = {
  ...recipientHooks,
  usePage: (page: number) =>
    useQuery<Page<Recipient>, ApiError>({
      queryKey: queryKeys.recipientPage(page),
      queryFn: ({ signal }) => recipientsApi.page(page, signal),
      // The current page stays on screen while the next one loads.
      placeholderData: keepPreviousData,
    }),
};
const trustedContactHooks = resourceHooks<TrustedContact, TrustedContactInput>(
  queryKeys.trustedContacts,
  trustedContactsApi,
);
export const trustedContacts = {
  ...trustedContactHooks,
  /** Phase 10: send or resend the email invitation. */
  useInvite: (id: string) => {
    const qc = useQueryClient();
    return useMutation<TrustedContact, ApiError, void>({
      mutationFn: () => trustedContactsApi.invite(id),
      onSuccess: (item) => {
        qc.setQueryData(queryKeys.trustedContact(id), item);
        return qc.invalidateQueries({ queryKey: queryKeys.trustedContacts, exact: true });
      },
    });
  },
};
export const messages = resourceHooks<Message, MessageInput, MessageSummary>(queryKeys.messages, messagesApi);

// Memory Vault lists are pages per filter set, under their own sub-key; every
// write makes all list pages and the tag list (a new tag may exist) stale.
const memoryHooks = resourceHooks<Memory, MemoryInput>(
  queryKeys.memories,
  { ...memoryVaultApi, list: (signal) => memoryVaultApi.list({}, signal).then((p) => p.items) },
  [['memory-vault', 'list'], queryKeys.memoryTags],
);
export const memories = {
  ...memoryHooks,
  useList: (filters: MemoryFilters) =>
    useQuery<AdminPage<Memory>, ApiError>({
      queryKey: queryKeys.memoryList(filters),
      queryFn: ({ signal }) => memoryVaultApi.list(filters, signal),
      // The current page stays on screen while the next one loads.
      placeholderData: keepPreviousData,
    }),
  /** Phase 13B: the new draft joins the Messages lists; the memory is unchanged. */
  useCreateMessage: (id: string) => {
    const qc = useQueryClient();
    return useMutation<Message, ApiError, MemoryMessageInput>({
      mutationFn: (input) => memoryVaultApi.createMessage(id, input),
      onSuccess: (m) => {
        qc.setQueryData(queryKeys.message(m.id), m);
        return qc.invalidateQueries({ queryKey: queryKeys.messages });
      },
    });
  },
  useTags: () =>
    useQuery<MemoryTag[], ApiError>({ queryKey: queryKeys.memoryTags, queryFn: ({ signal }) => memoryVaultApi.tags(signal) }),
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
  return useMutation<unknown, ApiError, AnswerInput | null>({
    mutationFn: (input) => (input ? promptsApi.save(area, key, input) : promptsApi.remove(area, key)),
    // The area root covers the list, this prompt and its files.
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.prompts(area) }),
  });
}

/** Phase 15A: the My Wishes notice and this Customer's acknowledgement of its current version. */
export function useWishesNotice() {
  return useQuery<WishesNotice, ApiError>({
    queryKey: queryKeys.wishesNotice,
    queryFn: ({ signal }) => wishesNoticeApi.get(signal),
  });
}

export function useAcknowledgeNotice() {
  const qc = useQueryClient();
  return useMutation<WishesNotice, ApiError, number>({
    mutationFn: (version) => wishesNoticeApi.acknowledge(version),
    onSuccess: (notice) => qc.setQueryData(queryKeys.wishesNotice, notice),
  });
}

/** Phase 14B / 15B: a new draft from a My Story answer or a wish; it joins the Messages lists. */
export function useAnswerMessage(area: PromptArea, key: string) {
  const qc = useQueryClient();
  return useMutation<Message, ApiError, MemoryMessageInput>({
    mutationFn: (input) => promptsApi.createMessage(area, key, input),
    onSuccess: (m) => {
      qc.setQueryData(queryKeys.message(m.id), m);
      return qc.invalidateQueries({ queryKey: queryKeys.messages });
    },
  });
}
