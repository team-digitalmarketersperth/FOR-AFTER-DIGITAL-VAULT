'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, isApiError } from '@/lib/api/errors';
import {
  checkFile,
  mediaApi,
  RECIPIENT_PHOTO_MAX_BYTES,
  putToStorage,
  type AccessUrl,
  type MediaAsset,
  type MediaKind,
  type MediaScope,
} from '@/lib/api/media';
import { queryKeys } from '@/lib/query/query-client';

export function useMediaList(scope: MediaScope) {
  return useQuery<MediaAsset[], ApiError>({
    queryKey: queryKeys.media(scope),
    queryFn: ({ signal }) => mediaApi.list(scope, signal),
  });
}

/**
 * A short-lived signed GET URL, fetched only when a preview is actually shown.
 * Kept in memory only, and treated as stale well before the backend's expiry
 * (5 min by default) so a refetch happens instead of a broken image.
 */
export function useAccessUrl(scope: MediaScope, assetId: string, enabled = true) {
  return useQuery<AccessUrl, ApiError>({
    queryKey: queryKeys.mediaAccess(scope, assetId),
    queryFn: ({ signal }) => mediaApi.accessUrl(scope, assetId, signal),
    enabled,
    staleTime: 2 * 60_000,
    gcTime: 3 * 60_000,
    refetchOnWindowFocus: false,
  });
}

export function useRemoveMedia(scope: MediaScope) {
  const qc = useQueryClient();
  return useMutation<void, ApiError, string>({
    mutationFn: (assetId) => mediaApi.remove(scope, assetId),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.media(scope) }),
  });
}

export type UploadState =
  | { phase: 'idle' }
  | { phase: 'uploading'; fileName: string; progress: number }
  | { phase: 'confirming'; fileName: string }
  | { phase: 'failed'; fileName: string; message: string };

/**
 * upload-url → direct PUT to storage (with progress) → complete → READY.
 * Resolves with the READY asset, or null (failed or cancelled). cancel()
 * aborts the PUT and removes the half-created asset; a cancelled upload never
 * reaches "complete".
 */
export function useUpload(scope: MediaScope) {
  const qc = useQueryClient();
  const [state, setState] = useState<UploadState>({ phase: 'idle' });
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const upload = useCallback(
    async (kind: MediaKind, file: File): Promise<MediaAsset | null> => {
      const problem = checkFile(kind, file, scope.kind === 'recipients' ? RECIPIENT_PHOTO_MAX_BYTES : undefined);
      if (problem) {
        setState({ phase: 'failed', fileName: file.name, message: problem });
        return null;
      }
      const controller = new AbortController();
      abortRef.current = controller;
      setState({ phase: 'uploading', fileName: file.name, progress: 0 });
      let assetId: string | undefined;
      try {
        const target = await mediaApi.requestUpload(scope, kind, file);
        assetId = target.mediaAssetId;
        await putToStorage(target, file, {
          signal: controller.signal,
          onProgress: (progress) => setState({ phase: 'uploading', fileName: file.name, progress }),
        });
        setState({ phase: 'confirming', fileName: file.name });
        const asset = await mediaApi.complete(scope, target.mediaAssetId);
        setState({ phase: 'idle' });
        return asset;
      } catch (error) {
        if (controller.signal.aborted) {
          // Best effort: the pending asset would otherwise block scheduling.
          if (assetId) await mediaApi.remove(scope, assetId).catch(() => undefined);
          setState({ phase: 'idle' });
          return null;
        } else {
          setState({
            phase: 'failed',
            fileName: file.name,
            message: isApiError(error) ? error.message : 'The upload did not finish. Please try again.',
          });
          return null;
        }
      } finally {
        abortRef.current = null;
        void qc.invalidateQueries({ queryKey: queryKeys.media(scope) });
      }
    },
    [qc, scope],
  );

  const cancel = useCallback(() => abortRef.current?.abort(), []);
  const reset = useCallback(() => setState({ phase: 'idle' }), []);

  return { state, upload, cancel, reset };
}
