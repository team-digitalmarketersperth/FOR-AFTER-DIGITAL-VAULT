import { z } from 'zod';

// Friendly early feedback only. The backend DTOs (for-after-backend/src/auth/dto)
// stay authoritative; these mirror just their obvious limits.

const email = z
  .string()
  .trim()
  .min(1, 'Enter your email address.')
  .max(254, 'Email address is too long.')
  .pipe(z.email('Enter a valid email address.'));

export const loginSchema = z.object({
  email,
  password: z
    .string()
    .min(1, 'Enter your password.')
    .max(128, 'Password must be 128 characters or fewer.'),
});

// RegisterDto: password 12–128 characters, no composition rules (NIST 800-63B).
export const PASSWORD_MIN = 12;
export const PASSWORD_HINT = `At least ${PASSWORD_MIN} characters. A short phrase works well.`;

const name = (label: string) =>
  z
    .string()
    .trim()
    .min(1, `Enter your ${label}.`)
    .max(100, `${label[0].toUpperCase()}${label.slice(1)} must be 100 characters or fewer.`);

const newPassword = z
  .string()
  .min(PASSWORD_MIN, `Password must be at least ${PASSWORD_MIN} characters.`)
  .max(128, 'Password must be 128 characters or fewer.');

export const registerSchema = z.object({
  firstName: name('first name'),
  lastName: name('last name'),
  email,
  password: newPassword,
});

// UpdateProfileDto: name only, trimmed, 1–100 characters.
export const profileSchema = z.object({
  firstName: name('first name'),
  lastName: name('last name'),
});

// ChangePasswordDto: the same new-password rule as registration. The
// confirmation never leaves the browser.
export const changePasswordSchema = z
  .object({
    currentPassword: z
      .string()
      .min(1, 'Enter your current password.')
      .max(128, 'Password must be 128 characters or fewer.'),
    newPassword,
    confirmNewPassword: z.string().min(1, 'Enter your new password again.'),
  })
  .refine((v) => v.newPassword === v.confirmNewPassword, {
    path: ['confirmNewPassword'],
    message: "The new passwords don't match.",
  })
  .refine((v) => !v.currentPassword || v.newPassword !== v.currentPassword, {
    path: ['newPassword'],
    message: 'Choose a password that is different from your current one.',
  });

// forgot-password and resend-verification.
export const emailOnlySchema = z.object({ email });

// ResetPasswordDto: the same new-password rule as registration.
export const resetPasswordSchema = z
  .object({
    newPassword,
    confirmNewPassword: z.string().min(1, 'Enter your new password again.'),
  })
  .refine((v) => v.newPassword === v.confirmNewPassword, {
    path: ['confirmNewPassword'],
    message: "The passwords don't match.",
  });

// ChangeEmailDto: the new address (same rule as registration) and the current
// password, checked by the API. "Same as now" is the API's call (it normalizes).
export const changeEmailSchema = z.object({
  newEmail: email,
  currentPassword: z
    .string()
    .min(1, 'Enter your current password.')
    .max(128, 'Password must be 128 characters or fewer.'),
});

export type LoginValues = z.infer<typeof loginSchema>;
export type ChangeEmailValues = z.infer<typeof changeEmailSchema>;
export type EmailOnlyValues = z.infer<typeof emailOnlySchema>;
export type ResetPasswordValues = z.infer<typeof resetPasswordSchema>;
export type RegisterValues = z.infer<typeof registerSchema>;
export type ProfileValues = z.infer<typeof profileSchema>;
export type ChangePasswordValues = z.infer<typeof changePasswordSchema>;
