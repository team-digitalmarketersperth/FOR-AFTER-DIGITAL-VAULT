import { apiRequest } from './client';

// Mirrors the backend's SafeUser (for-after-backend/src/users/users.service.ts):
// the only user fields the API ever returns.
export type UserRole = 'CUSTOMER' | 'ADMIN' | 'SUPER_ADMIN';
export type UserStatus = 'ACTIVE' | 'SUSPENDED' | 'PASSED' | 'DELETED';

export type CurrentUser = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: UserRole;
  status: UserStatus;
  emailVerifiedAt: string | null;
  twoFactorEnabled: boolean;
  createdAt: string;
};

// POST /auth/login for ADMIN / SUPER_ADMIN (Step 16): the password only opens a
// TOTP challenge and no session exists yet. The Customer app never continues it.
export type AdminMfaChallenge = {
  mfaRequired: true;
  mfaSetupRequired: boolean;
  challengeId: string;
  expiresInSeconds: number;
};

export type LoginInput = { email: string; password: string };
export type RegisterInput = LoginInput & { firstName: string; lastName: string };

export const isAdminMfaChallenge = (
  value: CurrentUser | AdminMfaChallenge,
): value is AdminMfaChallenge => 'mfaRequired' in value && value.mfaRequired;

export const authApi = {
  /** Creates a Customer. Does not sign in: the backend creates no session. */
  register: (input: RegisterInput) =>
    apiRequest<CurrentUser>('/auth/register', { method: 'POST', body: input }),

  login: (input: LoginInput) =>
    apiRequest<CurrentUser | AdminMfaChallenge>('/auth/login', {
      method: 'POST',
      body: input,
    }),

  logout: () =>
    apiRequest<{ success: true }>('/auth/logout', { method: 'POST' }),

  me: (signal?: AbortSignal) =>
    apiRequest<CurrentUser>('/auth/me', { signal }),
};
