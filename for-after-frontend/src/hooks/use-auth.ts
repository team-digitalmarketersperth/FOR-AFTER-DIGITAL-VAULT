'use client';

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import {
  authApi,
  isAdminMfaChallenge,
  type CurrentUser,
  type LoginInput,
  type RegisterInput,
} from '@/lib/api/auth';
import { ApiError, isApiError } from '@/lib/api/errors';
import { queryKeys, resetPrivateCache } from '@/lib/query/query-client';

// There is no client-side auth state: GET /auth/me is the only source of truth.
// A 401 resolves to null ("signed out") rather than an error, so it is never
// retried and components can tell "signed out" apart from "couldn't check".
async function fetchCurrentUser(signal?: AbortSignal) {
  try {
    return await authApi.me(signal);
  } catch (error) {
    if (isApiError(error) && error.kind === 'unauthenticated') return null;
    throw error;
  }
}

export function useCurrentUser() {
  return useQuery<CurrentUser | null>({
    queryKey: queryKeys.me,
    queryFn: ({ signal }) => fetchCurrentUser(signal),
  });
}

// The person using this browser changed (login or logout).
const switchSession = (queryClient: QueryClient, user: CurrentUser | null) =>
  resetPrivateCache(queryClient, user);

export type LoginResult =
  | { kind: 'customer'; user: CurrentUser }
  | { kind: 'admin_mfa_required' };

async function login(queryClient: QueryClient, input: LoginInput): Promise<LoginResult> {
  const result = await authApi.login(input);
  // Admins get a TOTP challenge and no session; the Customer app stops here.
  if (isAdminMfaChallenge(result)) return { kind: 'admin_mfa_required' };

  // A 200 from /login is not proof of a session (e.g. the browser refused the
  // cookie): only /auth/me is.
  const user = await fetchCurrentUser();
  if (!user) {
    throw new ApiError(
      'unauthenticated',
      401,
      "We couldn't start your session. Please check that cookies are allowed for this site and try again.",
    );
  }
  await switchSession(queryClient, user);
  return { kind: 'customer', user };
}

// gcTime 0: a finished login/register mutation (which holds the password in its
// variables) is dropped as soon as its form unmounts.
export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation<LoginResult, ApiError, LoginInput>({
    mutationKey: ['login'],
    mutationFn: (input) => login(queryClient, input),
    gcTime: 0,
  });
}

export function useRegister() {
  return useMutation<CurrentUser, ApiError, RegisterInput>({
    mutationFn: authApi.register,
    gcTime: 0,
  });
}

export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation<unknown, ApiError, void>({
    // The backend destroys the Redis session and clears the HttpOnly cookie.
    mutationFn: () => authApi.logout(),
    onSuccess: () => switchSession(queryClient, null),
  });
}
