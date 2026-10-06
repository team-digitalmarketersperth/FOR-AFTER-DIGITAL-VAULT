import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import type { PromptArea } from '@/lib/api/prompts';
import type { MediaScope } from '@/lib/api/media';
import type { MemoryCategory } from '@/lib/api/memory-vault';
import type { AuditFilters, CaseFilters, UserFilters } from '@/lib/api/admin';
import { isApiError } from '@/lib/api/errors';

/**
 * Query keys. Everything private is under one of these roots, and
 * resetPrivateCache() removes all of them on login, logout and session expiry,
 * so nothing from one person survives into another's session on a shared
 * browser. Lists are the root key, details add the id, so invalidating a root
 * refreshes both.
 */
export const queryKeys = {
  me: ['auth', 'me'] as const,
  recipients: ['recipients'] as const,
  recipientPages: ['recipients', 'page'] as const,
  recipientPage: (page: number) => ['recipients', 'page', page] as const,
  recipient: (id: string) => ['recipients', id] as const,
  trustedContacts: ['trusted-contacts'] as const,
  trustedContact: (id: string) => ['trusted-contacts', id] as const,
  messages: ['messages'] as const,
  message: (id: string) => ['messages', id] as const,
  schedule: (messageId: string) => ['messages', messageId, 'schedule'] as const,
  memories: ['memory-vault'] as const,
  memoryList: (category?: MemoryCategory) => ['memory-vault', 'list', category ?? 'ALL'] as const,
  memory: (id: string) => ['memory-vault', id] as const,
  // Nested under the owner, so owner invalidation covers its media too.
  // 'recipient/messages' → ['recipient', 'messages', …]: portal media stays in the portal namespace.
  media: (scope: MediaScope) => [...scope.kind.split('/'), scope.id, 'media'],
  mediaAccess: (scope: MediaScope, assetId: string) => [...scope.kind.split('/'), scope.id, 'media', assetId, 'access'],
  prompts: (area: PromptArea) => [area] as const,
  prompt: (area: PromptArea, key: string) => [area, key] as const,
  // The signed-in Customer's own death-verification case (Step 15 safety UI).
  deathVerification: ['death-verification', 'me'] as const,
};

/**
 * Recipient and Trusted Contact portals: separate principals with their own
 * sessions, so their data lives under their own root and a 401 there ends only
 * that portal's session, never the Customer's (and vice versa).
 */
export type Portal = 'recipient' | 'trusted-contact';
export const portalKeys = {
  me: (portal: Portal) => [portal, 'me'] as const,
  releasedMessages: ['recipient', 'messages'] as const,
  releasedMessage: (id: string) => ['recipient', 'messages', id] as const,
  accounts: ['trusted-contact', 'accounts'] as const,
  caseStatus: (trustedContactId: string) =>
    ['trusted-contact', 'accounts', trustedContactId, 'death-verification'] as const,
};
const isPortal = (value: unknown): value is Portal => value === 'recipient' || value === 'trusted-contact';

/** Forgets one portal's data; its /me becomes null so its gate returns to sign-in. */
export async function resetPortalCache(client: QueryClient, portal: Portal, me: unknown = null) {
  const meKey = portalKeys.me(portal);
  await client.cancelQueries({ queryKey: meKey });
  client.removeQueries({ queryKey: [portal], predicate: ({ queryKey }) => queryKey[1] !== 'me' });
  client.setQueryData(meKey, me);
}

/**
 * Admin portal. Everything lives under ['admin', …]; key[1] === 'sign-in' holds
 * the in-memory MFA challenge and the "session expired" flag, never fetched.
 */
export const adminKeys = {
  me: ['admin', 'me'] as const,
  challenge: ['admin', 'sign-in', 'challenge'] as const,
  expired: ['admin', 'sign-in', 'expired'] as const,
  dashboard: ['admin', 'dashboard'] as const,
  users: ['admin', 'users'] as const,
  userList: (f: UserFilters) => ['admin', 'users', 'list', f] as const,
  user: (id: string) => ['admin', 'users', id] as const,
  cases: ['admin', 'death-verifications'] as const,
  caseList: (f: CaseFilters) => ['admin', 'death-verifications', 'list', f] as const,
  case: (id: string) => ['admin', 'death-verifications', id] as const,
  auditLogs: ['admin', 'audit-logs'] as const,
  auditList: (f: AuditFilters) => ['admin', 'audit-logs', 'list', f] as const,
  auditLog: (id: string) => ['admin', 'audit-logs', id] as const,
  queues: ['admin', 'queues'] as const,
  failedJobs: (queue: string, page: number) => ['admin', 'queues', queue, 'failed', page] as const,
};

const isMe = (key: readonly unknown[]) => key[0] === 'auth' && key[1] === 'me';
const isAdminMe = (key: readonly unknown[]) => key[0] === 'admin' && key[1] === 'me';

/**
 * Admins have their own session cookie (for_after_admin_session), so an admin
 * sign-in, sign-out or expiry only touches ['admin', …]. The Customer, Recipient
 * and Trusted Contact sessions in the same browser are separate and stay.
 */
export function dropAdminData(client: QueryClient) {
  client.removeQueries({ queryKey: ['admin'], predicate: ({ queryKey }) => !isAdminMe(queryKey) });
}

export async function resetAdminCache(client: QueryClient, me: unknown = null) {
  await client.cancelQueries({ queryKey: adminKeys.me });
  dropAdminData(client);
  client.setQueryData(adminKeys.me, me);
}

/** Server ended the admin session (idle timeout, suspension, …): sign-in explains why. */
export async function endAdminSession(client: QueryClient) {
  await resetAdminCache(client, null);
  client.setQueryData(adminKeys.expired, true);
}

/**
 * The Customer changed (login, logout, expiry): drops every private query except
 * the separate admin session's; auth/me is written in place so gates react.
 */
export async function resetPrivateCache(client: QueryClient, user: unknown) {
  await client.cancelQueries({ queryKey: queryKeys.me });
  client.removeQueries({ predicate: ({ queryKey }) => !isMe(queryKey) && queryKey[0] !== 'admin' });
  client.setQueryData(queryKeys.me, user);
}

// Retrying cannot fix these: the answer will be the same (or, for 429, retrying
// is exactly what the rate limit asks us not to do).
const NO_RETRY_STATUSES = new Set([400, 401, 403, 404, 409, 429]);

export function makeQueryClient() {
  // A 401 from a data call means that principal's session ended (expired,
  // logged out in another tab, account suspended or no longer eligible): forget
  // its data and let its gate return to its own sign-in. Sign-in calls are
  // exempt: their 401 is a wrong password or code, left to the form.
  const onError = (error: unknown, key: readonly unknown[] | undefined) => {
    if (!isApiError(error) || error.kind !== 'unauthenticated') return;
    if (key?.[0] === 'login' || key?.[1] === 'sign-in') return;
    if (key?.[0] === 'admin') void endAdminSession(client);
    else if (isPortal(key?.[0])) void resetPortalCache(client, key[0]);
    else void resetPrivateCache(client, null);
  };
  const client: QueryClient = new QueryClient({
    queryCache: new QueryCache({ onError: (error, query) => onError(error, query.queryKey) }),
    mutationCache: new MutationCache({
      onError: (error, _vars, _ctx, mutation) => onError(error, mutation.options.mutationKey),
    }),
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: true,
        retry: (failureCount, error) =>
          !(isApiError(error) && error.status && NO_RETRY_STATUSES.has(error.status)) &&
          failureCount < 2,
      },
      // Every write runs exactly once per click.
      mutations: { retry: false },
    },
  });
  return client;
}
