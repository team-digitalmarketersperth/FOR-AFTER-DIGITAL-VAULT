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
  type ChangeEmailInput,
  type ChangePasswordInput,
  type CurrentUser,
  type LoginInput,
  type ProfileInput,
  type RegisterInput,
  type ResetPasswordInput,
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

// The response is the new /auth/me, written in place: the header, account menu
// and greeting all read that one query, so they update without a refetch.
export function useUpdateProfile() {
  const queryClient = useQueryClient();
  return useMutation<CurrentUser, ApiError, ProfileInput>({
    mutationFn: authApi.updateProfile,
    onSuccess: (user) => queryClient.setQueryData(queryKeys.me, user),
  });
}

// gcTime 0, like login: the variables hold passwords. A 401 here means the
// session already ended, and the shared handler signs this browser out.
export function useChangePassword() {
  return useMutation<{ success: true }, ApiError, ChangePasswordInput>({
    mutationFn: authApi.changePassword,
    gcTime: 0,
  });
}

// Phase 04. Verifying changes emailVerifiedAt, so a signed-in /auth/me is refreshed.
export function useVerifyEmail() {
  const queryClient = useQueryClient();
  return useMutation<{ verified: true }, ApiError, string>({
    mutationFn: authApi.verifyEmail,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.me }),
  });
}

export function useResendVerification() {
  return useMutation<{ message: string }, ApiError, string>({
    mutationFn: authApi.resendVerification,
  });
}

export function useForgotPassword() {
  return useMutation<{ message: string }, ApiError, string>({
    mutationFn: authApi.forgotPassword,
  });
}

// gcTime 0: the variables hold the new password.
export function useResetPassword() {
  return useMutation<{ success: true }, ApiError, ResetPasswordInput>({
    mutationFn: authApi.resetPassword,
    gcTime: 0,
  });
}

// Phase 08. gcTime 0: the variables hold the current password.
export function useRequestEmailChange() {
  return useMutation<{ pendingEmail: string }, ApiError, ChangeEmailInput>({
    mutationFn: authApi.requestEmailChange,
    gcTime: 0,
  });
}

export function useResendEmailChange() {
  return useMutation<{ pendingEmail: string }, ApiError, void>({
    mutationFn: () => authApi.resendEmailChange(),
  });
}

export function useCancelEmailChange() {
  return useMutation<{ success: true }, ApiError, void>({
    mutationFn: () => authApi.cancelEmailChange(),
  });
}

// A confirmed change ends every session of the account, this browser's too:
// drop all private data now instead of showing the old account until a 401.
export function useConfirmEmailChange() {
  const queryClient = useQueryClient();
  return useMutation<{ changed: true }, ApiError, string>({
    mutationFn: authApi.confirmEmailChange,
    onSuccess: () => switchSession(queryClient, null),
  });
}
