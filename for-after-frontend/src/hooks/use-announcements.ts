'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  announcementsApi,
  type Announcement,
  type AnnouncementContent,
  type AnnouncementInput,
  type AnnouncementPreview,
  type AnnouncementSummary,
  type AudienceReview,
  type AudienceScope,
  type Broadcast,
  type PilotGroup,
  type BroadcastReview,
  type RecipientDetail,
  type RecipientQuery,
  type RecipientResult,
  type RetryReview,
  type RunEmail,
  type TestSend,
} from '@/lib/api/announcements';
import type { Page } from '@/lib/api/admin';
import type { ApiError } from '@/lib/api/errors';
import { adminKeys } from '@/lib/query/query-client';

const key = adminKeys.announcements;

export const useAnnouncements = (page: number, enabled = true) =>
  useQuery<Page<AnnouncementSummary>, ApiError>({
    queryKey: [...key, 'list', page],
    queryFn: ({ signal }) => announcementsApi.list(page, signal),
    placeholderData: keepPreviousData,
    // Run states change in the background (worker), so coming back to the list always re-reads them.
    refetchOnMount: 'always',
    enabled,
  });

export const useAnnouncement = (id: string, enabled = true) =>
  useQuery<Announcement, ApiError>({
    queryKey: [...key, id],
    queryFn: ({ signal }) => announcementsApi.get(id, signal),
    enabled,
  });

/** Create (no id) or update: the response is the saved draft, written into the cache. */
export function useSaveAnnouncement(id?: string) {
  const qc = useQueryClient();
  return useMutation<Announcement, ApiError, AnnouncementInput & { expectedVersion?: number }>({
    mutationFn: ({ expectedVersion, ...input }) =>
      id ? announcementsApi.update(id, { ...input, expectedVersion: expectedVersion! }) : announcementsApi.create(input),
    onSuccess: (draft) => {
      qc.setQueryData([...key, draft.id], draft);
      void qc.invalidateQueries({ queryKey: [...key, 'list'] });
    },
  });
}

/** The SAVED version rendered by the server (a render only: nothing stored or sent). Keyed by version, so a new save re-renders. */
export const useSavedPreview = (id: string, version: number, content: AnnouncementContent) =>
  useQuery<AnnouncementPreview, ApiError>({
    queryKey: [...key, id, 'preview', version],
    queryFn: () => announcementsApi.preview(content),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: false,
  });

export const useTestDestination = (enabled: boolean) =>
  useQuery<{ email: string | null }, ApiError>({
    queryKey: [...key, 'test-destination'],
    queryFn: ({ signal }) => announcementsApi.testDestination(signal),
    enabled,
  });

/** One click = one clientOperationId (made by the caller), so a retried POST is the same request. */
export function useRequestTest(id: string) {
  const qc = useQueryClient();
  return useMutation<TestSend, ApiError, { clientOperationId: string; expectedVersion: number }>({
    mutationFn: (input) => announcementsApi.requestTest(id, input),
    onSuccess: (test) => qc.setQueryData([...key, id, 'test', test.id], test),
  });
}

const PENDING = new Set(['QUEUED', 'PROCESSING']);

/** Polls every 3 s while the worker has not settled the test; stops at a final status. */
export const useTestSend = (id: string, testId: string | null, initial?: TestSend | null) =>
  useQuery<TestSend, ApiError>({
    queryKey: [...key, id, 'test', testId],
    queryFn: ({ signal }) => announcementsApi.getTest(id, testId!, signal),
    enabled: !!testId,
    initialData: initial && initial.id === testId ? initial : undefined,
    refetchInterval: (q) => (q.state.data && PENDING.has(q.state.data.status) ? 3000 : false),
  });

/** Fetched only while the review is open (each fetch is audited); never on window focus. */
export const useAudienceReview = (id: string, enabled: boolean) =>
  useQuery<AudienceReview, ApiError>({
    queryKey: [...key, id, 'audience'],
    queryFn: ({ signal }) => announcementsApi.audience(id, signal),
    enabled,
    staleTime: 0,
    refetchOnWindowFocus: false,
    retry: false,
  });

/** Step 4: a fresh server review of the saved version (a POST: it issues a short-lived review token). */
export const useBroadcastReview = (id: string) =>
  useMutation<BroadcastReview, ApiError, number>({ mutationFn: (expectedVersion) => announcementsApi.broadcastReview(id, expectedVersion) });

/** One confirmation = one clientOperationId (made by the caller), so a retried POST is the same run. */
export function useQueueBroadcast(id: string) {
  const qc = useQueryClient();
  return useMutation<Broadcast, ApiError, { clientOperationId: string; expectedVersion: number; reviewToken: string }>({
    mutationFn: (input) => announcementsApi.queueBroadcast(id, input),
    onSuccess: (run) => {
      qc.setQueryData([...key, id, 'broadcast', run.id], run);
      void qc.invalidateQueries({ queryKey: [...key, id], exact: true });
      void qc.invalidateQueries({ queryKey: [...key, 'list'] });
    },
  });
}

const RUNNING = new Set(['PREPARING', 'SENDING']);

/** Polls every 5 s while the run is active (paused while the tab is hidden, React Query's default); stops when final. */
export const useBroadcast = (id: string, runId: string | null) =>
  useQuery<Broadcast, ApiError>({
    queryKey: [...key, id, 'broadcast', runId],
    queryFn: ({ signal }) => announcementsApi.getBroadcast(id, runId!, signal),
    enabled: !!runId,
    refetchInterval: (q) => (q.state.data && !RUNNING.has(q.state.data.status) ? false : 5000),
    refetchIntervalInBackground: false,
  });

export function useCancelBroadcast(id: string) {
  const qc = useQueryClient();
  return useMutation<Broadcast, ApiError, string>({
    mutationFn: (runId) => announcementsApi.cancelBroadcast(id, runId),
    onSuccess: (run) => {
      // Keep the retry summary until the next poll (the stop response has none).
      qc.setQueryData<Broadcast>([...key, id, 'broadcast', run.id], (old) => ({ ...run, retry: run.retry ?? old?.retry }));
      void qc.invalidateQueries({ queryKey: [...key, id, 'broadcast', run.id] });
    },
  });
}

/** One page of a run's recipients; keeps the previous page on screen while the next loads; polls with the run. */
export const useRecipients = (id: string, runId: string, query: RecipientQuery, active: boolean) =>
  useQuery<Page<RecipientResult>, ApiError>({
    queryKey: [...key, id, 'broadcast', runId, 'recipients', query],
    queryFn: ({ signal }) => announcementsApi.recipients(id, runId, query, signal),
    placeholderData: keepPreviousData,
    refetchInterval: active ? 5000 : false,
    refetchIntervalInBackground: false,
  });

export const useRecipient = (id: string, runId: string, recipientId: string | null) =>
  useQuery<RecipientDetail, ApiError>({
    queryKey: [...key, id, 'broadcast', runId, 'recipient', recipientId],
    queryFn: ({ signal }) => announcementsApi.recipient(id, runId, recipientId!, signal),
    enabled: !!recipientId,
  });

/** The email exactly as queued for the run (immutable), fetched when the preview opens. */
export const useRunEmail = (id: string, runId: string, enabled: boolean) =>
  useQuery<RunEmail, ApiError>({
    queryKey: [...key, id, 'broadcast', runId, 'email'],
    queryFn: ({ signal }) => announcementsApi.runEmail(id, runId, signal),
    enabled,
    staleTime: Infinity,
  });

/** A fresh server review of what a retry would queue (count + exact set hash). Changes nothing. */
export const useRetryReview = (id: string, runId: string) =>
  useMutation<RetryReview, ApiError, string | undefined>({ mutationFn: (recipientId) => announcementsApi.retryReview(id, runId, recipientId) });

/** One confirmation = one clientOperationId (made by the caller), so a repeated POST is the same retry. */
export function useRetry(id: string, runId: string) {
  const qc = useQueryClient();
  return useMutation<{ retryId: string; count: number }, ApiError, { clientOperationId: string; setHash: string; recipientId?: string }>({
    mutationFn: (input) => announcementsApi.retry(id, runId, input),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: [...key, id, 'broadcast', runId] });
      void qc.invalidateQueries({ queryKey: [...key, 'list'] });
    },
  });
}

/** Step 7: the audience scope and pilot group (only fetched when the Audience step is open). */
export const usePilot = (id: string, enabled: boolean) =>
  useQuery<PilotGroup, ApiError>({ queryKey: [...key, id, 'pilot'], queryFn: ({ signal }) => announcementsApi.pilot(id, signal), enabled });

/** Any change to scope or members makes the shown review stale, so it is checked again. */
function usePilotChange<V>(id: string, fn: (v: V) => Promise<PilotGroup>) {
  const qc = useQueryClient();
  return useMutation<PilotGroup, ApiError, V>({
    mutationFn: fn,
    onSuccess: (group) => {
      qc.setQueryData([...key, id, 'pilot'], group);
      void qc.invalidateQueries({ queryKey: [...key, id, 'audience'] });
      qc.setQueryData<Announcement>([...key, id], (d) => (d ? { ...d, audience: group.audience } : d));
    },
  });
}
export const useSetAudience = (id: string) => usePilotChange<AudienceScope>(id, (a) => announcementsApi.setAudience(id, a));
export const useAddPilot = (id: string) => usePilotChange<string>(id, (email) => announcementsApi.addPilot(id, email));
export const useRemovePilot = (id: string) => usePilotChange<string>(id, (userId) => announcementsApi.removePilot(id, userId));
