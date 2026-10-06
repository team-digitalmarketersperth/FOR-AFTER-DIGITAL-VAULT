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
// Step 22: the only editable profile fields. Email is read-only (no verified change flow yet).
export type ProfileInput = { firstName: string; lastName: string };
export type ChangePasswordInput = { currentPassword: string; newPassword: string };
export type ResetPasswordInput = { token: string; newPassword: string };
export type ChangeEmailInput = { newEmail: string; currentPassword: string };

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

  /** PATCH /users/me: returns the same user as /auth/me. Customer only. */
  updateProfile: (input: ProfileInput) =>
    apiRequest<CurrentUser>('/users/me', { method: 'PATCH', body: input }),

  /**
   * Re-authenticates with the current password. This browser stays signed in
   * (new session id); the Customer's other sessions end. A wrong current
   * password is a 400, so it never signs this browser out.
   */
  changePassword: (input: ChangePasswordInput) =>
    apiRequest<{ success: true }>('/auth/change-password', { method: 'POST', body: input }),

  // Phase 04. The token comes from the emailed link; a bad one is a 400.
  verifyEmail: (token: string) =>
    apiRequest<{ verified: true }>('/auth/verify-email', { method: 'POST', body: { token } }),

  /** 202 with the same message for any email: it never says whether an account exists. */
  resendVerification: (email: string) =>
    apiRequest<{ message: string }>('/auth/resend-verification', { method: 'POST', body: { email } }),

  /** 202 with the same message for any email. */
  forgotPassword: (email: string) =>
    apiRequest<{ message: string }>('/auth/forgot-password', { method: 'POST', body: { email } }),

  /**
   * Phase 08, Customer only. Re-authenticates, then emails a link to the NEW
   * address; the account's email changes only when that link is used. Answers
   * with the pending address, masked. Wrong password 400, address in use 409.
   */
  requestEmailChange: (input: ChangeEmailInput) =>
    apiRequest<{ pendingEmail: string }>('/auth/change-email', { method: 'POST', body: input }),

  resendEmailChange: () =>
    apiRequest<{ pendingEmail: string }>('/auth/change-email/resend', { method: 'POST' }),

  cancelEmailChange: () =>
    apiRequest<{ success: true }>('/auth/change-email/cancel', { method: 'POST' }),

  /** From the emailed link, signed in or not. Every session of the account ends. */
  confirmEmailChange: (token: string) =>
    apiRequest<{ changed: true }>('/auth/change-email/confirm', { method: 'POST', body: { token } }),

  /** Ends every session of the account; signs nobody in. */
  resetPassword: (input: ResetPasswordInput) =>
    apiRequest<{ success: true }>('/auth/reset-password', { method: 'POST', body: input }),
};
